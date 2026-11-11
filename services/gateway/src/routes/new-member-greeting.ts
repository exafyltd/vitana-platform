/**
 * VTID-05207 — "Say Hello 👋" greeting SUGGESTION endpoint.
 *
 * Plan `.kiro/specs/new-member-welcome/plan-sparring.md` Part B, task C1.
 *
 *   POST /api/v1/community/new-member/:userId/greeting-suggestion
 *     Body: { avoid?: string[] }  — greetings already offered this session.
 *     Returns: { ok, suggestion, language }
 *
 * Authenticated member only, per-viewer rate limited. The suggestion is
 * composed by Bedrock in the SENDER's locale (getUserLocale) via the
 * composer pattern; the newcomer is addressed by first name only. This
 * endpoint only SUGGESTS — it never sends a DM (owner decision D2 = b: the
 * greeting is a private DM delivered only on the member's explicit Send
 * through POST /api/v1/chat/send). `:userId` is the newcomer whose card the
 * member is greeting from.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { getUserLocale } from '../i18n/server-locale';
import { composeGreetingSuggestion } from '../services/new-member-greeting-suggestion';
import * as repo from './new-member-greeting-repository';
import {
  fetchNewMemberProfile,
  receiverIsGreetableNewcomer,
  GREETING_REFUSED_STATUS,
  greetingRefusedBody,
} from '../services/new-member-greeting-guard';
import { fetchExcludedTestServiceAccountIdsStrict } from '../lib/excluded-test-service-accounts';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AVOID = 20;
const AVOID_ITEM_MAX = 200;

// Per-viewer rate limit for suggestion generation (an LLM call each). In
// memory, per gateway task — enough to stop a stuck client or "Try another"
// spam, not a distributed quota. Window + cap are env-tunable.
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const RATE_WINDOW_MS = positiveInt(process.env.NEW_MEMBER_GREETING_SUGGESTION_RATE_WINDOW_MS, 60_000);
const RATE_MAX = positiveInt(process.env.NEW_MEMBER_GREETING_SUGGESTION_RATE_MAX, 15);
const viewerHits = new Map<string, number[]>();

/** True when the viewer is under the per-window cap; records this hit. */
export function allowViewerHit(
  viewerId: string,
  now = Date.now(),
  windowMs = RATE_WINDOW_MS,
  max = RATE_MAX,
  store: Map<string, number[]> = viewerHits,
): boolean {
  const since = now - windowMs;
  const hits = (store.get(viewerId) ?? []).filter((t) => t >= since);
  if (hits.length >= max) {
    store.set(viewerId, hits);
    return false;
  }
  hits.push(now);
  store.set(viewerId, hits);
  return true;
}

function sanitizeAvoid(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, AVOID_ITEM_MAX);
    if (s) out.push(s);
    if (out.length >= MAX_AVOID) break;
  }
  return out;
}

router.post(
  '/community/new-member/:userId/greeting-suggestion',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response) => {
    const { identity } = req as AuthenticatedRequest;
    if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { userId } = req.params;
    if (!UUID_RE.test(userId)) return res.status(400).json({ ok: false, error: 'invalid_user_id' });
    if (userId === identity.user_id) return res.status(400).json({ ok: false, error: 'cannot_greet_self' });

    if (!allowViewerHit(identity.user_id)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_unavailable' });

    // Privacy: only a greetable newcomer (opted in, joined within 7 days) may be
    // looked up, and never a test/service account. Checked BEFORE any name is
    // resolved or the LLM is called. One generic refusal; the reason stays in
    // the server log. A failed lookup refuses (fail closed).
    const refuse = (reason: string) => {
      console.warn(`[NewMemberGreeting] suggestion refused (${reason}) viewer=${identity.user_id}`);
      return res.status(GREETING_REFUSED_STATUS).json(greetingRefusedBody());
    };
    try {
      const excluded = await fetchExcludedTestServiceAccountIdsStrict(supabase);
      if (!excluded.ok) return refuse('allowlist_lookup_failed');
      if (excluded.ids.has(identity.user_id) || excluded.ids.has(userId)) return refuse('test_account');
      const profile = await fetchNewMemberProfile(supabase, userId);
      if (!receiverIsGreetableNewcomer(profile, new Date())) return refuse('not_greetable_newcomer');
    } catch (err) {
      return refuse(`lookup_error:${err instanceof Error ? err.message : 'unknown'}`);
    }

    const avoid = sanitizeAvoid((req.body as { avoid?: unknown } | undefined)?.avoid);

    // The SENDER's locale governs the suggestion language; the newcomer is
    // addressed by first name only.
    const [senderLocale, firstName] = await Promise.all([
      getUserLocale(supabase, identity.user_id),
      repo.resolveFirstName(supabase, userId).catch(() => null),
    ]);

    const result = await composeGreetingSuggestion({ firstName, senderLocale, avoid });
    if (!result.ok) {
      console.warn(`[NewMemberGreeting] suggestion failed (${result.error}) viewer=${identity.user_id}`);
      return res.status(503).json({ ok: false, error: 'suggestion_unavailable' });
    }
    return res.json({ ok: true, suggestion: result.suggestion, language: result.language });
  },
);

export default router;
