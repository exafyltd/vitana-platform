// Phase C.3 (decision-contract refactor) — VTID-03132.
//
// PillarWeighterStrategy — the vertical proof for Phase C. Reads the 21
// ranker policy keys via PolicyResolver, builds a RankerConfig matching
// the byte-identical defaults, calls the existing scoreRec/rankBatch,
// and emits a RankProvenance trail naming each major scoring component.
//
// Scope-bounded per the brief:
//   - Ships ONE strategy (this one) reading externalized weights.
//   - Algorithm-swap (runtime formula interpretation) is deferred to a
//     Phase C follow-up.
//   - Provenance is "major component" granularity (base, pillar_boost,
//     compass_boost, economic_boost, journey_mode, feedback_mult).
//     Per-feedback-path expansion (which dampener fired specifically)
//     is a C.3.b follow-up.
//
// Discipline:
//   - Every literal that previously lived inline in scoreRec /
//     computeJourneyMode / rankBatch reaches this strategy via
//     `getValue<number>(POLICY_KEYS.RANKER_PILLAR_*, { defaultValue })`.
//   - Defaults match `DEFAULT_RANKER_CONFIG` so the cache-cold path is
//     byte-identical to today's behaviour.

import {
  scoreRec,
  rankBatch,
  DEFAULT_RANKER_CONFIG,
  type FeedbackBreakdown,
  type RankerConfig,
  type RankerContext,
  type RankInputRec,
  type RankedRec,
} from '../../recommendation-engine/ranking/index-pillar-weighter';
import { POLICY_KEYS } from '../policy-keys';
import { getPolicyResolver, type PolicyResolver } from '../policy-resolver';
import type {
  RankProvenance,
  RankProvenanceComponent,
} from '../strategy';

export const PILLAR_WEIGHTER_STRATEGY_ID = 'pillar_weighter_v1';
// Phase C.3.b (VTID-03141): bumped from 1 → 2. feedback_mult composite
// component is replaced by per-path `feedback_completion` /
// `feedback_plan` / `feedback_reinforcement` / `feedback_rejection`
// components. Historical v1 traces remain valid and interpretable.
export const PILLAR_WEIGHTER_STRATEGY_VERSION = 2;

/**
 * Build the per-feedback-path provenance components for one ranked rec.
 * Each path that fired in `scoreRec` (encoded in `r.feedback_breakdown`)
 * becomes one top-level component using one of the 4 new union arms.
 * Paths that did not fire emit nothing.
 *
 * VTID-03141 (C.3.b): replaces the single fused `feedback_mult`
 * multiplier the v1 strategy emitted.
 */
function buildFeedbackComponents<T extends RankInputRec>(
  rec: T,
  ctx: RankerContext,
  cfg: RankerConfig,
  bd: FeedbackBreakdown,
): RankProvenanceComponent[] {
  const out: RankProvenanceComponent[] = [];
  if (bd.completion !== undefined) {
    out.push({
      kind: 'feedback_completion',
      weight_key: POLICY_KEYS.RANKER_PILLAR_COMPLETION_DAMPENER,
      weight_value: cfg.completion_dampener,
      contribution_multiplier: bd.completion,
    });
  }
  if (bd.plan !== undefined) {
    out.push({
      kind: 'feedback_plan',
      weight_key: POLICY_KEYS.RANKER_PILLAR_PLAN_DAMPENER,
      weight_value: cfg.plan_dampener,
      contribution_multiplier: bd.plan,
    });
  }
  if (bd.community !== undefined) {
    out.push({
      kind: 'feedback_reinforcement',
      path: 'community',
      weight_key: POLICY_KEYS.RANKER_PILLAR_COMMUNITY_MOMENTUM_BOOST,
      weight_value: cfg.community_momentum_boost,
      contribution_multiplier: bd.community,
    });
  }
  if (bd.streak !== undefined) {
    out.push({
      kind: 'feedback_reinforcement',
      path: 'streak',
      weight_key: POLICY_KEYS.RANKER_PILLAR_STREAK_REINFORCEMENT,
      weight_value: cfg.streak_reinforcement,
      contribution_multiplier: bd.streak,
    });
  }
  if (bd.rejection !== undefined) {
    const rate = rec.domain
      ? ctx.rejection_rate_by_domain[rec.domain] ?? 0
      : 0;
    out.push({
      kind: 'feedback_rejection',
      weight_key: POLICY_KEYS.RANKER_PILLAR_REJECTION_DAMPENER_ALPHA,
      weight_value: cfg.rejection_dampener_alpha,
      rejection_rate: rate,
      contribution_multiplier: bd.rejection,
    });
  }
  return out;
}

/**
 * Build a `RankerConfig` populated from PolicyResolver, with the
 * literals previously hard-coded in `index-pillar-weighter.ts` as
 * cache-cold defaults. Result: when the policy table is unreachable
 * or empty, scoring is byte-identical to the pre-C.3 path.
 */
export function buildPillarWeighterConfig(
  resolver: PolicyResolver = getPolicyResolver(),
  tenantId: string | null = null,
): RankerConfig {
  const get = (key: string, defaultValue: number): number =>
    resolver.getValue<number>(key, { tenantId, defaultValue });
  return {
    alpha_pillar:               get(POLICY_KEYS.RANKER_PILLAR_ALPHA_PILLAR,               DEFAULT_RANKER_CONFIG.alpha_pillar),
    alpha_wave:                 get(POLICY_KEYS.RANKER_PILLAR_ALPHA_WAVE,                 DEFAULT_RANKER_CONFIG.alpha_wave),
    compass_boost:              get(POLICY_KEYS.RANKER_PILLAR_COMPASS_BOOST,              DEFAULT_RANKER_CONFIG.compass_boost),
    economic_boost:             DEFAULT_RANKER_CONFIG.economic_boost, // not yet keyed; C.3 follow-up
    pillar_quota_max:           get(POLICY_KEYS.RANKER_PILLAR_QUOTA_MAX,                  DEFAULT_RANKER_CONFIG.pillar_quota_max),
    weakest_quota_max:          get(POLICY_KEYS.RANKER_PILLAR_WEAKEST_QUOTA_MAX,          DEFAULT_RANKER_CONFIG.weakest_quota_max),
    completion_dampener:        get(POLICY_KEYS.RANKER_PILLAR_COMPLETION_DAMPENER,        DEFAULT_RANKER_CONFIG.completion_dampener),
    plan_dampener:              get(POLICY_KEYS.RANKER_PILLAR_PLAN_DAMPENER,              DEFAULT_RANKER_CONFIG.plan_dampener),
    rejection_dampener_alpha:   get(POLICY_KEYS.RANKER_PILLAR_REJECTION_DAMPENER_ALPHA,   DEFAULT_RANKER_CONFIG.rejection_dampener_alpha),
    streak_reinforcement:       get(POLICY_KEYS.RANKER_PILLAR_STREAK_REINFORCEMENT,       DEFAULT_RANKER_CONFIG.streak_reinforcement),
    community_momentum_boost:   get(POLICY_KEYS.RANKER_PILLAR_COMMUNITY_MOMENTUM_BOOST,   DEFAULT_RANKER_CONFIG.community_momentum_boost),
    balance_unbalanced_at:      get(POLICY_KEYS.RANKER_PILLAR_BALANCE_UNBALANCED_AT,      DEFAULT_RANKER_CONFIG.balance_unbalanced_at),
    balance_amplify_at:         get(POLICY_KEYS.RANKER_PILLAR_BALANCE_AMPLIFY_AT,         DEFAULT_RANKER_CONFIG.balance_amplify_at),
    balance_amplify_factor:     get(POLICY_KEYS.RANKER_PILLAR_BALANCE_AMPLIFY_FACTOR,     DEFAULT_RANKER_CONFIG.balance_amplify_factor),
    journey_mode_day_break_1:   get(POLICY_KEYS.RANKER_PILLAR_JOURNEY_MODE_DAY_BREAK_1,   DEFAULT_RANKER_CONFIG.journey_mode_day_break_1),
    journey_mode_day_break_2:   get(POLICY_KEYS.RANKER_PILLAR_JOURNEY_MODE_DAY_BREAK_2,   DEFAULT_RANKER_CONFIG.journey_mode_day_break_2),
    journey_mode_day_break_3:   get(POLICY_KEYS.RANKER_PILLAR_JOURNEY_MODE_DAY_BREAK_3,   DEFAULT_RANKER_CONFIG.journey_mode_day_break_3),
    journey_mode_decay_1to2:    get(POLICY_KEYS.RANKER_PILLAR_JOURNEY_MODE_DECAY_1TO2,    DEFAULT_RANKER_CONFIG.journey_mode_decay_1to2),
    journey_mode_decay_2to3:    get(POLICY_KEYS.RANKER_PILLAR_JOURNEY_MODE_DECAY_2TO3,    DEFAULT_RANKER_CONFIG.journey_mode_decay_2to3),
    journey_mode_terminal:      get(POLICY_KEYS.RANKER_PILLAR_JOURNEY_MODE_TERMINAL,      DEFAULT_RANKER_CONFIG.journey_mode_terminal),
    compass_decay_subtract:     get(POLICY_KEYS.RANKER_PILLAR_COMPASS_DECAY_SUBTRACT,     DEFAULT_RANKER_CONFIG.compass_decay_subtract),
    pillar_score_cap:           get(POLICY_KEYS.RANKER_PILLAR_SCORE_CAP,                  DEFAULT_RANKER_CONFIG.pillar_score_cap),
  };
}

export interface PillarWeighterStrategyResult<
  T extends RankInputRec = RankInputRec,
> {
  readonly score: number;
  readonly provenance: RankProvenance;
  readonly ranked: RankedRec<T>;
}

/**
 * Score a single recommendation under the pillar-weighter strategy and
 * emit a `RankProvenance` trail. The trail captures the same components
 * scoreRec uses in its scalar formula:
 *   rank_score = base
 *     × (1 + alpha_pillar × pillar_boost × (1 − journey_mode))
 *     × compass_boost × economic_boost × feedback_mult
 */
export function scoreRecWithProvenance<T extends RankInputRec>(
  rec: T,
  ctx: RankerContext,
  resolver: PolicyResolver = getPolicyResolver(),
  tenantId: string | null = null,
): PillarWeighterStrategyResult<T> {
  const cfg = buildPillarWeighterConfig(resolver, tenantId);
  const ranked = scoreRec(rec, ctx, cfg);
  const base = Number(rec.impact_score ?? 5);

  // pillar contribution: (1 + alpha_pillar × pillar_boost × (1 − journey_mode))
  // Surface the alpha_pillar weight + pillar_boost signal + (1 − journey_mode)
  // as a single additive component on the "multiplier-1" side.
  const journeyComplement = 1 - ranked.journey_mode;
  const pillarAdditive = cfg.alpha_pillar * ranked.pillar_boost * journeyComplement;

  const components: RankProvenanceComponent[] = [
    { kind: 'base', value: base },
    {
      kind: 'additive',
      name: 'pillar_boost',
      weight_key: POLICY_KEYS.RANKER_PILLAR_ALPHA_PILLAR,
      weight_value: cfg.alpha_pillar,
      signal: ranked.pillar_boost * journeyComplement,
      contribution: pillarAdditive,
    },
    {
      kind: 'multiplier',
      name: 'compass_boost',
      weight_key: POLICY_KEYS.RANKER_PILLAR_COMPASS_BOOST,
      weight_value: cfg.compass_boost,
      applied: ranked.compass_boost > 1,
      contribution_multiplier: ranked.compass_boost,
    },
    {
      kind: 'multiplier',
      name: 'economic_boost',
      // Not yet a `POLICY_KEYS` entry — this lands when economic_boost
      // gets its own seed key in a Phase C follow-up. Track the literal
      // here so the provenance row still has a stable key string.
      weight_key: 'ranker.pillar_weighter.economic_boost',
      weight_value: cfg.economic_boost,
      applied: ranked.economic_boost > 1,
      contribution_multiplier: ranked.economic_boost,
    },
    // Phase C.3.b (VTID-03141): per-path feedback components. Each path
    // that fired in scoreRec emits one component using the 4 new union
    // arms (feedback_completion / feedback_plan / feedback_reinforcement
    // / feedback_rejection). Paths that did not fire emit nothing.
    ...buildFeedbackComponents(rec, ctx, cfg, ranked.feedback_breakdown),
  ];

  const provenance: RankProvenance = {
    strategy_id: PILLAR_WEIGHTER_STRATEGY_ID,
    strategy_version: PILLAR_WEIGHTER_STRATEGY_VERSION,
    computed_at: new Date().toISOString(),
    tenant_id: tenantId,
    components,
    final_score: ranked.rank_score,
  };

  return { score: ranked.rank_score, provenance, ranked };
}

/**
 * Batch variant: builds the resolver-driven config once, scores all recs,
 * runs the standard quota pass, returns ranked recs paired with provenance.
 */
export function rankBatchWithProvenance<T extends RankInputRec>(
  recs: T[],
  ctx: RankerContext,
  resolver: PolicyResolver = getPolicyResolver(),
  tenantId: string | null = null,
): Array<PillarWeighterStrategyResult<T>> {
  const cfg = buildPillarWeighterConfig(resolver, tenantId);
  // Reuse the existing rankBatch for the quota pass, then attach
  // provenance per ranked rec. The two passes are decoupled so
  // provenance generation stays additive (no rank-order change).
  const ranked = rankBatch(recs, ctx, cfg);
  return ranked.map((r) => {
    const base = Number(r.rec.impact_score ?? 5);
    const journeyComplement = 1 - r.journey_mode;
    const pillarAdditive = cfg.alpha_pillar * r.pillar_boost * journeyComplement;
    const components: RankProvenanceComponent[] = [
      { kind: 'base', value: base },
      {
        kind: 'additive',
        name: 'pillar_boost',
        weight_key: POLICY_KEYS.RANKER_PILLAR_ALPHA_PILLAR,
        weight_value: cfg.alpha_pillar,
        signal: r.pillar_boost * journeyComplement,
        contribution: pillarAdditive,
      },
      {
        kind: 'multiplier',
        name: 'compass_boost',
        weight_key: POLICY_KEYS.RANKER_PILLAR_COMPASS_BOOST,
        weight_value: cfg.compass_boost,
        applied: r.compass_boost > 1,
        contribution_multiplier: r.compass_boost,
      },
      {
        kind: 'multiplier',
        name: 'economic_boost',
        weight_key: 'ranker.pillar_weighter.economic_boost',
        weight_value: cfg.economic_boost,
        applied: r.economic_boost > 1,
        contribution_multiplier: r.economic_boost,
      },
      // Phase C.3.b (VTID-03141): per-path feedback components.
      ...buildFeedbackComponents(r.rec, ctx, cfg, r.feedback_breakdown),
    ];
    const provenance: RankProvenance = {
      strategy_id: PILLAR_WEIGHTER_STRATEGY_ID,
      strategy_version: PILLAR_WEIGHTER_STRATEGY_VERSION,
      computed_at: new Date().toISOString(),
      tenant_id: tenantId,
      components,
      final_score: r.rank_score,
    };
    return { score: r.rank_score, provenance, ranked: r };
  });
}
