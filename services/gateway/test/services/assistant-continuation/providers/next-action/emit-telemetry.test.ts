/**
 * VTID-03061 (B0d-real slice Xf.1) — Next-Action OASIS emit tests.
 *
 * Mocks the oasis-event-service so we observe the topics emitted
 * without hitting Supabase. Covers:
 *   - B0d-real winner emits suggested + candidate
 *   - voice-wake-brief winner emits nothing (the next-action layer
 *     wasn't the actor)
 *   - contextual_next_action provider suppressed → suppressed event
 *   - Helpers (isContextualNextActionContinuation, pickSourceEvidence,
 *     pickReasonEvidence)
 *   - Emitter NEVER throws upward — even on bad input
 */

import {
  emitNextActionDecisionTelemetry,
  isContextualNextActionContinuation,
  pickSourceEvidence,
  pickReasonEvidence,
} from '../../../../../src/services/assistant-continuation/providers/next-action/emit-telemetry';
import type {
  AssistantContinuation,
  AssistantContinuationDecision,
  ProviderResult,
} from '../../../../../src/services/assistant-continuation/types';

// ---------------------------------------------------------------------------
// Mock the OASIS event service so we observe topics rather than emit them.
// ---------------------------------------------------------------------------

const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];

jest.mock('../../../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (event: { type: string; payload: Record<string, unknown> }) => {
    emitted.push({ type: event.type, payload: event.payload });
    return { ok: true };
  }),
}));

beforeEach(() => {
  emitted.length = 0;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeB0dRealWinner(): AssistantContinuation {
  return {
    id: 'next-action-1',
    surface: 'orb_wake',
    kind: 'next_step',
    priority: 90,
    userFacingLine: 'Your magnesium reminder is due in 28 minutes.',
    cta: { type: 'ask_permission', payload: { reminder_id: 'r-1' } },
    evidence: [
      { kind: 'source:reminder_due', detail: 'priority=85 confidence=high', weight: 1 },
      { kind: 'reminder_due_within_horizon', detail: '28 min until "magnesium"' },
    ],
    dedupeKey: 'reminder_due:r-1',
    privacyMode: 'safe_to_speak',
  };
}

function makeVoiceWakeBriefWinner(): AssistantContinuation {
  return {
    id: 'wake-brief-1',
    surface: 'orb_wake',
    kind: 'wake_brief',
    priority: 80,
    userFacingLine: 'Hello! How can I help today?',
    cta: { type: 'explain' },
    // CRITICAL: voice-wake-brief evidence uses `kind: 'greeting_policy'`,
    // NOT 'source:*'. That's how the emitter distinguishes B0d-real
    // winners from B0d-mini fallbacks.
    evidence: [{ kind: 'greeting_policy', detail: 'fresh_intro' }],
    dedupeKey: 'wake-brief-fresh_intro',
    privacyMode: 'safe_to_speak',
  };
}

function makeDecision(opts: {
  winner: AssistantContinuation | null;
  providerStatus?: ProviderResult['status'];
  reason?: string;
}): AssistantContinuationDecision {
  const providerResult: ProviderResult = opts.winner
    ? {
        providerKey: 'contextual_next_action',
        status: 'returned',
        latencyMs: 12,
        candidate: opts.winner,
      }
    : {
        providerKey: 'contextual_next_action',
        status: opts.providerStatus ?? 'suppressed',
        latencyMs: 8,
        reason: opts.reason ?? 'no_chosen_candidate',
      };
  return {
    decisionId: 'd-test',
    selectedContinuation: opts.winner,
    decisionStartedAt: '2026-05-18T08:00:00Z',
    decisionFinishedAt: '2026-05-18T08:00:01Z',
    sourceProviderResults: [providerResult],
    telemetryContext: {
      sessionId: 's1',
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_wake',
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('isContextualNextActionContinuation', () => {
  test('returns true for evidence kinds starting with "source:"', () => {
    expect(isContextualNextActionContinuation(makeB0dRealWinner())).toBe(true);
  });
  test('returns false for voice-wake-brief evidence (no "source:" kind)', () => {
    expect(isContextualNextActionContinuation(makeVoiceWakeBriefWinner())).toBe(false);
  });
});

describe('pickSourceEvidence', () => {
  test('returns the source row when present', () => {
    const ev = pickSourceEvidence(makeB0dRealWinner());
    expect(ev).toEqual({
      kind: 'source:reminder_due',
      detail: 'priority=85 confidence=high',
    });
  });
  test('returns null when no source evidence', () => {
    expect(pickSourceEvidence(makeVoiceWakeBriefWinner())).toBeNull();
  });
});

describe('pickReasonEvidence', () => {
  test('drops the source: row + keeps the rest', () => {
    const reasons = pickReasonEvidence(makeB0dRealWinner());
    expect(reasons).toHaveLength(1);
    expect(reasons[0].kind).toBe('reminder_due_within_horizon');
  });
});

// ---------------------------------------------------------------------------
// emitNextActionDecisionTelemetry
// ---------------------------------------------------------------------------

describe('emitNextActionDecisionTelemetry', () => {
  test('B0d-real winner → suggested + candidate emitted', () => {
    const decision = makeDecision({ winner: makeB0dRealWinner() });
    emitNextActionDecisionTelemetry({
      decision,
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_wake',
    });
    // synchronous queueing; the function returns immediately but the
    // mocked emitOasisEvent is sync-ish — flush microtasks.
    return Promise.resolve().then(() => {
      const topics = emitted.map((e) => e.type);
      expect(topics).toContain('orb.livekit.next_action.suggested');
      expect(topics).toContain('orb.livekit.next_action.candidate');
      const suggested = emitted.find((e) => e.type === 'orb.livekit.next_action.suggested');
      expect(suggested?.payload.decision_id).toBe('d-test');
      expect(suggested?.payload.surface).toBe('orb_wake');
      expect((suggested?.payload.source_evidence as { kind: string }).kind).toBe(
        'source:reminder_due',
      );
    });
  });

  test('voice-wake-brief winner → NO suggested emit (next-action layer didnt fire)', () => {
    const decision = makeDecision({ winner: makeVoiceWakeBriefWinner() });
    emitNextActionDecisionTelemetry({
      decision,
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_wake',
    });
    return Promise.resolve().then(() => {
      const topics = emitted.map((e) => e.type);
      expect(topics).not.toContain('orb.livekit.next_action.suggested');
      // Also no suppressed event — the next-action provider wasn't even
      // in the decision (the test fixture above puts contextual_next_action
      // as 'returned', but with a voice-wake-brief winner; that's
      // unrealistic in practice but a valid test of the gate). Either
      // outcome is fine; the assertion focuses on no false-suggested.
    });
  });

  test('contextual_next_action provider suppressed → suppressed emit', () => {
    const decision = makeDecision({
      winner: null,
      providerStatus: 'suppressed',
      reason: 'tied_below_threshold',
    });
    emitNextActionDecisionTelemetry({
      decision,
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_wake',
    });
    return Promise.resolve().then(() => {
      const topics = emitted.map((e) => e.type);
      expect(topics).toContain('orb.livekit.next_action.suppressed');
      const suppressed = emitted.find(
        (e) => e.type === 'orb.livekit.next_action.suppressed',
      );
      expect(suppressed?.payload.provider_status).toBe('suppressed');
      expect(suppressed?.payload.suppress_reason).toBe('tied_below_threshold');
    });
  });

  test('contextual_next_action provider returned-but-not-winner → no suppressed emit', () => {
    // Status 'returned' is handled by the suggested-emit branch only when
    // selectedContinuation matches the next-action shape. If for some
    // reason the framework picked something else, no emit fires.
    const decision = makeDecision({
      winner: null,
      providerStatus: 'returned',
    });
    emitNextActionDecisionTelemetry({
      decision,
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_wake',
    });
    return Promise.resolve().then(() => {
      const topics = emitted.map((e) => e.type);
      expect(topics).not.toContain('orb.livekit.next_action.suggested');
      expect(topics).not.toContain('orb.livekit.next_action.suppressed');
    });
  });

  test('never throws — even with garbage input', () => {
    expect(() =>
      emitNextActionDecisionTelemetry({
        // @ts-expect-error — intentional bad shape
        decision: null,
        userId: 'u1',
        tenantId: 't1',
        surface: 'orb_wake',
      }),
    ).not.toThrow();
  });
});
