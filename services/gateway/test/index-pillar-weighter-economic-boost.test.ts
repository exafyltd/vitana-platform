/**
 * Tests for the economic_boost multiplier wired into index-pillar-weighter.
 *
 * Contract (docs/GOVERNANCE/ULTIMATE-GOAL.md):
 *   - The longevity economy axis is orthogonal to the 5 health pillars.
 *   - economic_boost fires iff (rec.economic_axis !== 'none') AND user has
 *     an active Life Compass goal in {career_purpose, financial_security}.
 *   - Without the gate, every economy-tagged rec would blanket-boost and
 *     crowd out health pillars. The gate prevents that.
 */

import {
  scoreRec,
  hasEconomicGoal,
  DEFAULT_RANKER_CONFIG,
  type RankerContext,
  type RankInputRec,
} from '../src/services/recommendation-engine/ranking/index-pillar-weighter';

// Minimal context — pillars and balance disabled so only multipliers move the score.
const baseContext = (active_goal_category: string | null = null): RankerContext => ({
  pillars: null,
  balance_factor: null,
  weakest_pillar: null,
  active_goal_category,
  days_since_start: 200,    // past 90-day onramp → journey_mode = 0.2
  has_baseline: true,
  has_recent_completions: true,
  recent_activity: {},
  rejection_rate_by_domain: {},
});

const baseRec = (overrides: Partial<RankInputRec> = {}): RankInputRec => ({
  impact_score: 10,
  domain: 'longevity',
  source_ref: 'irrelevant-source-ref',
  contribution_vector: null,
  ...overrides,
});

describe('hasEconomicGoal', () => {
  test.each(['career_purpose', 'financial_security'])(
    'returns true for %s',
    (category) => {
      expect(hasEconomicGoal({ active_goal_category: category })).toBe(true);
    },
  );

  test.each([
    'health_longevity',
    'social_relationships',
    'learning_growth',
    'lifestyle_optimization',
    'creative_expression',
    'community_contribution',
    null,
    '',
  ])('returns false for %s (non-economic / null / empty)', (category) => {
    expect(hasEconomicGoal({ active_goal_category: category as string | null })).toBe(false);
  });
});

describe('scoreRec — economic_boost gate', () => {
  test('economic_boost = 1.0 when rec.economic_axis is missing', () => {
    const ranked = scoreRec(baseRec(), baseContext('career_purpose'));
    expect(ranked.economic_boost).toBe(1.0);
  });

  test('economic_boost = 1.0 when rec.economic_axis is "none"', () => {
    const ranked = scoreRec(baseRec({ economic_axis: 'none' }), baseContext('career_purpose'));
    expect(ranked.economic_boost).toBe(1.0);
  });

  test('economic_boost = 1.0 when user has no economic goal (axis set, goal absent)', () => {
    const ranked = scoreRec(baseRec({ economic_axis: 'marketplace' }), baseContext(null));
    expect(ranked.economic_boost).toBe(1.0);
  });

  test('economic_boost = 1.0 for non-economic goal (axis set, goal=social_relationships)', () => {
    const ranked = scoreRec(
      baseRec({ economic_axis: 'find_match' }),
      baseContext('social_relationships'),
    );
    expect(ranked.economic_boost).toBe(1.0);
  });

  test.each([
    ['marketplace', 'career_purpose'],
    ['find_match', 'financial_security'],
    ['income_generation', 'career_purpose'],
    ['business_formation', 'financial_security'],
  ])(
    'economic_boost fires when axis=%s AND goal=%s',
    (axis, goal) => {
      const ranked = scoreRec(
        baseRec({ economic_axis: axis }),
        baseContext(goal),
      );
      expect(ranked.economic_boost).toBe(DEFAULT_RANKER_CONFIG.economic_boost);
    },
  );

  test('explanation string mentions econ multiplier in both states', () => {
    const noBoost = scoreRec(baseRec(), baseContext('career_purpose'));
    expect(noBoost.explanation).toContain('econ=1.00');

    const withBoost = scoreRec(
      baseRec({ economic_axis: 'marketplace' }),
      baseContext('career_purpose'),
    );
    expect(withBoost.explanation).toContain('econ=1.15');
  });

  test('rank_score reflects the economic_boost multiplier exactly', () => {
    // base=10, no pillar, no compass, journey_mode=0.2 → base × 1 × 1 × econ × 1
    const noBoost = scoreRec(baseRec(), baseContext(null));
    const withBoost = scoreRec(
      baseRec({ economic_axis: 'marketplace' }),
      baseContext('career_purpose'),
    );
    // Each scored rec has rank_score = 10 × (1 + 0.5·0·(1−0.2)) × 1 × econ × 1 = 10 × econ
    expect(noBoost.rank_score).toBeCloseTo(10, 5);
    expect(withBoost.rank_score).toBeCloseTo(10 * DEFAULT_RANKER_CONFIG.economic_boost, 5);
  });

  test('economic_boost is composable with compass_boost (multiplicative)', () => {
    // active_goal_category=longevity + source_ref=start_streak → compass_boost fires.
    // economic_axis=marketplace + economic goal would also fire, BUT longevity is not
    // an economic goal, so economic_boost stays 1.0. This test asserts they're
    // independent dimensions.
    const ranked = scoreRec(
      baseRec({ economic_axis: 'marketplace', source_ref: 'start_streak' }),
      baseContext('longevity'),
    );
    expect(ranked.compass_boost).toBe(DEFAULT_RANKER_CONFIG.compass_boost);
    expect(ranked.economic_boost).toBe(1.0);
  });
});
