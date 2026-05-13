/**
 * VTID-02941 (B0b-min) + VTID-02950 (F2) + VTID-02954 (F3) —
 * compileAssistantDecisionContext.
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

describe('compileAssistantDecisionContext', () => {
  describe('happy path with all three provider overrides', () => {
    it('attaches each provider output to its field', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => stubContinuity,
          conceptMastery: async () => stubConceptMastery,
          journeyStage: async () => stubJourneyStage,
        },
      });
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
      expect(out.source_health.continuity.ok).toBe(true);
      expect(out.source_health.concept_mastery.ok).toBe(true);
      expect(out.source_health.journey_stage.ok).toBe(true);
    });
  });

  describe('per-provider throw (acceptance #6)', () => {
    it('continuity throws → continuity null + others still flow', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => {
            throw new Error('continuity_boom');
          },
          conceptMastery: async () => stubConceptMastery,
          journeyStage: async () => stubJourneyStage,
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.source_health.continuity.ok).toBe(false);
      expect(out.source_health.continuity.reason).toBe('continuity_boom');
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.source_health.concept_mastery.ok).toBe(true);
      expect(out.journey_stage).toEqual(stubJourneyStage);
      expect(out.source_health.journey_stage.ok).toBe(true);
    });

    it('concept_mastery throws → null + others still flow', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => stubContinuity,
          conceptMastery: async () => {
            throw new Error('concept_boom');
          },
          journeyStage: async () => stubJourneyStage,
        },
      });
      expect(out.concept_mastery).toBeNull();
      expect(out.source_health.concept_mastery.ok).toBe(false);
      expect(out.source_health.concept_mastery.reason).toBe('concept_boom');
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.journey_stage).toEqual(stubJourneyStage);
    });

    it('journey_stage throws → null + others still flow (acceptance: F3)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => stubContinuity,
          conceptMastery: async () => stubConceptMastery,
          journeyStage: async () => {
            throw new Error('journey_boom');
          },
        },
      });
      expect(out.journey_stage).toBeNull();
      expect(out.source_health.journey_stage.ok).toBe(false);
      expect(out.source_health.journey_stage.reason).toBe('journey_boom');
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
    });

    it('all three providers throw → all null but no crash', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => { throw new Error('c_boom'); },
          conceptMastery: async () => { throw new Error('m_boom'); },
          journeyStage: async () => { throw new Error('j_boom'); },
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.concept_mastery).toBeNull();
      expect(out.journey_stage).toBeNull();
      expect(out.source_health.continuity.reason).toBe('c_boom');
      expect(out.source_health.concept_mastery.reason).toBe('m_boom');
      expect(out.source_health.journey_stage.reason).toBe('j_boom');
    });
  });

  describe('provider returns null (acceptance #1)', () => {
    it('attaches null + ok:true for all three (provider deliberately suppressed)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
          journeyStage: async () => null,
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.concept_mastery).toBeNull();
      expect(out.journey_stage).toBeNull();
      expect(out.source_health.continuity.ok).toBe(true);
      expect(out.source_health.concept_mastery.ok).toBe(true);
      expect(out.source_health.journey_stage.ok).toBe(true);
    });
  });

  describe('always returns a typed shape', () => {
    it('all three source_health entries are always present', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
          journeyStage: async () => null,
        },
      });
      expect(out.source_health).toBeDefined();
      expect(out.source_health.continuity).toBeDefined();
      expect(out.source_health.concept_mastery).toBeDefined();
      expect(out.source_health.journey_stage).toBeDefined();
    });

    it('result has exactly four top-level keys (no leakage, no extras)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
          journeyStage: async () => null,
        },
      });
      const keys = Object.keys(out).sort();
      expect(keys).toEqual([
        'concept_mastery',
        'continuity',
        'journey_stage',
        'source_health',
      ]);
    });
  });

  describe('parallel execution', () => {
    it('runs all three providers concurrently (slowest determines total time)', async () => {
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
        },
      });
      // Order: concept (5ms) → journey (10ms) → continuity (20ms),
      // proving providers ran in parallel.
      expect(order).toEqual(['concept', 'journey', 'continuity']);
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
    });
  });
});
