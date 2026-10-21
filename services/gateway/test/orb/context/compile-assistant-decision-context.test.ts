/**
 * VTID-02941 (B0b-min) + VTID-02950 (F2) + VTID-02954 (F3) +
 * VTID-02955 (B5) + VTID-02962 (B6) — compileAssistantDecisionContext.
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
  DecisionInteractionStyle,
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

const stubInteractionStyle: DecisionInteractionStyle = {
  preferred_response_style: 'unknown',
  interaction_pace: 'unknown',
  tone_preference: 'unknown',
  explanation_depth_hint: 'normal',
  confidence_bucket: 'unknown',
  warnings: ['no_recorded_preferences', 'low_signal_confidence'],
};

describe('compileAssistantDecisionContext', () => {
  describe('happy path with all five provider overrides', () => {
    it('attaches each provider output to its field', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => stubContinuity,
          conceptMastery: async () => stubConceptMastery,
          journeyStage: async () => stubJourneyStage,
          pillarMomentum: async () => stubPillarMomentum,
          interactionStyle: async () => stubInteractionStyle,
        },
      });
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
      expect(out.pillar_momentum).toEqual(stubPillarMomentum);
      expect(out.interaction_style).toEqual(stubInteractionStyle);
      expect(out.source_health.continuity.ok).toBe(true);
      expect(out.source_health.concept_mastery.ok).toBe(true);
      expect(out.source_health.journey_stage.ok).toBe(true);
      expect(out.source_health.pillar_momentum.ok).toBe(true);
      expect(out.source_health.interaction_style.ok).toBe(true);
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
          interactionStyle: async () => stubInteractionStyle,
        },
      });
      expect(out.pillar_momentum).toBeNull();
      expect(out.source_health.pillar_momentum.ok).toBe(false);
      expect(out.source_health.pillar_momentum.reason).toBe('pillar_boom');
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
      expect(out.interaction_style).toEqual(stubInteractionStyle);
    });

    it('interaction_style throws → null + others still flow (acceptance: B6)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => stubContinuity,
          conceptMastery: async () => stubConceptMastery,
          journeyStage: async () => stubJourneyStage,
          pillarMomentum: async () => stubPillarMomentum,
          interactionStyle: async () => { throw new Error('interaction_boom'); },
        },
      });
      expect(out.interaction_style).toBeNull();
      expect(out.source_health.interaction_style.ok).toBe(false);
      expect(out.source_health.interaction_style.reason).toBe('interaction_boom');
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
      expect(out.pillar_momentum).toEqual(stubPillarMomentum);
    });

    it('all five providers throw → all null but no crash', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => { throw new Error('c_boom'); },
          conceptMastery: async () => { throw new Error('m_boom'); },
          journeyStage: async () => { throw new Error('j_boom'); },
          pillarMomentum: async () => { throw new Error('p_boom'); },
          interactionStyle: async () => { throw new Error('i_boom'); },
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.concept_mastery).toBeNull();
      expect(out.journey_stage).toBeNull();
      expect(out.pillar_momentum).toBeNull();
      expect(out.interaction_style).toBeNull();
      expect(out.source_health.continuity.reason).toBe('c_boom');
      expect(out.source_health.concept_mastery.reason).toBe('m_boom');
      expect(out.source_health.journey_stage.reason).toBe('j_boom');
      expect(out.source_health.pillar_momentum.reason).toBe('p_boom');
      expect(out.source_health.interaction_style.reason).toBe('i_boom');
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
          interactionStyle: async () => stubInteractionStyle,
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
      expect(out.pillar_momentum).toEqual(stubPillarMomentum);
      expect(out.interaction_style).toEqual(stubInteractionStyle);
    });
  });

  describe('provider returns null (acceptance #1)', () => {
    it('attaches null + ok:true for all five (provider deliberately suppressed)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
          journeyStage: async () => null,
          pillarMomentum: async () => null,
          interactionStyle: async () => null,
        },
      });
      expect(out.continuity).toBeNull();
      expect(out.concept_mastery).toBeNull();
      expect(out.journey_stage).toBeNull();
      expect(out.pillar_momentum).toBeNull();
      expect(out.interaction_style).toBeNull();
      expect(out.source_health.continuity.ok).toBe(true);
      expect(out.source_health.concept_mastery.ok).toBe(true);
      expect(out.source_health.journey_stage.ok).toBe(true);
      expect(out.source_health.pillar_momentum.ok).toBe(true);
      expect(out.source_health.interaction_style.ok).toBe(true);
    });
  });

  describe('always returns a typed shape', () => {
    it('all five source_health entries are always present', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
          journeyStage: async () => null,
          pillarMomentum: async () => null,
          interactionStyle: async () => null,
        },
      });
      expect(out.source_health).toBeDefined();
      expect(out.source_health.continuity).toBeDefined();
      expect(out.source_health.concept_mastery).toBeDefined();
      expect(out.source_health.journey_stage).toBeDefined();
      expect(out.source_health.pillar_momentum).toBeDefined();
      expect(out.source_health.interaction_style).toBeDefined();
    });

    it('result has exactly six top-level keys (no leakage, no extras)', async () => {
      const out = await compileAssistantDecisionContext({
        userId: 'u',
        tenantId: 't',
        providers: {
          continuity: async () => null,
          conceptMastery: async () => null,
          journeyStage: async () => null,
          pillarMomentum: async () => null,
          interactionStyle: async () => null,
        },
      });
      const keys = Object.keys(out).sort();
      expect(keys).toEqual([
        'concept_mastery',
        'continuity',
        'interaction_style',
        'journey_stage',
        'pillar_momentum',
        'source_health',
      ]);
    });
  });

  describe('parallel execution', () => {
    // VTID-04935: this used to prove concurrency by asserting the order in
    // which 5/10/15/20/25 ms timers fired, which a loaded CI runner can
    // reorder (failed once on PR #3898). It now proves it without wall-clock
    // time: every provider records its start, then waits on one gate that
    // opens only when all five have started. Sequential awaiting can never
    // open the gate.
    it('starts all five providers before any of them finishes', async () => {
      const events: string[] = [];
      let started = 0;
      let openGate!: () => void;
      const gate = new Promise<void>(r => { openGate = r; });
      const provider = <T>(name: string, stub: T) => async (): Promise<T> => {
        events.push(`start:${name}`);
        // The fifth start opens the gate synchronously, after its own push;
        // every `end:*` push runs in a later microtask, so no end can come
        // before a start.
        if (++started === 5) openGate();
        await gate;
        events.push(`end:${name}`);
        return stub;
      };

      // Guard for the regression this test exists to catch: if providers were
      // awaited one after another, the first would wait on the gate forever.
      // It never fires in normal operation (everything resolves in microtasks).
      let guardTimer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<never>((_, reject) => {
        guardTimer = setTimeout(
          () => reject(new Error('providers were not started concurrently')),
          3000,
        );
      });

      const out = await Promise.race([
        compileAssistantDecisionContext({
          userId: 'u',
          tenantId: 't',
          providers: {
            continuity: provider('continuity', stubContinuity),
            conceptMastery: provider('concept', stubConceptMastery),
            journeyStage: provider('journey', stubJourneyStage),
            pillarMomentum: provider('pillar', stubPillarMomentum),
            interactionStyle: provider('interaction', stubInteractionStyle),
          },
        }),
        guard,
      ]).finally(() => clearTimeout(guardTimer));

      const firstEnd = events.findIndex(e => e.startsWith('end:'));
      expect(events.slice(0, firstEnd).filter(e => e.startsWith('start:'))).toHaveLength(5);
      expect(events.filter(e => e.startsWith('end:'))).toHaveLength(5);
      expect(out.continuity).toEqual(stubContinuity);
      expect(out.concept_mastery).toEqual(stubConceptMastery);
      expect(out.journey_stage).toEqual(stubJourneyStage);
      expect(out.pillar_momentum).toEqual(stubPillarMomentum);
      expect(out.interaction_style).toEqual(stubInteractionStyle);
    });
  });
});
