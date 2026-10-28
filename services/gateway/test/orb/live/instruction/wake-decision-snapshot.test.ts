/**
 * VTID-03210 — Turn-1 wake-decision observability snapshot tests.
 *
 * The snapshot is the smallest-drift first step of the ORB communication
 * reconciliation: it makes the turn-1 state machine observable without
 * changing any spoken behavior. These tests lock the builder's contract:
 *   - winner mapping (provider key via dedupeKey, source kind, line chars)
 *   - none/suppression path
 *   - turn1_collision when ≥2 turn-1 blocks co-present (the documented
 *     Vertex drift hazard)
 *   - firstName presence/source/len passthrough
 *   - provider-result passthrough (suppressed/errored rows kept)
 *   - Vertex/LiveKit parity: identical builder, identical shape
 */

import {
  buildWakeDecisionSnapshot,
  logWakeDecisionSnapshot,
  type WakeDecisionSnapshotInput,
} from '../../../../src/orb/live/instruction/wake-decision-snapshot';
import type {
  AssistantContinuationDecision,
  AssistantContinuation,
  ProviderResult,
} from '../../../../src/services/assistant-continuation/types';

function makeWinner(
  overrides: Partial<AssistantContinuation> = {},
): AssistantContinuation {
  return {
    id: 'c1',
    kind: 'feature_discovery',
    userFacingLine: 'Welcome back, Dragan. May I show you something new?',
    cta: { label: '', toolName: null, payload: {} } as never,
    evidence: [{ kind: 'source:feature_discovery_teacher', detail: 'cap=life_compass' } as never],
    dedupeKey: 'teacher:life_compass',
  } as AssistantContinuation as never;
}

function makeDecision(
  overrides: Partial<AssistantContinuationDecision> = {},
): AssistantContinuationDecision {
  const winner = makeWinner();
  const providerResults: ProviderResult[] = [
    { providerKey: 'contextual_next_action', status: 'suppressed', latencyMs: 12, reason: 'no_chosen_candidate' },
    { providerKey: 'new_day_return', status: 'suppressed', latencyMs: 8, reason: 'same_day_recent' },
    { providerKey: 'feature_discovery_teacher', status: 'returned', latencyMs: 21, candidate: winner },
    { providerKey: 'voice_wake_brief', status: 'returned', latencyMs: 3, candidate: makeWinner({ dedupeKey: 'wake:warm', kind: 'wake_brief' } as never) },
  ];
  return {
    decisionId: 'dec-123',
    selectedContinuation: winner,
    decisionStartedAt: '2026-05-31T08:00:00.000Z',
    decisionFinishedAt: '2026-05-31T08:00:00.050Z',
    sourceProviderResults: providerResults,
    telemetryContext: { surface: 'orb_wake' },
    ...overrides,
  };
}

const BASE: WakeDecisionSnapshotInput = {
  transport: 'vertex',
  sessionId: 'sess-1',
  decision: makeDecision(),
  blocks: { wakeBriefOverride: true, teacherModeContent: true, journeyGreeting: false },
  firstName: { value: 'Dragan', source: 'memory_facts' },
  lang: 'de',
  bucket: 'returning',
  isReconnect: false,
  timezonePresent: true,
};

describe('buildWakeDecisionSnapshot', () => {
  it('maps the winner to its provider key via dedupeKey + derives source kind', () => {
    const snap = buildWakeDecisionSnapshot(BASE);
    expect(snap.winner).not.toBeNull();
    expect(snap.winner!.provider_key).toBe('feature_discovery_teacher');
    expect(snap.winner!.kind).toBe('feature_discovery');
    expect(snap.winner!.source_kind).toBe('source:feature_discovery_teacher');
    expect(snap.winner!.dedupe_key).toBe('teacher:life_compass');
    expect(snap.winner!.line_present).toBe(true);
    expect(snap.winner!.line_chars).toBeGreaterThan(0);
    expect(snap.suppression_reason).toBeNull();
    expect(snap.decision_id).toBe('dec-123');
  });

  it('flags turn1_collision when ≥2 turn-1 blocks are present', () => {
    const snap = buildWakeDecisionSnapshot(BASE); // override + teacher
    expect(snap.turn1_block_count).toBe(2);
    expect(snap.turn1_collision).toBe(true);
  });

  it('does not flag collision when only one turn-1 block is present', () => {
    const snap = buildWakeDecisionSnapshot({
      ...BASE,
      blocks: { wakeBriefOverride: true, teacherModeContent: false, journeyGreeting: false },
    });
    expect(snap.turn1_block_count).toBe(1);
    expect(snap.turn1_collision).toBe(false);
  });

  it('flags the worst-case 3-block collision', () => {
    const snap = buildWakeDecisionSnapshot({
      ...BASE,
      blocks: { wakeBriefOverride: true, teacherModeContent: true, journeyGreeting: true },
    });
    expect(snap.turn1_block_count).toBe(3);
    expect(snap.turn1_collision).toBe(true);
  });

  it('passes every provider result through, including suppressed/errored rows', () => {
    const snap = buildWakeDecisionSnapshot(BASE);
    expect(snap.providers).toHaveLength(4);
    const byKey = Object.fromEntries(snap.providers.map((p) => [p.key, p]));
    expect(byKey.contextual_next_action.status).toBe('suppressed');
    expect(byKey.contextual_next_action.reason).toBe('no_chosen_candidate');
    expect(byKey.new_day_return.reason).toBe('same_day_recent');
  });

  it('reports the no-winner suppression path', () => {
    const snap = buildWakeDecisionSnapshot({
      ...BASE,
      decision: makeDecision({ selectedContinuation: null, suppressionReason: 'all_providers_suppressed' }),
    });
    expect(snap.winner).toBeNull();
    expect(snap.suppression_reason).toBe('all_providers_suppressed');
  });

  it('treats a none_with_reason candidate as no winner and surfaces its reason', () => {
    const none = {
      id: 'none-x',
      kind: 'none_with_reason',
      userFacingLine: '',
      cta: { label: '', toolName: null, payload: {} },
      evidence: [],
      dedupeKey: 'none-x',
      suppressReason: 'cadence_skip',
    } as unknown as AssistantContinuation;
    const snap = buildWakeDecisionSnapshot({
      ...BASE,
      decision: makeDecision({ selectedContinuation: none, suppressionReason: undefined }),
    });
    expect(snap.winner).toBeNull();
    expect(snap.suppression_reason).toBe('cadence_skip');
  });

  it('passes firstName presence/source/len through', () => {
    const snap = buildWakeDecisionSnapshot(BASE);
    expect(snap.first_name).toEqual({ present: true, source: 'memory_facts', len: 6 });

    const none = buildWakeDecisionSnapshot({
      ...BASE,
      firstName: { value: null, source: 'none' },
    });
    expect(none.first_name).toEqual({ present: false, source: 'none', len: 0 });
  });

  it('handles a null decision (decision threw) without crashing', () => {
    const snap = buildWakeDecisionSnapshot({ ...BASE, decision: null });
    expect(snap.winner).toBeNull();
    expect(snap.decision_id).toBeNull();
    expect(snap.providers).toEqual([]);
  });

  it('produces a structurally identical shape on both transports (parity)', () => {
    const vertex = buildWakeDecisionSnapshot({ ...BASE, transport: 'vertex' });
    const livekit = buildWakeDecisionSnapshot({ ...BASE, transport: 'livekit' });
    expect(Object.keys(vertex).sort()).toEqual(Object.keys(livekit).sort());
    expect(vertex.transport).toBe('vertex');
    expect(livekit.transport).toBe('livekit');
    // Same decision in → same winner/collision out regardless of transport.
    expect(vertex.winner).toEqual(livekit.winner);
    expect(vertex.turn1_collision).toEqual(livekit.turn1_collision);
  });
});

describe('logWakeDecisionSnapshot', () => {
  it('emits exactly one [wake-decision] line of valid JSON and returns the snapshot', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const snap = logWakeDecisionSnapshot(BASE);
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0] as string;
      expect(arg.startsWith('[wake-decision] ')).toBe(true);
      const parsed = JSON.parse(arg.slice('[wake-decision] '.length));
      expect(parsed.tag).toBe('wake_decision');
      expect(parsed).toEqual(snap);
    } finally {
      spy.mockRestore();
    }
  });
});
