/**
 * VTID-LIVEKIT-TOOLS: Vitana Index endpoints for the LiveKit orb-agent.
 *
 * The Vertex pipeline implements `get_vitana_index` /
 * `get_index_improvement_suggestions` inline in orb-live.ts (case blocks).
 * The LiveKit agent calls them via HTTP because its tool catalogue is built
 * from `services/agents/orb-agent/src/orb_agent/tools.py` which dispatches
 * every call through `GatewayClient`. This file lifts the same business
 * logic into a stable HTTP route so the LiveKit agent reaches behaviour
 * parity with Vertex without duplicating the underlying helpers.
 *
 * Both endpoints accept the per-session user JWT minted by
 * `/api/v1/orb/livekit/token` (see VTID-02709).
 */

import { Router, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { fetchVitanaIndexForProfiler } from '../services/user-context-profiler';
import { resolvePillarKey } from '../lib/vitana-pillars';

const router = Router();

const VTID = 'VTID-LIVEKIT-TOOLS';

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * GET /api/v1/vitana-index
 *
 * Returns the user's current Vitana Index snapshot — total score, tier,
 * 5-pillar breakdown, weakest/strongest pillar, sub-scores, balance factor,
 * 7-day trend, and aspirational distance. Mirrors the `get_vitana_index`
 * tool body at orb-live.ts:5631.
 */
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }

  const client = getServiceClient();
  if (!client) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }

  try {
    const snap = await fetchVitanaIndexForProfiler(client, userId);
    if (!snap) {
      return res.json({
        ok: true,
        text: "I don't see a Vitana Index score yet — it looks like the baseline survey hasn't been completed. Want me to point you to the health screen so you can start?",
        snapshot: null,
        vtid: VTID,
      });
    }
    return res.json({
      ok: true,
      snapshot: {
        total: snap.total,
        tier: snap.tier,
        tier_framing: snap.tier_framing,
        pillars: snap.pillars,
        weakest_pillar: snap.weakest_pillar,
        strongest_pillar: snap.strongest_pillar,
        balance_factor: snap.balance_factor,
        balance_label: snap.balance_label,
        balance_hint: snap.balance_hint,
        subscores: snap.subscores,
        trend_7d: snap.trend_7d,
        goal_target: snap.goal_target,
        points_to_really_good: snap.points_to_really_good,
        last_computed: snap.last_computed,
        model_version: snap.model_version,
        confidence: snap.confidence,
        last_movement: snap.last_movement,
      },
      vtid: VTID,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[vitana-index] get error:', msg);
    return res.status(500).json({ ok: false, error: msg, vtid: VTID });
  }
});

/**
 * GET /api/v1/vitana-index/suggestions?pillar=<key>&limit=<n>
 *
 * Returns 1..N pending autopilot recommendations whose `contribution_vector`
 * lifts the requested pillar (or the weakest pillar when `pillar` is
 * omitted). Mirrors `get_index_improvement_suggestions` at orb-live.ts:5674.
 */
router.get('/suggestions', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }

  const client = getServiceClient();
  if (!client) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }

  const limitRaw = parseInt(String(req.query.limit ?? '3'), 10);
  const limit = Math.max(1, Math.min(10, Number.isFinite(limitRaw) ? limitRaw : 3));

  let pillar: string | undefined = resolvePillarKey(String(req.query.pillar ?? ''));
  if (!pillar) {
    try {
      const snap = await fetchVitanaIndexForProfiler(client, userId);
      pillar = snap?.weakest_pillar?.name;
    } catch {
      // fall through — handled below
    }
  }
  if (!pillar) {
    return res.json({
      ok: true,
      text: "I don't see Index data for this user yet, so I can't pick a target pillar. Complete the 5-question baseline survey first.",
      pillar: null,
      suggestions: [],
      vtid: VTID,
    });
  }

  try {
    const { data, error } = await client
      .from('autopilot_recommendations')
      .select('id, title, summary, contribution_vector, impact_score, status')
      .eq('user_id', userId)
      .in('status', ['pending', 'new', 'snoozed'])
      .not('contribution_vector', 'is', null)
      .order('impact_score', { ascending: false, nullsFirst: false })
      .limit(50);

    if (error) {
      return res
        .status(500)
        .json({ ok: false, error: `Could not fetch recommendations: ${error.message}`, vtid: VTID });
    }

    const ranked = (data || [])
      .map((r: { id: string; title: string; summary: string; contribution_vector: Record<string, number> | null; impact_score: number | null; status: string }) => {
        const cv = r.contribution_vector;
        const lift = cv && typeof cv[pillar!] === 'number' ? cv[pillar!] : 0;
        return { ...r, _lift: lift };
      })
      .filter((r) => r._lift > 0)
      .sort((a, b) => b._lift - a._lift)
      .slice(0, limit);

    if (ranked.length === 0) {
      return res.json({
        ok: true,
        pillar,
        suggestions: [],
        text: `No pending recommendations with a positive ${pillar} contribution right now. Completing ANY existing recommendation will trigger the Index engine to propose more.`,
        vtid: VTID,
      });
    }

    return res.json({
      ok: true,
      pillar,
      suggestions: ranked.map((r) => ({
        id: r.id,
        title: r.title,
        action: r.summary,
        lift: r._lift,
        contribution_vector: r.contribution_vector,
      })),
      vtid: VTID,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[vitana-index] suggestions error:', msg);
    return res.status(500).json({ ok: false, error: msg, vtid: VTID });
  }
});

export default router;
