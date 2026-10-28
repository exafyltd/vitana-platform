/**
 * VTID-NAV-02: Admin Navigator API — telemetry.
 *
 * Mounted at /api/v1/admin/navigator, gated on exafy_admin. The React admin
 * UI in vitana-v1 (/admin/navigator/telemetry) is the only consumer.
 *
 *   GET /telemetry — 7/30/90-day aggregates of orb.navigator.* OASIS events
 *
 * VTID-04846: the catalog CRUD, simulator, coverage, spa-routes and reload
 * endpoints edited or read the nav_catalog table, which the voice navigator
 * no longer uses (its screens come from the screen registry). They are gone,
 * with their admin pages (vitana-v1 VTID-04853).
 */

import { Router, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import * as repo from './admin-navigator-repository';

const router = Router();
const VTID = 'VTID-NAV-02';

// Accepts both Platform and Lovable JWTs (dual-JWT requireAdminAuth):
// valid signature, not expired, app_metadata.exafy_admin === true.
router.use(requireAdminAuth);

type Pick = { screen_id?: string; score?: number };

export interface NavigatorTelemetry {
  event_count: number;
  by_type: Record<string, number>;
  top_screens: Array<{ screen_id: string; count: number }>;
  failed_utterances: Array<{ utterance: string; confidence: string; top_picks?: Pick[] }>;
  near_misses: Array<{ utterance: string; picked: Pick; runner_up: Pick; delta: number }>;
}

/**
 * Aggregate navigator events. Reads both shapes in the window: the registry
 * navigator's (`resolver: 'registry-v2'`: `kind`, `candidates`, scores 0..1)
 * and the legacy consult's (`confidence`, `top_picks`, scores 0..100), so a
 * window spanning the switch stays readable.
 */
export function aggregateNavigatorTelemetry(events: Array<{ type: string; payload?: unknown }>): NavigatorTelemetry {
  const byType: Record<string, number> = {};
  const byScreen: Record<string, number> = {};
  const failed: NavigatorTelemetry['failed_utterances'] = [];
  const nearMisses: NavigatorTelemetry['near_misses'] = [];

  for (const ev of events) {
    byType[ev.type] = (byType[ev.type] || 0) + 1;
    const p = (ev.payload || {}) as Record<string, any>;
    const registry = p.resolver === 'registry-v2';
    const picks: Pick[] = registry
      ? (Array.isArray(p.candidates) ? p.candidates : [])
      : (p.top_picks || (p.primary ? [p.primary] : []));
    const counted: Pick[] = registry && ev.type === 'orb.navigator.requested' && p.screen_id ? [{ screen_id: p.screen_id }] : picks;
    if (!registry || ev.type === 'orb.navigator.requested') {
      for (const pick of counted) if (pick?.screen_id) byScreen[pick.screen_id] = (byScreen[pick.screen_id] || 0) + 1;
    }
    const utterance = String(p.question || '');
    if (registry && ev.type === 'orb.navigator.resolved') {
      if ((p.kind === 'none' || p.kind === 'unavailable') && utterance) failed.push({ utterance, confidence: p.kind, top_picks: picks });
      if (p.kind === 'ambiguous' && picks.length >= 2 && picks[0].score != null && picks[1].score != null) {
        nearMisses.push({ utterance, picked: picks[0], runner_up: picks[1], delta: Math.round((picks[0].score - picks[1].score) * 1000) / 1000 });
      }
    } else if (!registry) {
      if (p.confidence === 'low' && utterance) failed.push({ utterance, confidence: p.confidence, top_picks: picks });
      const [a, b] = picks;
      if (a?.score != null && b?.score != null) {
        const delta = a.score - b.score;
        if (delta >= 0 && delta <= 4) nearMisses.push({ utterance, picked: a, runner_up: b, delta });
      }
    }
  }

  return {
    event_count: events.length,
    by_type: byType,
    top_screens: Object.entries(byScreen)
      .map(([screen_id, count]) => ({ screen_id, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
    failed_utterances: failed.slice(0, 50),
    near_misses: nearMisses.slice(0, 50),
  };
}

// ── GET /telemetry ──────────────────────────────────────────────────────────

router.get('/telemetry', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const days = Math.min(parseInt((req.query.days as string) || '30', 10) || 30, 90);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const { data: events, error } = await repo.fetchNavigatorTelemetryEvents(supabase, since, 5000);
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, days, ...aggregateNavigatorTelemetry((events as any[]) || []) });
  } catch (err: any) {
    console.error(`[${VTID}] GET /telemetry:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
