/**
 * VTID-03152 — Slice B: GET /api/v1/my-journey.
 *
 * Unified payload for the My Journey screen and the conversational
 * decision-contract spine. One call returns everything the Slice C
 * one-time welcome, the Slice D daily morning greeting, and the
 * forthcoming Slice F screen need:
 *
 *   {
 *     day_in_journey, total_days, days_left, plan_type, plan_summary,
 *     status, is_first_session, last_session_date,
 *     current_phase: { id, name, day_range, day_in_phase, days_to_next_milestone },
 *     life_compass: { active_goal_text, pillar_focus, set_at } | null,
 *     vitana_index: { today, tier, trend_7d } | null,
 *   }
 *
 * Never breaks: every sub-fetch falls back to null on error so the
 * payload is best-effort. The screen and the greeting renderer both
 * handle missing fields gracefully (greeting falls back to phase-based
 * purpose when life_compass.active_goal_text is null).
 */

import { Router, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { fetchVitanaIndexForProfiler, fetchLifeCompass } from '../services/user-context-profiler';
import { getJourneyState } from '../services/journey/user-journey-service';

const router = Router();

const VTID = 'VTID-03152';

function getServiceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * GET /api/v1/my-journey
 *
 * Auth: requires user JWT. Returns the unified journey payload for the
 * authenticated user.
 */
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }

  const client = getServiceClient();
  if (!client) {
    return res.status(503).json({ ok: false, error: 'supabase_unavailable', vtid: VTID });
  }

  try {
    // Run journey/index/life-compass in parallel; all are independent.
    const [journey, indexSnapshot, lifeCompass] = await Promise.all([
      getJourneyState(client, userId),
      fetchVitanaIndexForProfiler(client, userId).catch(() => null),
      fetchLifeCompass(client, userId).catch(() => null),
    ]);

    if (!journey) {
      // Service couldn't fetch and couldn't fall back. Return a shape
      // the frontend can render with sensible "no journey yet" copy.
      return res.status(200).json({
        ok: true,
        vtid: VTID,
        journey: null,
        life_compass: null,
        vitana_index: null,
      });
    }

    const phase = journey.current_wave
      ? {
          id: journey.current_wave.id,
          name: journey.current_wave.name,
          description: journey.current_wave.description,
          day_range: [journey.current_wave.start_day, journey.current_wave.end_day] as [number, number],
          day_in_phase: Math.max(0, journey.day_in_journey - journey.current_wave.start_day),
          days_to_next_milestone: Math.max(0, journey.current_wave.end_day - journey.day_in_journey),
        }
      : null;

    return res.status(200).json({
      ok: true,
      vtid: VTID,
      journey: {
        day_in_journey: journey.day_in_journey,
        total_days: journey.total_days,
        days_left: journey.days_left,
        plan_type: journey.plan_type,
        plan_summary: journey.plan_summary,
        status: journey.status,
        is_first_session: journey.is_first_session,
        last_session_date: journey.last_session_date,
        is_past_total_days: journey.is_past_total_days,
        current_phase: phase,
        fallback_used: journey.fallback_used,
      },
      life_compass: lifeCompass
        ? {
            active_goal_text: lifeCompass.primary_goal,
            pillar_focus: lifeCompass.category,
            confidence_score: lifeCompass.confidence_score ?? null,
          }
        : null,
      vitana_index: indexSnapshot
        ? {
            today: indexSnapshot.total,
            tier: indexSnapshot.tier,
            tier_framing: indexSnapshot.tier_framing,
            trend_7d: indexSnapshot.trend_7d,
            weakest_pillar: indexSnapshot.weakest_pillar,
            balance_label: indexSnapshot.balance_label,
          }
        : null,
    });
  } catch (err: any) {
    console.error('[VTID-03152] GET /my-journey unexpected:', err.message);
    return res.status(500).json({ ok: false, error: err.message, vtid: VTID });
  }
});

export default router;
