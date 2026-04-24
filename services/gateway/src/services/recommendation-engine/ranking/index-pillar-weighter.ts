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

export interface RankInputRec {
  id?: string;
  source_ref?: string | null;
  impact_score?: number | null;
  contribution_vector?: Record<string, number> | null;
  domain?: string | null;
  status?: string | null;
}

export interface RankedRec<T extends RankInputRec = RankInputRec> {
  rec: T;
  rank_score: number;
  pillar_boost: number;
  compass_boost: number;
  journey_mode: number;
  explanation: string;
}

export interface RankerContext {
  pillars: Record<PillarKey, number> | null;
  balance_factor: number | null;
  weakest_pillar: PillarKey | null;
  active_goal_category: string | null;
  days_since_start: number | null;      // calendar days since first Index row
  has_baseline: boolean;
  has_recent_completions: boolean;       // ≥ 1 completion in last 14 days
}

export interface RankerConfig {
  alpha_pillar: number;   // default 0.5
  alpha_wave: number;     // default 0.3
  compass_boost: number;  // default 1.3
  pillar_quota_max: number;   // default 0.40 → at most 40% from one pillar
  weakest_quota_max: number;  // default 0.60 when balance_factor ≤ 0.7
}

export const DEFAULT_RANKER_CONFIG: RankerConfig = {
  alpha_pillar: 0.5,
  alpha_wave: 0.3,
  compass_boost: 1.3,
  pillar_quota_max: 0.40,
  weakest_quota_max: 0.60,
};

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
  // Latest Index row + feature_inputs + first-ever row for day-count
  const [latestIdx, firstIdx, goal, recentCompletions, baselineSurvey] = await Promise.all([
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

  return { pillars, balance_factor, weakest_pillar, active_goal_category, days_since_start, has_baseline, has_recent_completions };
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

  // Journey mode — decays over 90 days, gated on data coverage.
  const journey_mode = computeJourneyMode(ctx);

  // Final: base × (1 + alpha_pillar × pillarBoost × (1 − journey_mode)) × compass_boost
  // (wave_match requires template registry metadata we don't have here; alpha_wave applies
  //  at a higher-level enrichment step — left at 0 contribution here so this weighter is
  //  a pure pillar+compass+journey function and a later wave-match pass can stack on top.)
  const rank_score = base * (1 + cfg.alpha_pillar * pillar_boost * (1 - journey_mode)) * compass_boost;

  return {
    rec,
    rank_score,
    pillar_boost,
    compass_boost,
    journey_mode,
    explanation: `base=${base.toFixed(1)} × (1 + ${cfg.alpha_pillar}·pillarBoost=${pillar_boost.toFixed(2)}·(1−jm=${journey_mode.toFixed(2)})) × compass=${compass_boost.toFixed(2)} = ${rank_score.toFixed(2)}`,
  };
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

  const primaryPillar = (rec: T): PillarKey | null => {
    if (!rec.contribution_vector) return null;
    let best: { p: PillarKey; v: number } | null = null;
    for (const p of PILLAR_KEYS) {
      const v = Number((rec.contribution_vector as any)[p] ?? 0);
      if (v > 0 && (!best || v > best.v)) best = { p, v };
    }
    return best?.p ?? null;
  };

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
