/**
 * VTID-05143 (builds VTID-05085 Phase 1) — Unified Card System enrichment cards.
 *
 * Mounted at /api/v1/enrichment-cards (src/index.ts). requireAuth on both routes;
 * every read and write is scoped to the caller's own user_id (the gateway uses
 * service_role and never takes a user id from the request).
 *
 * GET  /?screen=<screen>[&locale=<code>]
 *   200 { ok, screen, locale, cards: [{ card_type, category, priority, completed,
 *         dismissed_until, title, description }], profile_completion_pct }
 *   The caller's incomplete, non-cooled-down enrichment cards for that screen,
 *   in static priority order, with localized title/description
 *   (data/enrichment-card-tips.ts). 400 on an unknown screen.
 *
 * POST /dismiss  { card_type }
 *   200 { ok, card_type, dismissed_until } — upserts the caller's dismissal
 *   (dismissed_at = updated_at = now). 400 on an unknown card_type.
 *
 * Any database error answers 500 JSON and is logged; never an empty list.
 * No LLM, no spoken text, no other member's data.
 */

import { Router, Request, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { getUserLocale } from '../i18n/server-locale';
import { GATEWAY_LOCALES, type GatewayLocale } from '../i18n/catalog';
import { enrichmentCardText } from '../data/enrichment-card-tips';
import {
  CARD_SCREENS,
  ENRICHMENT_CARD_TYPES,
  dismissedUntil,
  eligibleEnrichmentCards,
  enrichmentCompletionPct,
  isCardScreen,
  isEnrichmentCardType,
} from '../services/enrichment/card-catalog';
import { loadEnrichmentCardState } from '../services/enrichment/completion-resolver';
import { upsertEnrichmentCardDismissal } from '../services/enrichment/completion-resolver-repository';

const router = Router();
const LOG = '[ENRICHMENT-CARDS]';

/** An explicit `?locale=` (the live UI language) wins over the stored locale — same as user-category-preferences.ts. */
function requestedLocale(req: Request): GatewayLocale | null {
  const raw = String(req.query.locale ?? '').slice(0, 5).toLowerCase().split('-')[0];
  return (GATEWAY_LOCALES as readonly string[]).includes(raw) ? (raw as GatewayLocale) : null;
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity?.user_id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const screen = req.query.screen;
  if (!isCardScreen(screen)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SCREEN', screens: CARD_SCREENS });
  }

  const sb = getSupabase();
  if (!sb) {
    console.error(`${LOG} GET: Supabase is not configured`);
    return res.status(500).json({ ok: false, error: 'DB_UNAVAILABLE' });
  }

  try {
    const forced = requestedLocale(req);
    const [state, locale] = await Promise.all([
      loadEnrichmentCardState(sb, identity.user_id),
      forced ? Promise.resolve(forced) : getUserLocale(sb, identity.user_id),
    ]);
    const cards = eligibleEnrichmentCards(state.completions, state.dismissals, screen, new Date()).map((c) => ({
      ...c,
      completed: false,
      dismissed_until: null,
      ...enrichmentCardText(c.card_type, locale),
    }));
    return res.json({
      ok: true,
      screen,
      locale,
      cards,
      profile_completion_pct: enrichmentCompletionPct(state.completions),
    });
  } catch (err: any) {
    console.error(`${LOG} GET screen=${screen} failed:`, err?.message || err);
    return res.status(500).json({ ok: false, error: 'ENRICHMENT_STATE_UNAVAILABLE' });
  }
});

router.post('/dismiss', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity?.user_id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const cardType = (req.body as { card_type?: unknown } | undefined)?.card_type;
  if (!isEnrichmentCardType(cardType)) {
    return res.status(400).json({ ok: false, error: 'INVALID_CARD_TYPE', card_types: ENRICHMENT_CARD_TYPES });
  }

  const sb = getSupabase();
  if (!sb) {
    console.error(`${LOG} POST /dismiss: Supabase is not configured`);
    return res.status(500).json({ ok: false, error: 'DB_UNAVAILABLE' });
  }

  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await upsertEnrichmentCardDismissal(sb, identity.user_id, cardType, nowIso);
    if (error) {
      console.error(`${LOG} POST /dismiss ${cardType} failed:`, error.message);
      return res.status(500).json({ ok: false, error: 'DISMISS_FAILED' });
    }
    const row = (data as { dismissed_at?: string | null; cooldown_days?: number | null } | null) ?? {};
    const until = dismissedUntil({
      dismissed_at: row.dismissed_at ?? nowIso,
      cooldown_days: row.cooldown_days ?? null,
    });
    return res.json({ ok: true, card_type: cardType, dismissed_until: until ? until.toISOString() : null });
  } catch (err: any) {
    console.error(`${LOG} POST /dismiss ${cardType} failed:`, err?.message || err);
    return res.status(500).json({ ok: false, error: 'DISMISS_FAILED' });
  }
});

export default router;
