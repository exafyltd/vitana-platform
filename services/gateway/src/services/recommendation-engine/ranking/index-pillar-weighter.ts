/**
 * Index-weighted re-ranker (G4 + G6).
 *
 * Converts each candidate Autopilot recommendation's base impact_score
 * into a user-specific rank_score by folding in:
 *   1. **Pillar gap** — how much each candidate lifts the user's weakest
 *      pillar (reads `contribution_vector` vs live `vitana_index_scores`).
 *   2. **Balance factor** — when the user is unbalanced (balance_factor ≤ 0.9),
 *      the weakest-pillar weight is multiplied by `1.2` so the queue actively
 *      surfaces the gap.
 *   3. **Compass alignment** — when the user has an active Life Compass goal
 *      and the candidate's `source_ref` is in the goal's preferred set,
 *      multiplies by a compass boost (default 1.3).
 *   4. **Journey mode** — the 90-day onramp decay. Early days the wave match
 *      dominates; after Day 30 the Index signal takes over. Pinned to 1.0
 *      when the user has no baseline survey or zero recent completions
 *      (data-coverage override).
 *   5. **Per-pillar quota + balance guard (G6)** — capping at 40% per pillar,
 *      flipping the weakest pillar's cap to 60% when unbalanced.
 *
 * The same weighter is called from three surfaces:
 *   - /api/v1/autopilot/recommendations (GET + /generate)
 *   - ORB `get_index_improvement_suggestions` tool executor
 *   - Morning brief generator (G9)
 *
 * So voice, Autopilot popup, and daily brief always produce the same top pick
 * from the same user state. Single source of truth.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { PILLAR_KEYS, PILLAR_TAGS, describeBalance, type PillarKey } from '../../../lib/vitana-pillars';

export type EconomicAxis =
  | 'find_match'
  | 'marketplace'
  | 'income_generation'
  | 'business_formation'
  | 'none';

/**
 * Goal categories that are "economic" for the purposes of the economic_boost
 * gate. Sourced from services/gateway/src/types/life-stage-awareness.ts:44.
 * Keeping this tight is the contract: social_relationships / community_contribution
 * are NOT in the set, so Find-a-Match recs paired with a social goal are
 * handled by the existing compass_boost machinery, not the new economy axis.
 * See docs/GOVERNANCE/ULTIMATE-GOAL.md for the orthogonal-axes rationale.
 */
const ECONOMIC_GOAL_CATEGORIES = new Set<string>(['career_purpose', 'financial_security']);

export interface RankInputRec {
  id?: string;
  source_ref?: string | null;
  impact_score?: number | null;
  contribution_vector?: Record<string, number> | null;
  domain?: string | null;
  status?: string | null;
  economic_axis?: EconomicAxis | string | null;
}

export interface RankedRec<T extends RankInputRec = RankInputRec> {
  rec: T;
  rank_score: number;
  pillar_boost: number;
  compass_boost: number;
  economic_boost: number;
  journey_mode: number;
  explanation: string;
}

export interface PillarRecentActivity {
  last_completed_at: string | null;
  completions_24h: number;
  completions_7d: number;
  plan_events_24h: number;
}

export interface RankerContext {
  pillars: Record<PillarKey, number> | null;
  balance_factor: number | null;
  weakest_pillar: PillarKey | null;
  active_goal_category: string | null;
  days_since_start: number | null;      // calendar days since first Index row
  has_baseline: boolean;
  has_recent_completions: boolean;       // ≥ 1 completion in last 14 days
  // G7: per-pillar recent activity. Missing pillar → treated as zero so
  // dampening is a no-op.
  recent_activity: Partial<Record<PillarKey, PillarRecentActivity>>;
  // G7: per-domain 30-day dismissal rate for rejection-suppression.
  rejection_rate_by_domain: Record<string, number>;
}

export interface RankerConfig {
  alpha_pillar: number;   // default 0.5
  alpha_wave: number;     // default 0.3
  compass_boost: number;  // default 1.3
  economic_boost: number; // default 1.15 — multiplier when rec.economic_axis is set AND user has an economic compass goal
  pillar_quota_max: number;   // default 0.40 → at most 40% from one pillar
  weakest_quota_max: number;  // default 0.60 when balance_factor ≤ 0.7
  // G7: feedback-loop multipliers
  completion_dampener: number;    // 0.3 — recent completion halves rec
  plan_dampener: number;          // 0.3 — voice just planned this pillar
  rejection_dampener_alpha: number; // 0.5 — impact × (1 - alpha × dismiss_rate)
  streak_reinforcement: number;    // 1.3 — when streak ≥ 3 days
  community_momentum_boost: number; // 1.2 — when ≥ 3 community completions/7d
}

export const DEFAULT_RANKER_CONFIG: RankerConfig = {
  alpha_pillar: 0.5,
  alpha_wave: 0.3,
  compass_boost: 1.3,
  economic_boost: 1.15,
  pillar_quota_max: 0.40,
  weakest_quota_max: 0.60,
  completion_dampener: 0.3,
  plan_dampener: 0.3,
  rejection_dampener_alpha: 0.5,
  streak_reinforcement: 1.3,
  community_momentum_boost: 1.2,
};

/**
 * Returns true iff the user has an active Life Compass goal in an economic
 * category. Gates the economic_boost multiplier so it only fires for users
 * who have signalled income/business focus — preventing it from blanket-
 * boosting economy-tagged recs and crowding out health pillars.
 */
export function hasEconomicGoal(ctx: Pick<RankerContext, 'active_goal_category'>): boolean {
  return !!ctx.active_goal_category && ECONOMIC_GOAL_CATEGORIES.has(ctx.active_goal_category);
}

// ─────────────────────────────────────────────────────────────────────────
// Category → preferred template set (mirrors life-compass-analyzer). A rec
// whose source_ref is in this set gets the compass_boost multiplier.
// ─────────────────────────────────────────────────────────────────────────
const CATEGORY_PREFERRED_SOURCE_REFS: Record<string, readonly string[]> = {
  community:   ['engage_matches', 'engage_meetup', 'onboarding_matches', 'onboarding_discover_matches', 'onboarding_group', 'mentor_newcomer', 'try_live_room', 'create_live_room'],
  connection:  ['deepen_connection', 'engage_matches', 'invite_friend', 'onboarding_maxina'],
  longevity:   ['start_streak', 'engage_health', 'weakness_movement', 'weakness_sleep', 'weakness_nutrition', 'weakness_mental', 'weakness_hydration'],
  health:      ['start_streak', 'engage_health', 'weakness_movement', 'weakness_sleep', 'weakness_nutrition', 'weakness_mental', 'weakness_hydration'],
  skills:      ['share_expertise', 'try_live_room', 'create_live_room', 'mentor_newcomer'],
  spiritual:   ['onboarding_diary', 'onboarding_diary_day0', 'weakness_stress', 'weakness_mental'],
  career:      ['onboarding_diary', 'share_expertise', 'weakness_stress'],
  finance:     ['onboarding_diary', 'set_goal'],
};

/**
 * Build the ranker context for a user from a single round of DB reads.
 * Callers should cache this per request. Used by all three surfaces.
 */
export async function buildRankerContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<RankerContext> {
  // Latest Index row + first-ever row for day-count + Life Compass +
  // 14d completion flag + baseline-exists flag + G7 recent-activity view +
  // G7 rejection-rate-by-domain.
  const [latestIdx, firstIdx, goal, recentCompletions, baselineSurvey, activity, rejections] = await Promise.all([
    supabase
      .from('vitana_index_scores')
      .select('score_nutrition, score_hydration, score_exercise, score_sleep, score_mental, feature_inputs, date')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('vitana_index_scores')
      .select('date')
      .eq('user_id', userId)
      .order('date', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('life_compass')
      .select('category')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('calendar_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('completion_status', 'completed')
      .gte('completed_at', new Date(Date.now() - 14 * 86400000).toISOString()),
    supabase
      .from('vitana_index_baseline_survey')
      .select('user_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle(),
    // G7: user_pillar_recent_activity view — 5 rows/user (one per pillar
    // the user has activity on). Pillars with zero activity are absent.
    supabase
      .from('user_pillar_recent_activity')
      .select('pillar, last_completed_at, completions_24h, completions_7d, plan_events_24h')
      .eq('user_id', userId),
    // G7: 30-day rejection rate per domain. Count rejected vs total for
    // each domain and compute ratio in-ranker.
    supabase
      .from('autopilot_recommendations')
      .select('domain, status')
      .eq('user_id', userId)
      .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()),
  ]);

  let pillars: Record<PillarKey, number> | null = null;
  let balance_factor: number | null = null;
  let weakest_pillar: PillarKey | null = null;

  const latestRow = latestIdx.data as any;
  if (latestRow) {
    pillars = {
      nutrition: Number(latestRow.score_nutrition) || 0,
      hydration: Number(latestRow.score_hydration) || 0,
      exercise:  Number(latestRow.score_exercise)  || 0,
      sleep:     Number(latestRow.score_sleep)     || 0,
      mental:    Number(latestRow.score_mental)    || 0,
    };
    const fi = (latestRow.feature_inputs as any) || {};
    balance_factor = typeof fi.balance_factor === 'number' ? fi.balance_factor : null;
    const min = PILLAR_KEYS.reduce((acc, p) => (pillars![p] < pillars![acc] ? p : acc), PILLAR_KEYS[0]);
    weakest_pillar = min;
  }

  const days_since_start = firstIdx.data?.date
    ? Math.max(0, Math.floor((Date.now() - Date.parse(firstIdx.data.date as string)) / 86400000))
    : null;

  const active_goal_category = (goal.data as any)?.category?.toLowerCase() ?? null;
  const has_recent_completions = (recentCompletions.count ?? 0) > 0;
  const has_baseline = !!(baselineSurvey.data);

  // G7: build recent_activity map from view rows (missing pillars → absent).
  const recent_activity: Partial<Record<PillarKey, PillarRecentActivity>> = {};
  for (const row of (activity.data ?? []) as any[]) {
    const p = row.pillar as PillarKey;
    if (!PILLAR_KEYS.includes(p)) continue;
    recent_activity[p] = {
      last_completed_at: row.last_completed_at ?? null,
      completions_24h: Number(row.completions_24h) || 0,
      completions_7d: Number(row.completions_7d) || 0,
      plan_events_24h: Number(row.plan_events_24h) || 0,
    };
  }

  // G7: compute per-domain rejection rate from last-30-day recs.
  const domainTotals: Record<string, { total: number; rejected: number }> = {};
  for (const row of (rejections.data ?? []) as { domain: string | null; status: string | null }[]) {
    const d = row.domain || 'unknown';
    if (!domainTotals[d]) domainTotals[d] = { total: 0, rejected: 0 };
    domainTotals[d].total += 1;
    if (row.status === 'rejected') domainTotals[d].rejected += 1;
  }
  const rejection_rate_by_domain: Record<string, number> = {};
  for (const [d, t] of Object.entries(domainTotals)) {
    rejection_rate_by_domain[d] = t.total > 0 ? t.rejected / t.total : 0;
  }

  return {
    pillars, balance_factor, weakest_pillar, active_goal_category,
    days_since_start, has_baseline, has_recent_completions,
    recent_activity, rejection_rate_by_domain,
  };
}

/**
 * Compute `journey_mode` ∈ [0, 1]. 1.0 = wave-template-led onramp; 0.2 =
 * Index-led ongoing practice. Data-coverage gate pins at 1.0 until the user
 * has taken the baseline AND completed at least one action in 14 days.
 */
export function computeJourneyMode(ctx: RankerContext): number {
  // Data-coverage gate: no baseline OR no recent completions → onramp.
  if (!ctx.has_baseline || !ctx.has_recent_completions) return 1.0;

  const d = ctx.days_since_start;
  if (d === null) return 1.0;

  let mode: number;
  if (d <= 7)          mode = 1.0;
  else if (d <= 30)    mode = 1.0 - ((d - 7) / 23) * 0.5;     // 1.0 → 0.5
  else if (d <= 90)    mode = 0.5 - ((d - 30) / 60) * 0.3;    // 0.5 → 0.2
  else                 mode = 0.2;

  // Compass override: goal-directed users ramp faster (−0.1, clamped).
  if (ctx.active_goal_category) mode = Math.max(0.1, mode - 0.1);
  return mode;
}

/**
 * Compute rank_score for a single rec given a ranker context.
 */
export function scoreRec<T extends RankInputRec>(
  rec: T,
  ctx: RankerContext,
  cfg: RankerConfig = DEFAULT_RANKER_CONFIG,
): RankedRec<T> {
  const base = Number(rec.impact_score ?? 5);

  // Pillar boost — how much the rec lifts the user's weakest pillars.
  let pillar_boost = 0;
  if (ctx.pillars && rec.contribution_vector) {
    let boostSum = 0;
    let maxSum = 0;
    for (const p of PILLAR_KEYS) {
      const cv = Number((rec.contribution_vector as any)[p] ?? 0);
      const gap = Math.max(0, Math.min(1, (200 - ctx.pillars[p]) / 200));
      let weight = 1.0;
      // G6 balance guard: when unbalanced, amplify contribution to the weakest pillar.
      if (ctx.balance_factor !== null && ctx.balance_factor <= 0.9 && p === ctx.weakest_pillar) {
        weight = 1.2;
      }
      boostSum += cv * gap * weight;
      maxSum += cv;
    }
    pillar_boost = maxSum > 0 ? Math.min(1, boostSum / maxSum) : 0;
  }

  // Compass boost — sourceRef matches the active goal's preferred set?
  let compass_boost = 1.0;
  if (ctx.active_goal_category && rec.source_ref) {
    const preferred = CATEGORY_PREFERRED_SOURCE_REFS[ctx.active_goal_category];
    if (preferred && preferred.includes(rec.source_ref)) {
      compass_boost = cfg.compass_boost;
    }
  }

  // Economic boost — applies when the rec advances the longevity economy axis
  // AND the user has signalled an economic Life Compass goal. Gated so the
  // boost cannot fire blanket-wide and crowd out the 5 health pillars (per the
  // contract: 5 pillars stay clinically clean; the economy axis is orthogonal).
  let economic_boost = 1.0;
  if (
    rec.economic_axis &&
    rec.economic_axis !== 'none' &&
    hasEconomicGoal(ctx)
  ) {
    economic_boost = cfg.economic_boost;
  }

  // Journey mode — decays over 90 days, gated on data coverage.
  const journey_mode = computeJourneyMode(ctx);

  // G7 — feedback-loop multipliers.
  // 1. Completion dampener: if the primary pillar of this rec has a recent
  //    completion (< 24h) OR voice just planned an event on it, knock the
  //    score down to 0.3× so the Autopilot surfaces a balance-complementing
  //    rec instead of doubling up.
  // 2. Streak reinforcement: if the user has a 7d streak-class signal on this
  //    pillar AND the rec is a reinforcement (start_streak / completions > 0),
  //    multiply by 1.3×.
  // 3. Community-momentum boost: if the user has completed ≥ 3 community
  //    actions in last 7 days AND the rec's primary pillar is Mental via
  //    community tags, multiply by 1.2×.
  // 4. Rejection suppression: impact × (1 − alpha × dismissal_rate_for_domain).
  const primary = primaryPillar(rec);
  let feedback_mult = 1.0;
  let feedback_reason = '';
  if (primary && ctx.recent_activity[primary]) {
    const act = ctx.recent_activity[primary]!;
    if (act.completions_24h > 0) {
      feedback_mult *= cfg.completion_dampener;
      feedback_reason += ' completion_dampened';
    } else if (act.plan_events_24h > 0) {
      feedback_mult *= cfg.plan_dampener;
      feedback_reason += ' voice_plan_dampened';
    }
    if (act.completions_7d >= 3 && primary === 'mental') {
      feedback_mult *= cfg.community_momentum_boost;
      feedback_reason += ' community_momentum';
    }
    // Streak reinforcement — rec that encourages continuing the streak
    if (act.completions_7d >= 3 && rec.source_ref === 'start_streak') {
      feedback_mult *= cfg.streak_reinforcement;
      feedback_reason += ' streak_reinforcement';
    }
  }
  // Rejection suppression by domain
  if (rec.domain) {
    const rate = ctx.rejection_rate_by_domain[rec.domain] ?? 0;
    if (rate > 0) {
      feedback_mult *= Math.max(0.2, 1 - cfg.rejection_dampener_alpha * rate);
      feedback_reason += ` rej_rate_${rate.toFixed(2)}`;
    }
  }

  // Final: base × (1 + alpha_pillar × pillarBoost × (1 − journey_mode)) × compass_boost × economic_boost × feedback_mult
  const rank_score = base * (1 + cfg.alpha_pillar * pillar_boost * (1 - journey_mode)) * compass_boost * economic_boost * feedback_mult;

  return {
    rec,
    rank_score,
    pillar_boost,
    compass_boost,
    economic_boost,
    journey_mode,
    explanation: `base=${base.toFixed(1)} × (1 + ${cfg.alpha_pillar}·pillarBoost=${pillar_boost.toFixed(2)}·(1−jm=${journey_mode.toFixed(2)})) × compass=${compass_boost.toFixed(2)} × econ=${economic_boost.toFixed(2)} × fb=${feedback_mult.toFixed(2)}${feedback_reason} = ${rank_score.toFixed(2)}`,
  };
}

/** Shared helper — pick the primary pillar a rec targets by finding the
 *  pillar key with the highest non-zero contribution_vector value. */
function primaryPillar(rec: RankInputRec): PillarKey | null {
  if (!rec.contribution_vector) return null;
  let best: { p: PillarKey; v: number } | null = null;
  for (const p of PILLAR_KEYS) {
    const v = Number((rec.contribution_vector as any)[p] ?? 0);
    if (v > 0 && (!best || v > best.v)) best = { p, v };
  }
  return best?.p ?? null;
}

/**
 * Score a batch, apply per-pillar quota (G6), and return ordered ranked recs.
 */
export function rankBatch<T extends RankInputRec>(
  recs: T[],
  ctx: RankerContext,
  cfg: RankerConfig = DEFAULT_RANKER_CONFIG,
): RankedRec<T>[] {
  const scored = recs.map(r => scoreRec(r, ctx, cfg));
  // Sort by rank_score desc, preserve tie-break stability.
  scored.sort((a, b) => b.rank_score - a.rank_score);

  // Per-pillar quota (G6): cap any single pillar at 40% of the returned list,
  // unless balance_factor ≤ 0.7 AND the pillar is the weakest, in which case
  // flip the cap to 60%.
  const total = scored.length;
  if (total <= 2) return scored;

  const pillarQuota = Math.max(1, Math.floor(total * cfg.pillar_quota_max));
  const weakestQuota = Math.max(1, Math.floor(total * cfg.weakest_quota_max));
  const unbalanced = ctx.balance_factor !== null && ctx.balance_factor <= 0.7 && ctx.weakest_pillar !== null;

  const counts: Record<PillarKey, number> = { nutrition: 0, hydration: 0, exercise: 0, sleep: 0, mental: 0 };
  const kept: RankedRec<T>[] = [];
  const overflow: RankedRec<T>[] = [];

  for (const item of scored) {
    const p = primaryPillar(item.rec);
    if (!p) { kept.push(item); continue; }
    const quota = unbalanced && p === ctx.weakest_pillar ? weakestQuota : pillarQuota;
    if (counts[p] < quota) {
      kept.push(item);
      counts[p]++;
    } else {
      overflow.push(item);
    }
  }

  // Append overflow AFTER the quota-respecting block so they're not dropped.
  return [...kept, ...overflow];
}

/** Re-export pillar tag constants for callers that need to reason about tags. */
export { PILLAR_TAGS, describeBalance };
