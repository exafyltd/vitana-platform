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
 *     life_compass: {
 *       active_goal_text, pillar_focus, set_at,
 *       target_date, target_value, target_unit,        // goal-centric North Star
 *       has_deadline, days_to_deadline, goal_total_days, goal_day, goal_progress_pct,
 *     } | null,
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
import { fetchVitanaIndexForProfiler, fetchLifeCompass, LifeCompassSnapshot } from '../services/user-context-profiler';
import { getJourneyState } from '../services/journey/user-journey-service';

const router = Router();

const VTID = 'VTID-03152';

const MS_PER_DAY = 86_400_000;

/** UTC-midnight epoch for the calendar date of an ISO date/datetime string. */
function utcMidnight(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Whole CALENDAR days between two ISO date/datetime strings (b - a). Both are
 * normalized to UTC midnight first, so a noon "now" against a midnight deadline
 * date yields a stable calendar-day count (no time-of-day off-by-one). Can be
 * negative (deadline already passed). Null when either input is missing/unparseable.
 */
function daysBetween(aIso: string | null | undefined, bIso: string | null | undefined): number | null {
  if (!aIso || !bIso) return null;
  const a = utcMidnight(aIso);
  const b = utcMidnight(bIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Goal-centric block for the My Journey North Star. Progress is time-based
 * (days elapsed since the goal was set vs. days until its deadline) so it is
 * always computable from dates alone — no quantified measurements required.
 * All goal-target fields fall back to null when the goal has no deadline yet.
 */
export function buildGoalBlock(lc: LifeCompassSnapshot, now: Date = new Date()) {
  const nowIso = now.toISOString();
  const hasDeadline = !!lc.target_date;

  const daysToDeadline = hasDeadline
    ? Math.max(0, daysBetween(nowIso, lc.target_date) ?? 0)
    : null;
  const goalTotalDays = hasDeadline
    ? Math.max(0, daysBetween(lc.set_at, lc.target_date) ?? 0)
    : null;
  const goalDay = hasDeadline
    ? Math.max(0, daysBetween(lc.set_at, nowIso) ?? 0)
    : null;
  const goalProgressPct =
    goalTotalDays && goalTotalDays > 0 && goalDay !== null
      ? Math.min(100, Math.round((goalDay / goalTotalDays) * 100))
      : null;

  return {
    active_goal_text: lc.primary_goal,
    pillar_focus: lc.category,
    confidence_score: lc.confidence_score ?? null,
    target_date: lc.target_date ?? null,
    target_value: lc.target_value ?? null,
    target_unit: lc.target_unit ?? null,
    set_at: lc.set_at ?? null,
    has_deadline: hasDeadline,
    days_to_deadline: daysToDeadline,
    goal_total_days: goalTotalDays,
    goal_day: goalDay,
    goal_progress_pct: goalProgressPct,
  };
}

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
    // Run journey/index/life-compass in parallel; all are independent. Each
    // falls back to null on its own error so one failing source never blanks
    // the others — the My Journey North Star reads life_compass even when the
    // journey lookup is unavailable.
    const [journey, indexSnapshot, lifeCompass] = await Promise.all([
      getJourneyState(client, userId).catch(() => null),
      fetchVitanaIndexForProfiler(client, userId).catch(() => null),
      fetchLifeCompass(client, userId).catch(() => null),
    ]);

    const phase =
      journey && journey.current_wave
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
      journey: journey
        ? {
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
          }
        : null,
      life_compass: lifeCompass ? buildGoalBlock(lifeCompass) : null,
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
