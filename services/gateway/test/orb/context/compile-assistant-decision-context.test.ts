/**
 * VTID-02941 (B0b-min) + VTID-02950 (F2) + VTID-02954 (F3) +
 * VTID-02955 (B5) — compileAssistantDecisionContext.
 *
 * Acceptance:
 *   #1 — empty providers produce a valid AssistantDecisionContext with
 *        safe empty defaults for ALL fields
 *   #6 — if any provider throws, the prompt still renders with
 *        sourceHealth=degraded and no crash; other providers continue
 *
 * The orchestrator MUST:
 *   - never throw upward
 *   - attach reason on source_health when a provider fails
 *   - return field:null when that source health is degraded
 *   - accept provider overrides per-field for tests
 *   - run all providers in parallel — one throwing must not block others
 */

import { compileAssistantDecisionContext } from '../../../src/orb/context/compile-assistant-decision-context';
import type {
  DecisionConceptMastery,
  DecisionContinuity,
  DecisionJourneyStage,
  DecisionPillarMomentum,
} from '../../../src/orb/context/types';

const stubContinuity: DecisionContinuity = {
  open_threads: [],
  promises_owed: [],
  promises_kept_recently: [],
  counts: {
    open_threads_total: 0,
    promises_owed_total: 0,
    promises_overdue: 0,
    threads_mentioned_today: 0,
  },
  recommended_follow_up: 'none',
};

const stubConceptMastery: DecisionConceptMastery = {
  concepts_explained: [],
  concepts_mastered: [],
  dyk_cards_seen: [],
  counts: {
    concepts_explained_total: 0,
    concepts_mastered_total: 0,
    dyk_cards_seen_total: 0,
    concepts_explained_in_last_24h: 0,
  },
  recommended_cadence: 'none',
};

const stubJourneyStage: DecisionJourneyStage = {
  stage: 'first_session',
  tenure_bucket: 'first_session',
  explanation_depth: 'deep',
  tone_hint: 'warm_welcoming',
  vitana_index_tier: 'unknown',
  tier_tenure: 'unknown',
  activity_recency: 'unknown',
  usage_volume: 'none',
  journey_confidence: 'low',
  warnings: ['no_tenure_data', 'unknown_tier'],
};

const stubPillarMomentum: DecisionPillarMomentum = {
  per_pillar: [
    { pillar: 'sleep',     momentum: 'unknown' },
    { pillar: 'nutrition', momentum: 'unknown' },
    { pillar: 'exercise',  momentum: 'unknown' },
    { pillar: 'hydration', momentum: 'unknown' },
    { pillar: 'mental',    momentum: 'unknown' },
  ],
  weakest_pillar: null,
  strongest_pillar: null,
  suggested_focus: null,
  confidence: 'low',
  warnings: ['low_pillar_confidence', 'no_recent_pillar_data'],
};

describe('compileAssistantDecisionContext', () => {
  describe('happy path with all four provider overrides', () => {
    it('attaches each provider output to its field', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => stubContinuity,
          conceptMastery: async () => stubConceptMastery,
          journeyStage: async () => stubJourneyStage,
          pillarMomentum: async () => stubPillarMomentum,
        },
      });
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
      expect(out.pillar_momentum).toEqual(stubPillarMomentum);
      expect(out.source_health.continuity.ok).toBe(true);
      expect(out.source_health.concept_mastery.ok).toBe(true);
      expect(out.source_health.journey_stage.ok).toBe(true);
      expect(out.source_health.pillar_momentum.ok).toBe(true);
    });
  });

  describe('per-provider throw (acceptance #6)', () => {
    it('pillar_momentum throws → null + others still flow (acceptance: B5)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => stubContinuity,
          conceptMastery: async () => stubConceptMastery,
          journeyStage: async () => stubJourneyStage,
          pillarMomentum: async () => {
            throw new Error('pillar_boom');
          },
        },
      });
      expect(out.pillar_momentum).toBeNull();
      expect(out.source_health.pillar_momentum.ok).toBe(false);
      expect(out.source_health.pillar_momentum.reason).toBe('pillar_boom');
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
    });

    it('all four providers throw → all null but no crash', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => { throw new Error('c_boom'); },
          conceptMastery: async () => { throw new Error('m_boom'); },
          journeyStage: async () => { throw new Error('j_boom'); },
          pillarMomentum: async () => { throw new Error('p_boom'); },
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.concept_mastery).toBeNull();
      expect(out.journey_stage).toBeNull();
      expect(out.pillar_momentum).toBeNull();
      expect(out.source_health.continuity.reason).toBe('c_boom');
      expect(out.source_health.concept_mastery.reason).toBe('m_boom');
      expect(out.source_health.journey_stage.reason).toBe('j_boom');
      expect(out.source_health.pillar_momentum.reason).toBe('p_boom');
    });

    it('one provider throws does not block the rest (continuity case)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => { throw new Error('continuity_boom'); },
          conceptMastery: async () => stubConceptMastery,
          journeyStage: async () => stubJourneyStage,
          pillarMomentum: async () => stubPillarMomentum,
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
      expect(out.pillar_momentum).toEqual(stubPillarMomentum);
    });
  });

  describe('provider returns null (acceptance #1)', () => {
    it('attaches null + ok:true for all four (provider deliberately suppressed)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
          journeyStage: async () => null,
          pillarMomentum: async () => null,
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.concept_mastery).toBeNull();
      expect(out.journey_stage).toBeNull();
      expect(out.pillar_momentum).toBeNull();
      expect(out.source_health.continuity.ok).toBe(true);
      expect(out.source_health.concept_mastery.ok).toBe(true);
      expect(out.source_health.journey_stage.ok).toBe(true);
      expect(out.source_health.pillar_momentum.ok).toBe(true);
    });
  });

  describe('always returns a typed shape', () => {
    it('all four source_health entries are always present', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
          journeyStage: async () => null,
          pillarMomentum: async () => null,
        },
      });
      expect(out.source_health).toBeDefined();
      expect(out.source_health.continuity).toBeDefined();
      expect(out.source_health.concept_mastery).toBeDefined();
      expect(out.source_health.journey_stage).toBeDefined();
      expect(out.source_health.pillar_momentum).toBeDefined();
    });

    it('result has exactly five top-level keys (no leakage, no extras)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
          journeyStage: async () => null,
          pillarMomentum: async () => null,
        },
      });
      const keys = Object.keys(out).sort();
      expect(keys).toEqual([
        'concept_mastery',
        'continuity',
        'journey_stage',
        'pillar_momentum',
        'source_health',
      ]);
    });
  });

  describe('parallel execution', () => {
    it('runs all four providers concurrently (slowest determines total time)', async () => {
      const order: string[] = [];
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => {
            await new Promise(r => setTimeout(r, 20));
            order.push('continuity');
            return stubContinuity;
          },
          conceptMastery: async () => {
            await new Promise(r => setTimeout(r, 5));
            order.push('concept');
            return stubConceptMastery;
          },
          journeyStage: async () => {
            await new Promise(r => setTimeout(r, 10));
            order.push('journey');
            return stubJourneyStage;
          },
          pillarMomentum: async () => {
            await new Promise(r => setTimeout(r, 15));
            order.push('pillar');
            return stubPillarMomentum;
          },
        },
      });
      // Order: concept (5ms) → journey (10ms) → pillar (15ms) → continuity (20ms),
      // proving all four providers ran in parallel.
      expect(order).toEqual(['concept', 'journey', 'pillar', 'continuity']);
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
      expect(out.pillar_momentum).toEqual(stubPillarMomentum);
    });
  });
});
