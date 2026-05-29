/**
 * B0b — context-compiler tests + acceptance checks #2 and #3.
 *
 * Acceptance check #2: compiler emits typed `journeyStage: 'none'` when
 * no match context exists (typed, never undefined).
 *
 * Acceptance check #3: AssistantDecisionContext.matchJourney rejects
 * raw match rows / chat text / profile payloads — strict schema
 * enforces additional-properties=false at the compiler boundary.
 */

import { compileContext } from '../../../src/orb/context/context-compiler';
import {
  assistantDecisionContextSchema,
  parseAssistantDecisionContext,
  decisionMatchJourneySchema,
} from '../../../src/orb/context/assistant-decision-context';
import type { ClientContextEnvelope } from '../../../src/orb/context/client-context-envelope';

const FIXED_NOW = Date.UTC(2026, 4, 11, 18, 30, 0);

function makeEnvelope(over: Partial<ClientContextEnvelope> = {}): ClientContextEnvelope {
  return {
    surface: 'mobile',
    localNow: '2026-05-11T18:30:00+02:00',
    timezone: 'Europe/Berlin',
    deviceClass: 'ios_webview',
    privacyMode: 'private',
    ...over,
  };
}

describe('B0b — context-compiler', () => {
  describe('acceptance check #2: compiler emits journeyStage="none" when no match context exists', () => {
    it('returns typed { journeyStage: "none" } on minimal envelope', async () => {
      const result = await compileContext({
        userId: 'user-1',
        tenantId: 'tenant-1',
        envelope: makeEnvelope(),
        nowMs: FIXED_NOW,
      });
      // CompiledContext.matchJourney is ALWAYS present (typed, never undefined).
      expect(result.compiled.matchJourney).toBeDefined();
      expect(result.compiled.matchJourney.journeyStage).toBe('none');
    });

    it('returns typed { journeyStage: "none" } on null envelope', async () => {
      const result = await compileContext({
        userId: null,
        tenantId: null,
        envelope: null,
        nowMs: FIXED_NOW,
      });
      expect(result.compiled.matchJourney.journeyStage).toBe('none');
    });

    it('returns typed { journeyStage: "none" } for every journeySurface', async () => {
      const surfaces = [
        'intent_board', 'intent_card', 'pre_match_whois', 'match_detail',
        'match_chat', 'activity_plan', 'matches_hub', 'notification_center',
        'command_hub',
      ] as const;
      for (const surface of surfaces) {
        const result = await compileContext({
          userId: 'user-1',
          tenantId: 'tenant-1',
          envelope: makeEnvelope({ journeySurface: surface }),
          nowMs: FIXED_NOW,
        });
        // The seam returns 'none' regardless of surface — it doesn't yet
        // consult match tables.
        expect(result.compiled.matchJourney.journeyStage).toBe('none');
      }
    });

    it('AssistantDecisionContext.matchJourney is absent (NOT { stage: "none" }) on cold start', async () => {
      // The compiler omits matchJourney when stage === 'none' (absence and
      // 'none' have different telemetry semantics per the plan).
      const result = await compileContext({
        userId: 'user-1',
        tenantId: 'tenant-1',
        envelope: makeEnvelope(),
        nowMs: FIXED_NOW,
      });
      expect(result.decision.matchJourney).toBeUndefined();
    });
  });

  describe('acceptance check #3: AssistantDecisionContext.matchJourney rejects raw payloads', () => {
    it('rejects an extra top-level field on matchJourney', () => {
      const bad = {
        stage: 'browsing',
        chatMessage: 'hi how are you', // <-- raw chat text, MUST be rejected
      };
      const result = decisionMatchJourneySchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects a full raw match row', () => {
      const bad = {
        stage: 'mutual_match',
        match_row: {
          id: 'm1',
          user_a: 'u1',
          user_b: 'u2',
          chat_history: ['msg 1', 'msg 2'],
        },
      };
      const result = decisionMatchJourneySchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects raw profile payload', () => {
      const bad = {
        stage: 'pre_interest',
        profileBio: 'Hi I am a longtime hiker who loves...',
        profilePhotos: ['url1', 'url2'],
      };
      const result = decisionMatchJourneySchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects raw intent body', () => {
      const bad = {
        stage: 'browsing',
        intentBody: "Looking for a hiking partner Saturday morning. I'm an experienced hiker who...",
      };
      const result = decisionMatchJourneySchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('accepts ONLY the declared distilled fields', () => {
      const ok = {
        stage: 'mutual_match',
        activityKind: 'hike',
        partyShape: 'one_to_one' as const,
        pendingUserDecision: 'confirm_activity_plan' as const,
        recommendedNextMove: 'confirm_plan' as const,
        warnings: ['silence_3d'],
      };
      const result = decisionMatchJourneySchema.safeParse(ok);
      expect(result.success).toBe(true);
    });

    it('rejects an unknown stage value (enum strictness)', () => {
      const bad = { stage: 'totally_made_up_stage' };
      const result = decisionMatchJourneySchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('full AssistantDecisionContext rejects extra top-level fields too', () => {
      const baseValid = {
        greetingPolicy: 'fresh_intro',
        explanationDepth: 'standard',
        privacyMode: 'unknown',
        situationalFit: {
          timeAppropriateness: 'good',
          locationConfidence: 'high',
          daylightPhase: 'midday',
        },
        opportunitiesToMention: [],
        warnings: [],
      };
      // Adding an extra top-level field should fail.
      const bad = { ...baseValid, customField: 'should_be_rejected' };
      const result = parseAssistantDecisionContext(bad);
      expect(result.ok).toBe(false);
    });

    it('compiler output passes its own schema guard (round-trip)', async () => {
      const result = await compileContext({
        userId: 'user-1',
        tenantId: 'tenant-1',
        envelope: makeEnvelope(),
        nowMs: FIXED_NOW,
      });
      const parsed = parseAssistantDecisionContext(result.decision);
      expect(parsed.ok).toBe(true);
    });
  });

  describe('source-health: timings reported for every source', () => {
    it('reports timing for situational_core + match_journey_context', async () => {
      const result = await compileContext({
        userId: 'user-1',
        tenantId: 'tenant-1',
        envelope: makeEnvelope(),
        nowMs: FIXED_NOW,
      });
      const sourceNames = result.compiled.sourceHealth.timings.map((t) => t.source);
      expect(sourceNames).toContain('situational_core');
      expect(sourceNames).toContain('match_journey_context');
    });

    it('marks all sources "ok" on cold envelope (no slowness, no failures)', async () => {
      const result = await compileContext({
        userId: 'user-1',
        tenantId: 'tenant-1',
        envelope: makeEnvelope(),
        nowMs: FIXED_NOW,
      });
      for (const t of result.compiled.sourceHealth.timings) {
        expect(t.status).toBe('ok');
      }
      expect(result.compiled.sourceHealth.degradedSources).toHaveLength(0);
    });
  });

  describe('truth policy: envelope wins by default', () => {
    it('envelope timezone wins over stored timezone with conflict reported', async () => {
      const result = await compileContext({
        userId: 'user-1',
        tenantId: 'tenant-1',
        envelope: makeEnvelope({ timezone: 'Europe/Berlin' }),
        storedFacts: { timezone: 'America/Los_Angeles' },
        nowMs: FIXED_NOW,
      });
      expect(result.compiled.truth.timezone).toBe('Europe/Berlin');
      expect(result.compiled.truth.conflicts).toHaveLength(1);
      expect(result.compiled.truth.conflicts[0].field).toBe('timezone');
      expect(result.compiled.truth.conflicts[0].winner).toBe('envelope');
    });

    it('privacy escalation sticks: shared_device wins over private', async () => {
      const result = await compileContext({
        userId: 'user-1',
        tenantId: 'tenant-1',
        envelope: makeEnvelope({ privacyMode: 'private' }),
        storedFacts: { privacyMode: 'shared_device' },
        nowMs: FIXED_NOW,
      });
      expect(result.compiled.truth.privacyMode).toBe('shared_device');
    });
  });
});
