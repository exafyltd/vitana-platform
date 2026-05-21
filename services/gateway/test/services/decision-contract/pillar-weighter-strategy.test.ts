// VTID-03132 — Phase C.3 of the decision-contract refactor.
//
// Locks two contracts:
//   1. Byte-identical parity: PillarWeighterStrategy + cold-cache resolver
//      MUST produce the same rank_score as the pre-C.3 `scoreRec` /
//      `rankBatch` path running on DEFAULT_RANKER_CONFIG.
//   2. Provenance shape: every score is paired with a `RankProvenance`
//      trail whose components reconstruct the scoring formula.

import {
  scoreRec,
  rankBatch,
  computeJourneyMode,
  DEFAULT_RANKER_CONFIG,
  type RankerConfig,
  type RankerContext,
  type RankInputRec,
} from '../../../src/services/recommendation-engine/ranking/index-pillar-weighter';
import {
  buildPillarWeighterConfig,
  scoreRecWithProvenance,
  rankBatchWithProvenance,
  PILLAR_WEIGHTER_STRATEGY_ID,
  PILLAR_WEIGHTER_STRATEGY_VERSION,
} from '../../../src/services/decision-contract';
import {
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
  getPolicyResolver,
} from '../../../src/services/decision-contract/policy-resolver';

const NOW_ISO = new Date().toISOString();

function makeCtx(overrides: Partial<RankerContext> = {}): RankerContext {
  return {
    pillars: {
      nutrition: 120,
      hydration: 80,
      exercise: 140,
      sleep: 100,
      mental: 90,
    },
    balance_factor: 0.85,
    weakest_pillar: 'hydration',
    active_goal_category: null,
    has_baseline: true,
    has_recent_completions: true,
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
    contribution_vector: { nutrition: 0, hydration: 1, exercise: 0, sleep: 0, mental: 0 },
    source_ref: 'morning_walk',
    domain: 'lifestyle',
    ...overrides,
  };
}

function seedAllRankerPolicies(cfgOverrides: Partial<RankerConfig> = {}) {
  const cfg: RankerConfig = { ...DEFAULT_RANKER_CONFIG, ...cfgOverrides };
  const rows = [
    ['ranker.pillar_weighter.alpha_pillar', cfg.alpha_pillar],
    ['ranker.pillar_weighter.alpha_wave', cfg.alpha_wave],
    ['ranker.pillar_weighter.compass_boost', cfg.compass_boost],
    ['ranker.pillar_weighter.pillar_quota_max', cfg.pillar_quota_max],
    ['ranker.pillar_weighter.weakest_quota_max', cfg.weakest_quota_max],
    ['ranker.pillar_weighter.completion_dampener', cfg.completion_dampener],
    ['ranker.pillar_weighter.plan_dampener', cfg.plan_dampener],
    ['ranker.pillar_weighter.rejection_dampener_alpha', cfg.rejection_dampener_alpha],
    ['ranker.pillar_weighter.streak_reinforcement', cfg.streak_reinforcement],
    ['ranker.pillar_weighter.community_momentum_boost', cfg.community_momentum_boost],
    ['ranker.pillar_weighter.balance_unbalanced_at', cfg.balance_unbalanced_at],
    ['ranker.pillar_weighter.balance_amplify_at', cfg.balance_amplify_at],
    ['ranker.pillar_weighter.balance_amplify_factor', cfg.balance_amplify_factor],
    ['ranker.pillar_weighter.journey_mode_day_break_1', cfg.journey_mode_day_break_1],
    ['ranker.pillar_weighter.journey_mode_day_break_2', cfg.journey_mode_day_break_2],
    ['ranker.pillar_weighter.journey_mode_day_break_3', cfg.journey_mode_day_break_3],
    ['ranker.pillar_weighter.journey_mode_decay_1to2', cfg.journey_mode_decay_1to2],
    ['ranker.pillar_weighter.journey_mode_decay_2to3', cfg.journey_mode_decay_2to3],
    ['ranker.pillar_weighter.journey_mode_terminal', cfg.journey_mode_terminal],
    ['ranker.pillar_weighter.compass_decay_subtract', cfg.compass_decay_subtract],
    ['ranker.pillar_weighter.pillar_score_cap', cfg.pillar_score_cap],
  ] as const;
  configurePolicyResolverForTests({
    decisionPolicy: rows.map(([policy_key, value]) => ({
      policy_key,
      tenant_id: null,
      version: 1,
      value_json: value as unknown,
      effective_from: NOW_ISO,
      effective_until: null,
    })),
  });
}

describe('VTID-03132 Phase C.3 PillarWeighterStrategy', () => {
  afterEach(() => {
    __resetPolicyResolverForTests();
  });

  describe('cold-cache fallback path — byte-identical to DEFAULT_RANKER_CONFIG', () => {
    beforeEach(() => {
      __resetPolicyResolverForTests();
    });

    it('buildPillarWeighterConfig returns DEFAULT_RANKER_CONFIG when no rows seeded', () => {
      const cfg = buildPillarWeighterConfig();
      // Every numeric field must match the default. Spot-check a couple
      // critical ones; the parity tests below will exercise the rest.
      expect(cfg.alpha_pillar).toBe(DEFAULT_RANKER_CONFIG.alpha_pillar);
      expect(cfg.compass_boost).toBe(DEFAULT_RANKER_CONFIG.compass_boost);
      expect(cfg.pillar_score_cap).toBe(DEFAULT_RANKER_CONFIG.pillar_score_cap);
      expect(cfg.journey_mode_day_break_1).toBe(7);
      expect(cfg.balance_amplify_factor).toBe(1.2);
    });

    it.each([
      ['nutrition'],
      ['hydration'],
      ['exercise'],
      ['sleep'],
      ['mental'],
    ] as const)(
      'parity (%s pillar): cold-cache strategy score matches DEFAULT_RANKER_CONFIG scoreRec',
      (pillar) => {
        const rec = makeRec({
          contribution_vector: {
            nutrition: pillar === 'nutrition' ? 1 : 0,
            hydration: pillar === 'hydration' ? 1 : 0,
            exercise: pillar === 'exercise' ? 1 : 0,
            sleep: pillar === 'sleep' ? 1 : 0,
            mental: pillar === 'mental' ? 1 : 0,
          },
          id: `rec-${pillar}`,
        });
        const ctx = makeCtx({ weakest_pillar: pillar });
        const reference = scoreRec(rec, ctx);
        const out = scoreRecWithProvenance(rec, ctx);
        expect(out.score).toBeCloseTo(reference.rank_score, 10);
        expect(out.ranked.rank_score).toBeCloseTo(reference.rank_score, 10);
        expect(out.provenance.final_score).toBeCloseTo(reference.rank_score, 10);
      },
    );

    it('parity with active compass goal + streak signal + completion dampener', () => {
      const rec = makeRec({
        contribution_vector: { nutrition: 0, hydration: 1, exercise: 0, sleep: 0, mental: 0 },
        source_ref: 'start_streak',
      });
      const ctx = makeCtx({
        active_goal_category: 'health_baseline',
        recent_activity: {
          hydration: {
            last_completed_at: '2026-05-21T00:00:00.000Z',
            completions_24h: 0,
            completions_7d: 4,
            plan_events_24h: 0,
          },
        },
      });
      const reference = scoreRec(rec, ctx);
      const out = scoreRecWithProvenance(rec, ctx);
      expect(out.score).toBeCloseTo(reference.rank_score, 10);
    });

    it('parity with dismissal rate suppression', () => {
      const rec = makeRec({ domain: 'lifestyle' });
      const ctx = makeCtx({ rejection_rate_by_domain: { lifestyle: 0.6 } });
      const reference = scoreRec(rec, ctx);
      const out = scoreRecWithProvenance(rec, ctx);
      expect(out.score).toBeCloseTo(reference.rank_score, 10);
    });

    it('parity for the rankBatch path with quota enforcement', () => {
      const recs: RankInputRec[] = [
        makeRec({ id: 'r1', impact_score: 9, contribution_vector: { nutrition: 1, hydration: 0, exercise: 0, sleep: 0, mental: 0 } }),
        makeRec({ id: 'r2', impact_score: 8, contribution_vector: { nutrition: 0, hydration: 1, exercise: 0, sleep: 0, mental: 0 } }),
        makeRec({ id: 'r3', impact_score: 8, contribution_vector: { nutrition: 0, hydration: 0, exercise: 1, sleep: 0, mental: 0 } }),
        makeRec({ id: 'r4', impact_score: 7, contribution_vector: { nutrition: 0, hydration: 0, exercise: 0, sleep: 1, mental: 0 } }),
        makeRec({ id: 'r5', impact_score: 6, contribution_vector: { nutrition: 0, hydration: 0, exercise: 0, sleep: 0, mental: 1 } }),
      ];
      const ctx = makeCtx();
      const reference = rankBatch(recs, ctx);
      const out = rankBatchWithProvenance(recs, ctx);
      // Same ranking order
      expect(out.map((o) => o.ranked.rec.id)).toEqual(reference.map((r) => r.rec.id));
      // Same scores
      out.forEach((o, i) => {
        expect(o.score).toBeCloseTo(reference[i].rank_score, 10);
        expect(o.provenance.final_score).toBeCloseTo(reference[i].rank_score, 10);
      });
    });
  });

  describe('resolver-seeded path — DB row wins over fallback', () => {
    it('seeded alpha_pillar override changes the score', () => {
      seedAllRankerPolicies({ alpha_pillar: 1.0 }); // double the default 0.5
      const rec = makeRec({
        contribution_vector: { nutrition: 0, hydration: 1, exercise: 0, sleep: 0, mental: 0 },
      });
      const ctx = makeCtx();
      const reference = scoreRec(rec, ctx); // uses DEFAULT_RANKER_CONFIG
      const out = scoreRecWithProvenance(rec, ctx);
      // alpha_pillar doubled → the strategy's score should be > reference
      // (so long as the rec actually has any pillar_boost).
      expect(out.ranked.pillar_boost).toBeGreaterThan(0);
      expect(out.score).toBeGreaterThan(reference.rank_score);
    });

    it('seeded journey_mode_terminal changes computeJourneyMode tail', () => {
      seedAllRankerPolicies({ journey_mode_terminal: 0.4 });
      const cfg = buildPillarWeighterConfig();
      // computeJourneyMode at day 200 should return the seeded value
      // (no compass override).
      const ctx = makeCtx({
        days_since_start: 200,
        active_goal_category: null,
      });
      const m = computeJourneyMode(ctx, cfg);
      expect(m).toBe(0.4);
    });
  });

  describe('provenance shape', () => {
    beforeEach(() => {
      __resetPolicyResolverForTests();
    });

    it('emits strategy_id and version', () => {
      const out = scoreRecWithProvenance(makeRec(), makeCtx());
      expect(out.provenance.strategy_id).toBe(PILLAR_WEIGHTER_STRATEGY_ID);
      expect(out.provenance.strategy_version).toBe(PILLAR_WEIGHTER_STRATEGY_VERSION);
      expect(out.provenance.strategy_id).toBe('pillar_weighter_v1');
    });

    it('emits the 5 canonical components: base + 1 additive + 3 multipliers', () => {
      const out = scoreRecWithProvenance(makeRec(), makeCtx());
      const kinds = out.provenance.components.map((c) => c.kind);
      expect(kinds).toEqual(['base', 'additive', 'multiplier', 'multiplier', 'multiplier']);
      const names = out.provenance.components.map((c) =>
        c.kind === 'base' ? 'base' : (c as { name: string }).name,
      );
      expect(names).toEqual([
        'base',
        'pillar_boost',
        'compass_boost',
        'economic_boost',
        'feedback_mult',
      ]);
    });

    it('component weight_keys cite POLICY_KEYS strings for grep-back', () => {
      const out = scoreRecWithProvenance(makeRec(), makeCtx());
      const c = out.provenance.components;
      // pillar_boost cites alpha_pillar
      expect(c[1].kind).toBe('additive');
      if (c[1].kind === 'additive') {
        expect(c[1].weight_key).toBe('ranker.pillar_weighter.alpha_pillar');
      }
      // compass_boost cites compass_boost key
      expect(c[2].kind).toBe('multiplier');
      if (c[2].kind === 'multiplier') {
        expect(c[2].weight_key).toBe('ranker.pillar_weighter.compass_boost');
      }
    });

    it('final_score on provenance matches the score field exactly', () => {
      const out = scoreRecWithProvenance(makeRec(), makeCtx());
      expect(out.provenance.final_score).toBe(out.score);
    });

    it('computed_at is a parseable ISO-8601 timestamp', () => {
      const out = scoreRecWithProvenance(makeRec(), makeCtx());
      expect(Number.isFinite(Date.parse(out.provenance.computed_at))).toBe(true);
    });
  });

  describe('singleton resolver wiring', () => {
    it('buildPillarWeighterConfig defaults to getPolicyResolver()', () => {
      // No resolver passed → must not throw.
      __resetPolicyResolverForTests();
      const cfg = buildPillarWeighterConfig();
      expect(cfg).toBeDefined();
      expect(cfg.alpha_pillar).toBeGreaterThan(0);
      expect(getPolicyResolver).toBeDefined();
    });
  });
});
