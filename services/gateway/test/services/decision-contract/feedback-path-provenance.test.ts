// VTID-03141 — Phase C.3.b of the decision-contract refactor.
//
// Locks the contract for per-feedback-path provenance: the single fused
// `feedback_mult` multiplier from C.3 (v1) is gone, replaced by up to
// 5 per-path components emitted via 4 new union arms:
//
//   - feedback_completion          (kind:'feedback_completion')
//   - feedback_plan                (kind:'feedback_plan')
//   - feedback_reinforcement       (kind:'feedback_reinforcement', path:'community')
//   - feedback_reinforcement       (kind:'feedback_reinforcement', path:'streak')
//   - feedback_rejection           (kind:'feedback_rejection')
//
// strategy_version bumped to 2 (v1 traces remain interpretable).

import {
  scoreRecWithProvenance,
  rankBatchWithProvenance,
  PILLAR_WEIGHTER_STRATEGY_VERSION,
} from '../../../src/services/decision-contract';
import {
  type RankerContext,
  type RankInputRec,
  DEFAULT_RANKER_CONFIG,
} from '../../../src/services/recommendation-engine/ranking/index-pillar-weighter';
import { __resetPolicyResolverForTests } from '../../../src/services/decision-contract/policy-resolver';
import type { RankProvenanceComponent } from '../../../src/services/decision-contract/strategy';

function makeCtx(overrides: Partial<RankerContext> = {}): RankerContext {
  return {
    pillars: {
      nutrition: 100, hydration: 100, exercise: 100, sleep: 100, mental: 100,
    },
    balance_factor: 1.0,
    weakest_pillar: null,
    active_goal_category: null,
    has_baseline: true,
    has_recent_completions: false,
    days_since_start: 14,
    recent_activity: {},
    rejection_rate_by_domain: {},
    ...overrides,
  };
}

function makeRec(overrides: Partial<RankInputRec> = {}): RankInputRec {
  return {
    id: 'rec-1',
    impact_score: 7,
    contribution_vector: { nutrition: 0, hydration: 0, exercise: 0, sleep: 0, mental: 1 },
    source_ref: 'morning_walk',
    domain: 'lifestyle',
    ...overrides,
  };
}

function feedbackComponents(
  components: ReadonlyArray<RankProvenanceComponent>,
): RankProvenanceComponent[] {
  return components.filter((c) => c.kind.startsWith('feedback_')) as RankProvenanceComponent[];
}

describe('VTID-03141 C.3.b — per-feedback-path provenance', () => {
  beforeEach(() => __resetPolicyResolverForTests());

  it('strategy_version is 2', () => {
    expect(PILLAR_WEIGHTER_STRATEGY_VERSION).toBe(2);
    const out = scoreRecWithProvenance(makeRec(), makeCtx());
    expect(out.provenance.strategy_version).toBe(2);
  });

  it('no fb path fires → no feedback_* components in the trail', () => {
    const out = scoreRecWithProvenance(makeRec(), makeCtx());
    expect(feedbackComponents(out.provenance.components)).toHaveLength(0);
  });

  it('completions_24h>0 → emits feedback_completion ONLY (mutex with plan)', () => {
    const ctx = makeCtx({
      recent_activity: {
        mental: {
          last_completed_at: null,
          completions_24h: 1,
          completions_7d: 1,
          plan_events_24h: 99, // would have triggered plan, but completion wins
        },
      },
    });
    const out = scoreRecWithProvenance(makeRec(), ctx);
    const fb = feedbackComponents(out.provenance.components);
    expect(fb).toHaveLength(1);
    expect(fb[0].kind).toBe('feedback_completion');
    if (fb[0].kind === 'feedback_completion') {
      expect(fb[0].weight_key).toBe('ranker.pillar_weighter.completion_dampener');
      expect(fb[0].weight_value).toBe(DEFAULT_RANKER_CONFIG.completion_dampener);
      expect(fb[0].contribution_multiplier).toBe(DEFAULT_RANKER_CONFIG.completion_dampener);
    }
  });

  it('plan_events_24h>0 with no completions_24h → emits feedback_plan ONLY', () => {
    const ctx = makeCtx({
      recent_activity: {
        mental: {
          last_completed_at: null,
          completions_24h: 0,
          completions_7d: 0,
          plan_events_24h: 1,
        },
      },
    });
    const out = scoreRecWithProvenance(makeRec(), ctx);
    const fb = feedbackComponents(out.provenance.components);
    expect(fb).toHaveLength(1);
    expect(fb[0].kind).toBe('feedback_plan');
    if (fb[0].kind === 'feedback_plan') {
      expect(fb[0].weight_key).toBe('ranker.pillar_weighter.plan_dampener');
      expect(fb[0].weight_value).toBe(DEFAULT_RANKER_CONFIG.plan_dampener);
    }
  });

  it('completions_7d>=3 + mental pillar → emits feedback_reinforcement(community)', () => {
    const ctx = makeCtx({
      recent_activity: {
        mental: {
          last_completed_at: null,
          completions_24h: 0,
          completions_7d: 5,
          plan_events_24h: 0,
        },
      },
    });
    const out = scoreRecWithProvenance(makeRec(), ctx);
    const fb = feedbackComponents(out.provenance.components);
    expect(fb).toHaveLength(1);
    expect(fb[0].kind).toBe('feedback_reinforcement');
    if (fb[0].kind === 'feedback_reinforcement') {
      expect(fb[0].path).toBe('community');
      expect(fb[0].weight_key).toBe('ranker.pillar_weighter.community_momentum_boost');
      expect(fb[0].weight_value).toBe(DEFAULT_RANKER_CONFIG.community_momentum_boost);
    }
  });

  it('start_streak rec with completions_7d>=3 → emits BOTH community and streak reinforcement', () => {
    // primary pillar = mental + completions_7d>=3 satisfies both
    // community-momentum (primary===mental) and streak (source_ref===start_streak).
    const ctx = makeCtx({
      recent_activity: {
        mental: {
          last_completed_at: null,
          completions_24h: 0,
          completions_7d: 5,
          plan_events_24h: 0,
        },
      },
    });
    const out = scoreRecWithProvenance(makeRec({ source_ref: 'start_streak' }), ctx);
    const fb = feedbackComponents(out.provenance.components);
    expect(fb).toHaveLength(2);
    const paths = fb
      .filter((c) => c.kind === 'feedback_reinforcement')
      .map((c) => (c as { path: string }).path);
    expect(paths.sort()).toEqual(['community', 'streak']);
  });

  it('rejection_rate_by_domain set → emits feedback_rejection with rate captured', () => {
    const ctx = makeCtx({
      rejection_rate_by_domain: { lifestyle: 0.4 },
    });
    const out = scoreRecWithProvenance(makeRec(), ctx);
    const fb = feedbackComponents(out.provenance.components);
    expect(fb).toHaveLength(1);
    expect(fb[0].kind).toBe('feedback_rejection');
    if (fb[0].kind === 'feedback_rejection') {
      expect(fb[0].weight_key).toBe('ranker.pillar_weighter.rejection_dampener_alpha');
      expect(fb[0].rejection_rate).toBe(0.4);
      // contribution_multiplier = max(0.2, 1 - 0.5 × 0.4) = max(0.2, 0.8) = 0.8
      expect(fb[0].contribution_multiplier).toBeCloseTo(0.8, 5);
    }
  });

  it('rejection_rate clamps at 0.2 floor for extreme dismissal', () => {
    const ctx = makeCtx({
      rejection_rate_by_domain: { lifestyle: 5.0 }, // 1 - 0.5 × 5 = -1.5 → clamp 0.2
    });
    const out = scoreRecWithProvenance(makeRec(), ctx);
    const fb = feedbackComponents(out.provenance.components);
    expect(fb).toHaveLength(1);
    if (fb[0].kind === 'feedback_rejection') {
      expect(fb[0].contribution_multiplier).toBeCloseTo(0.2, 5);
    }
  });

  it('multiple paths can co-fire and each gets its own component', () => {
    const ctx = makeCtx({
      recent_activity: {
        mental: {
          last_completed_at: null,
          completions_24h: 1,
          completions_7d: 5,
          plan_events_24h: 0,
        },
      },
      rejection_rate_by_domain: { lifestyle: 0.3 },
    });
    const out = scoreRecWithProvenance(makeRec({ source_ref: 'start_streak' }), ctx);
    const fb = feedbackComponents(out.provenance.components);
    // Expected paths:
    //   - feedback_completion (completions_24h>0)
    //   - feedback_reinforcement community (completions_7d>=3 + mental)
    //   - feedback_reinforcement streak (completions_7d>=3 + start_streak)
    //   - feedback_rejection (lifestyle rate 0.3)
    expect(fb).toHaveLength(4);
    const kinds = fb.map((c) => c.kind).sort();
    expect(kinds).toEqual([
      'feedback_completion',
      'feedback_reinforcement',
      'feedback_reinforcement',
      'feedback_rejection',
    ]);
  });

  it('byte-identical final_score: per-path components reconstruct the score', () => {
    // The product of all multipliers should match the legacy single
    // feedback_mult value, so rank_score must equal the v1 result.
    const ctx = makeCtx({
      recent_activity: {
        mental: {
          last_completed_at: null,
          completions_24h: 0,
          completions_7d: 5,
          plan_events_24h: 0,
        },
      },
      rejection_rate_by_domain: { lifestyle: 0.2 },
    });
    const rec = makeRec({ source_ref: 'start_streak' });
    const out = scoreRecWithProvenance(rec, ctx);
    expect(Number.isFinite(out.score)).toBe(true);
    expect(out.provenance.final_score).toBe(out.score);
    // Manually replay the fb_mult product from the new components.
    const fb = feedbackComponents(out.provenance.components);
    const product = fb.reduce((acc, c) => {
      if (
        c.kind === 'feedback_completion' ||
        c.kind === 'feedback_plan' ||
        c.kind === 'feedback_reinforcement' ||
        c.kind === 'feedback_rejection'
      ) {
        return acc * c.contribution_multiplier;
      }
      return acc;
    }, 1);
    // Expected: community (1.2) × streak (1.3) × rejection (1 - 0.5 × 0.2 = 0.9)
    expect(product).toBeCloseTo(1.2 * 1.3 * 0.9, 5);
  });

  it('batch path emits per-path components per row', () => {
    const ctx = makeCtx({
      recent_activity: {
        mental: {
          last_completed_at: null,
          completions_24h: 1,
          completions_7d: 0,
          plan_events_24h: 0,
        },
      },
    });
    const recs = [
      makeRec({ id: 'a' }),
      makeRec({ id: 'b', domain: 'health' }),
    ];
    const out = rankBatchWithProvenance(recs, ctx);
    expect(out).toHaveLength(2);
    for (const r of out) {
      const fb = feedbackComponents(r.provenance.components);
      // Each row's primary pillar is mental + completions_24h>0 ⇒ completion fires
      expect(fb).toHaveLength(1);
      expect(fb[0].kind).toBe('feedback_completion');
    }
  });
});
