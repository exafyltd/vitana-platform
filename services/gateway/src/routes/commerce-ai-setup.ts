/**
 * VTID-04838 — "Set up with AI" endpoints for the Commerce Portal.
 *
 *   POST /api/v1/commerce/ai-setup/draft  { website }            → { draft }   (reads, writes nothing)
 *   POST /api/v1/commerce/ai-setup/apply  { setup_key, org_id?, website, business, products }
 *                                                                   → creates the business + draft products
 *
 * `apply` is only ever called by the supplier's own tap on "Create my
 * business" in the review card (owner decision 2026-10-02): voice drafts, the
 * screen commits. It is idempotent per setup_key, so a double tap or a retry
 * never creates a second business or duplicate products.
 *
 * Off unless COMMERCE_AI_SETUP_ENABLED=true (404 AI_SETUP_DISABLED).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { getUserLocale } from '../i18n/server-locale';
import { getCallerId } from './partner-orgs';
import { normalizeSetupKey } from '../services/partner-setup';
import {
  BUSINESS_CATEGORIES,
  applySetupDraft,
  draftFromWebsite,
  isCommerceAiSetupEnabled,
  normalizeWebsiteUrl,
} from '../services/commerce-ai-setup';

const router = Router();

/** Drafting reads a site and calls the model: bounded per member. */
const DRAFT_LIMIT_PER_HOUR = 10;
const draftWindows = new Map<string, number[]>();

export function allowDraft(userId: string, now: number = Date.now()): boolean {
  const hourAgo = now - 60 * 60 * 1000;
  const recent = (draftWindows.get(userId) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= DRAFT_LIMIT_PER_HOUR) {
    draftWindows.set(userId, recent);
    return false;
  }
  recent.push(now);
  draftWindows.set(userId, recent);
  return true;
}

/** Test hook. */
export function resetDraftLimits(): void {
  draftWindows.clear();
}

function enabled(res: Response): boolean {
  if (isCommerceAiSetupEnabled()) return true;
  res.status(404).json({ ok: false, error: 'AI_SETUP_DISABLED' });
  return false;
}

router.post('/draft', requireAuth, async (req: Request, res: Response) => {
  if (!enabled(res)) return;
  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  if (!normalizeWebsiteUrl(req.body?.website)) return res.status(400).json({ ok: false, error: 'invalid_url' });
  if (!allowDraft(callerId)) return res.status(429).json({ ok: false, error: 'RATE_LIMITED' });

  const s = getSupabase();
  const lang = s ? await getUserLocale(s, callerId).catch(() => null) : null;
  const result = await draftFromWebsite(req.body.website, lang);
  if (!result.ok) {
    const status = result.error === 'invalid_url' ? 400 : result.error === 'site_unreachable' ? 422 : 502;
    return res.status(status).json({ ok: false, error: result.error });
  }
  return res.json({ ok: true, draft: result.draft });
});

const ApplySchema = z.object({
  setup_key: z.string(),
  org_id: z.string().uuid().nullable().optional(),
  website: z.string().url(),
  business: z.object({
    display_name: z.string().trim().min(1).max(120),
    category: z.enum(BUSINESS_CATEGORIES),
    country: z.string().regex(/^[A-Za-z]{2}$/).transform((c) => c.toUpperCase()),
  }),
  products: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(512),
        description: z.string().max(10000).nullable().optional(),
        price_cents: z.number().int().min(0),
        currency: z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()),
        url: z.string().url().nullable().optional(),
        image: z.string().url().nullable().optional(),
        kind: z.enum(['product', 'service']).optional(),
      }),
    )
    .max(50),
});

router.post('/apply', requireAuth, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: applySetupDraft() emits commerce.ai_setup.applied
  // (and registering emits partner_org.registered) on a real change only.
  if (!enabled(res)) return;
  const s = getSupabase();
  if (!s) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const parsed = ApplySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid_draft', details: parsed.error.flatten() });
  const setupKey = normalizeSetupKey(parsed.data.setup_key);
  if (!setupKey) return res.status(400).json({ ok: false, error: 'invalid_setup_key' });

  const result = await applySetupDraft(s, callerId, { ...parsed.data, setup_key: setupKey });
  if (!result.ok) return res.status(result.status).json(result.body);
  return res.status(result.created_org ? 201 : 200).json(result);
});

export default router;
