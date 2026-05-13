/**
 * VTID-02941 (B0b-min) + VTID-02950 (F2) — compileAssistantDecisionContext.
 *
 * Acceptance:
 *   #1 — empty providers produce a valid AssistantDecisionContext with
 *        safe empty defaults for ALL fields (continuity + concept_mastery)
 *   #6 — if any provider throws, the prompt still renders with
 *        sourceHealth=degraded and no crash; the other provider continues
 *
 * The orchestrator MUST:
 *   - never throw upward
 *   - attach reason on source_health when a provider fails
 *   - return field:null when that source health is degraded
 *   - accept provider overrides per-field for tests
 *   - run providers in parallel — one throwing must not block the other
 */

import { compileAssistantDecisionContext } from '../../../src/orb/context/compile-assistant-decision-context';
import type {
  DecisionConceptMastery,
  DecisionContinuity,
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

describe('compileAssistantDecisionContext', () => {
  describe('happy path with both provider overrides', () => {
    it('attaches each provider output to its field', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => stubContinuity,
          conceptMastery: async () => stubConceptMastery,
        },
      });
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.source_health.continuity.ok).toBe(true);
      expect(out.source_health.concept_mastery.ok).toBe(true);
    });
  });

  describe('per-provider throw (acceptance #6)', () => {
    it('continuity throws → continuity null + concept_mastery still flows', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => {
            throw new Error('continuity_boom');
          },
          conceptMastery: async () => stubConceptMastery,
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.source_health.continuity.ok).toBe(false);
      expect(out.source_health.continuity.reason).toBe('continuity_boom');
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.source_health.concept_mastery.ok).toBe(true);
    });

    it('concept_mastery throws → concept_mastery null + continuity still flows', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => stubContinuity,
          conceptMastery: async () => {
            throw new Error('concept_boom');
          },
        },
      });
      expect(out.concept_mastery).toBeNull();
      expect(out.source_health.concept_mastery.ok).toBe(false);
      expect(out.source_health.concept_mastery.reason).toBe('concept_boom');
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.source_health.continuity.ok).toBe(true);
    });

    it('both providers throw → both null but no crash', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => { throw new Error('c_boom'); },
          conceptMastery: async () => { throw new Error('m_boom'); },
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.concept_mastery).toBeNull();
      expect(out.source_health.continuity.reason).toBe('c_boom');
      expect(out.source_health.concept_mastery.reason).toBe('m_boom');
    });
  });

  describe('provider returns null (acceptance #1)', () => {
    it('attaches null + ok:true for both (provider deliberately suppressed)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.concept_mastery).toBeNull();
      expect(out.source_health.continuity.ok).toBe(true);
      expect(out.source_health.concept_mastery.ok).toBe(true);
    });
  });

  describe('always returns a typed shape', () => {
    it('source_health.continuity AND source_health.concept_mastery are always present', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
        },
      });
      expect(out.source_health).toBeDefined();
      expect(out.source_health.continuity).toBeDefined();
      expect(out.source_health.concept_mastery).toBeDefined();
    });

    it('result has exactly three top-level keys (no leakage, no extras)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
        },
      });
      const keys = Object.keys(out).sort();
      expect(keys).toEqual(['concept_mastery', 'continuity', 'source_health']);
    });
  });

  describe('parallel execution', () => {
    it('runs both providers concurrently (one slow does not serialize the other)', async () => {
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
        },
      });
      // concept_mastery finishes first because its delay is shorter,
      // proving the providers ran in parallel (not sequential).
      expect(order).toEqual(['concept', 'continuity']);
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
    });
  });
});
