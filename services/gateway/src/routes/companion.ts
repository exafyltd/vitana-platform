/**
 * VTID-05099 / VTID-05100 — Vitana Companion Messages.
 *
 *   GET   /api/v1/companion/status       → { ok, mode, reason, env }   (public, read-only)
 *   GET   /api/v1/companion/preferences  → { ok, preferences }         (member, own row)
 *   PATCH /api/v1/companion/preferences  → { ok, preferences }         (member, own row)
 *   POST  /api/v1/companion/test-card    → { ok, chat_message_id, moment_key, card_type, text }
 *                                          (exafy admin; sends one companion card to the CALLER, VTID-05588)
 *
 * Test card (VTID-05588): the recipient is always the verified caller (the
 * body never names a user), staging answers 409 (shared database), a mode that
 * does not send answers 409, one per admin per minute (429). No ledger row,
 * pacer touch or push — see services/companion/test-card.ts.
 *
 * Status reports only which mode the engine is in here — no member data, no
 * counts. Public and read-only on purpose: the staging verification suite
 * (read-only by rule 48) checks it with a plain GET.
 *
 * Preferences (VTID-05100, plan §B): the signed-in member's own
 * companion_preferences row, read and written with the service-role client
 * keyed by the VERIFIED user id from the token — the body never names a user.
 * No row = the defaults (enabled; health + community on; business off, D2).
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { resolveCompanionConfig, isSendMode } from '../services/companion/config';
import * as companionRepo from '../services/companion/companion-repository';
import { sendCompanionTestCard } from '../services/companion/test-card';
import { requireAuth, requireExafyAdmin, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { VITANA_ENV } from '../env';

const router = Router();

// Public on purpose: mode only, no member data — the read-only staging suite (rule 48) checks it without a sign-in.
router.get('/status', (_req: Request, res: Response) => { // public-route
  const config = resolveCompanionConfig();
  res.json({ ok: true, mode: config.mode, reason: config.reason, env: VITANA_ENV });
});

export const PreferencesPatchSchema = z
  .object({
    enabled: z.boolean(),
    topic_health: z.boolean(),
    topic_community: z.boolean(),
    topic_business: z.boolean(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'no fields to update' });

router.get('/preferences', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'storage_unavailable' });
  try {
    const preferences = await companionRepo.getMemberPreferences(sb, identity.user_id);
    return res.json({ ok: true, preferences });
  } catch (err: any) {
    console.error('[companion] preferences read failed:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'preferences_unavailable' });
  }
});

router.patch('/preferences', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const parsed = PreferencesPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'invalid_preferences', details: parsed.error.issues.map((i) => i.message) });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'storage_unavailable' });
  try {
    const preferences = await companionRepo.saveMemberPreferences(sb, identity.user_id, identity.tenant_id, parsed.data);
    await emitOasisEvent({
      vtid: 'VTID-05100', type: 'companion.preferences.updated', source: 'companion-messages', status: 'success',
      message: 'member changed their Vitana companion message settings',
      payload: { user_id: identity.user_id, changed: Object.keys(parsed.data), preferences },
      actor_id: identity.user_id, actor_role: 'user', surface: 'api',
    }).catch(() => undefined);
    return res.json({ ok: true, preferences });
  } catch (err: any) {
    console.error('[companion] preferences save failed:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'preferences_save_failed' });
  }
});

// ── VTID-05588: an exafy admin sends one companion card to themselves ───────
export const TestCardBodySchema = z
  .object({ moment_key: z.enum(['vitana_index']).optional() })
  .strict();

/** One test card per admin per minute (in-process; the route is admin-only). */
export const TEST_CARD_RATE_LIMIT_MS = 60_000;
const lastTestCardAt = new Map<string, number>();
/** Test seam: forget the per-admin rate-limit timestamps. */
export function __resetTestCardRateLimit(): void { lastTestCardAt.clear(); }

router.post('/test-card', requireAuth, requireExafyAdmin, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const parsed = TestCardBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'VALIDATION', details: parsed.error.issues.map((i) => i.message) });
  }
  const config = resolveCompanionConfig();
  if (config.mode === 'disabled-on-staging') {
    return res.status(409).json({ ok: false, error: 'STAGING_DISABLED', mode: config.mode });
  }
  if (!isSendMode(config.mode)) {
    return res.status(409).json({ ok: false, error: 'SEND_NOT_AVAILABLE', mode: config.mode });
  }
  const now = Date.now();
  const last = lastTestCardAt.get(identity.user_id);
  if (last !== undefined && now - last < TEST_CARD_RATE_LIMIT_MS) {
    const retry_after_s = Math.ceil((TEST_CARD_RATE_LIMIT_MS - (now - last)) / 1000);
    return res.status(429).json({ ok: false, error: 'RATE_LIMITED', retry_after_s });
  }
  // Service role: the row's sender is the Vitana bot, not the caller (lib/supabase.ts).
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'storage_unavailable' });
  lastTestCardAt.set(identity.user_id, now);
  try {
    const result = await sendCompanionTestCard(
      { sb, config },
      { userId: identity.user_id, tokenTenantId: identity.tenant_id ?? null, momentKey: parsed.data.moment_key ?? 'vitana_index' },
    );
    if (!result.ok) {
      // Nothing was written: the admin may try again at once.
      lastTestCardAt.delete(identity.user_id);
      return res.status(result.status).json({ ok: false, error: result.error, ...(result.mode ? { mode: result.mode } : {}) });
    }
    return res.json(result);
  } catch (err: any) {
    lastTestCardAt.delete(identity.user_id);
    console.error('[companion] test card failed:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'test_card_failed' });
  }
});

export default router;
