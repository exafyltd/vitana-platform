// VTID-01958 — unit tests for the Voice Session Classifier
// (`classifyVoiceSession()`), which combines two signals:
//   1. Topic-based mapping over OASIS error/warning events for the session
//      (via mapTopicToClass — real, unmocked; already covered by
//      test/voice-failure-taxonomy.test.ts, exercised here to lock in the
//      integration).
//   2. Flow-based stall detection from voice-session-analyzer.analyzeSessionEvents
//      — mocked at the module boundary (test/services/voice-session-analyzer.test.ts
//      covers that module directly).
// When multiple signals map to different classes, the highest-severity class
// (CLASS_SEVERITY in voice-failure-taxonomy.ts) wins.
//
// Scope (this file):
//   1. Env/error resilience — fetch throwing, analyzeSessionEvents rejecting,
//      never-throws contract.
//   2. eventToInput mapping — reason/error_message/error/message fallback chain.
//   3. Severity-based arbitration between topic events, stall type, and the
//      audio-one-way residual check — every ordering.
//   4. The "no signal at all" vs "signal present but unmapped" distinction
//      (classifier_no_events vs unknown signature/severity).
//   5. Evidence composition (session_id, triggering_topic/event_id, audio
//      chunk counts, error_count).

jest.mock('../../src/services/voice-session-analyzer', () => ({
  analyzeSessionEvents: jest.fn(),
}));

import { classifyVoiceSession } from '../../src/services/voice-session-classifier';
import { analyzeSessionEvents } from '../../src/services/voice-session-analyzer';
import type { SessionAnalysis } from '../../src/services/voice-session-analyzer';

const mockedFetch = global.fetch as jest.MockedFunction<typeof fetch>;
const mockedAnalyze = analyzeSessionEvents as jest.MockedFunction<typeof analyzeSessionEvents>;

beforeEach(() => {
  mockedFetch.mockReset();
  mockedAnalyze.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventsResponse(rows: Array<Record<string, unknown>>) {
  return { ok: true, status: 200, json: async () => rows } as any;
}

function errorEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    topic: 'orb.live.connection_failed',
    status: 'error',
    message: 'connection failed',
    metadata: {},
    ...overrides,
  };
}

const EMPTY_ANALYSIS: SessionAnalysis = {
  total_events: 0,
  stages_seen: [],
  last_stage: null,
  stall_detected: false,
  stall_type: null,
  stall_description: null,
  flow: {
    greeting_sent: false,
    model_start_speaking: false,
    turn_complete: false,
    input_transcription: false,
    watchdog_fired: false,
    upstream_ws_error: false,
    upstream_ws_close: false,
  },
  suspicious_gaps: [],
  audio_in_chunks: 0,
  audio_out_chunks: 0,
};

function analysisWith(overrides: Partial<SessionAnalysis>): SessionAnalysis {
  return { ...EMPTY_ANALYSIS, ...overrides };
}

function mockAnalysis(overrides: Partial<SessionAnalysis>) {
  mockedAnalyze.mockResolvedValue({ diagnostics: [], analysis: analysisWith(overrides) });
}

// ===========================================================================
// 1. Resilience — never throws, degrades cleanly
// ===========================================================================

describe('classifyVoiceSession — resilience', () => {
  it('never throws when the events fetch itself throws (network failure) — degrades to zero events', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('network down'));
    mockAnalysis({});

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.unknown');
    expect(result.normalized_signature).toBe('classifier_no_events');
    expect(result.evidence.error_count).toBe(0);
  });

  it('never throws when analyzeSessionEvents rejects — degrades to null analysis', async () => {
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockedAnalyze.mockRejectedValueOnce(new Error('analyzer boom'));

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.unknown');
    expect(result.evidence.stall_type).toBeNull();
    expect(result.evidence.stall_description).toBeNull();
    expect(result.evidence.audio_in_chunks).toBe(0);
    expect(result.evidence.audio_out_chunks).toBe(0);
  });

  it('never throws when the events fetch returns non-ok HTTP', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as any);
    mockAnalysis({});

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.unknown');
    expect(result.normalized_signature).toBe('classifier_no_events');
  });
});

// ===========================================================================
// 2. "No signal" vs "signal present but unmapped"
// ===========================================================================

describe('classifyVoiceSession — no-signal vs unmapped-signal distinction', () => {
  it('zero events AND no stall AND no audio-one-way → voice.unknown / classifier_no_events / info', async () => {
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockAnalysis({});

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.unknown');
    expect(result.normalized_signature).toBe('classifier_no_events');
    expect(result.severity).toBe('info');
  });

  it('a present-but-unrecognized topic still produces a "best" (severity 0 beats null) → voice.unknown / unknown / error', async () => {
    // Any non-empty events array always sets `best` on the first iteration
    // (the `!best` check is true even when the mapped severity is 0), so
    // this is a DIFFERENT outcome from the zero-events case above despite
    // both landing on class voice.unknown.
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([errorEventRow({ topic: 'some.unrecognized.topic' })]),
    );
    mockAnalysis({});

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.unknown');
    expect(result.normalized_signature).toBe('unknown');
    expect(result.severity).toBe('error');
    expect(result.evidence.error_count).toBe(1);
  });

  it('an unrecognized (truthy) stall_type suppresses audio-one-way but contributes no class of its own', async () => {
    // detectAudioOneWay bails whenever stall_type is truthy, and
    // mapStallTypeToClass's default case returns null for unknown types —
    // so this stall_type is fully inert, and with no events the result
    // still falls through to classifier_no_events.
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockAnalysis({
      stall_type: 'some_future_stall_type_not_in_the_switch',
      audio_in_chunks: 500,
      audio_out_chunks: 0,
    });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.unknown');
    expect(result.normalized_signature).toBe('classifier_no_events');
    expect(result.evidence.stall_type).toBe('some_future_stall_type_not_in_the_switch');
  });
});

// ===========================================================================
// 3. Topic-based mapping (single event, via the real taxonomy)
// ===========================================================================

describe('classifyVoiceSession — topic-based mapping', () => {
  it('maps a config_missing event through to voice.config_missing with topic/event evidence', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([
        errorEventRow({
          id: 'evt-config',
          topic: 'orb.live.startup.config_missing',
          metadata: { error_message: 'VERTEX_PROJECT_ID is empty' },
        }),
      ]),
    );
    mockAnalysis({});

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.config_missing');
    expect(result.normalized_signature).toBe('vertex_project_id_empty');
    expect(result.severity).toBe('error');
    expect(result.evidence.triggering_topic).toBe('orb.live.startup.config_missing');
    expect(result.evidence.triggering_event_id).toBe('evt-config');
  });

  it('eventToInput falls back metadata.error_message → metadata.error → row.message, in that priority order', async () => {
    // 1. error_message wins when present.
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([
        errorEventRow({
          topic: 'orb.live.connection_failed',
          message: 'irrelevant top-level message',
          metadata: { error_message: 'unauthenticated', error: 'wrong error field' },
        }),
      ]),
    );
    mockAnalysis({});
    let result = await classifyVoiceSession('sess-1');
    expect(result.class).toBe('voice.auth_rejected');
    expect(result.normalized_signature).toBe('auth_unauthenticated');

    // 2. metadata.error used when error_message is absent.
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([
        errorEventRow({
          topic: 'orb.live.connection_failed',
          message: 'irrelevant top-level message',
          metadata: { error: 'permission denied' },
        }),
      ]),
    );
    mockAnalysis({});
    result = await classifyVoiceSession('sess-1');
    expect(result.class).toBe('voice.permission_denied');

    // 3. row.message used when both metadata fields are absent.
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([
        errorEventRow({
          topic: 'orb.live.connection_failed',
          message: 'token expired',
          metadata: {},
        }),
      ]),
    );
    mockAnalysis({});
    result = await classifyVoiceSession('sess-1');
    expect(result.class).toBe('voice.auth_rejected');
    expect(result.normalized_signature).toBe('auth_jwt_expired');
  });

  it('passes http_status and grpc_code through from metadata', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([
        errorEventRow({
          topic: 'orb.live.connection_failed',
          metadata: { http_status: 403 },
        }),
      ]),
    );
    mockAnalysis({});

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.permission_denied');
    expect(result.normalized_signature).toBe('permission_denied_vertex');
  });

  it('picks the highest-severity class across multiple events, not the first or last', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([
        errorEventRow({
          id: 'evt-low',
          topic: 'orb.live.tool_loop_guard_activated', // severity 30
        }),
        errorEventRow({
          id: 'evt-high',
          topic: 'orb.live.startup.config_missing', // severity 100
          metadata: { error_message: 'VERTEX_LOCATION not set' },
        }),
        errorEventRow({
          id: 'evt-mid',
          topic: 'orb.live.fallback_error', // severity 70 (tts_failed)
        }),
      ]),
    );
    mockAnalysis({});

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.config_missing');
    expect(result.evidence.triggering_event_id).toBe('evt-high');
  });

  it('keeps the FIRST event when a later event ties its severity (strictly-greater comparison)', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([
        errorEventRow({
          id: 'evt-first',
          topic: 'orb.live.connection_failed',
          metadata: { http_status: 403 }, // voice.permission_denied, sev 95
        }),
        errorEventRow({
          id: 'evt-second',
          topic: 'orb.live.connection_failed',
          metadata: { grpc_code: 'PERMISSION_DENIED' }, // same class, same severity
        }),
      ]),
    );
    mockAnalysis({});

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.permission_denied');
    expect(result.evidence.triggering_event_id).toBe('evt-first');
  });
});

// ===========================================================================
// 4. Stall-type mapping (signal 2) and its arbitration against topic events
// ===========================================================================

describe('classifyVoiceSession — stall-type mapping and severity arbitration', () => {
  it('a stall_type with no error events at all still classifies (voice.model_stall / severity error)', async () => {
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockAnalysis({
      stall_type: 'watchdog_timeout',
      stall_description: 'Watchdog fired — model stopped responding mid-stream',
    });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.model_stall');
    expect(result.normalized_signature).toBe('model_stall_watchdog');
    expect(result.severity).toBe('error');
    // No triggering event — this came purely from the stall analyzer.
    expect(result.evidence.triggering_topic).toBeUndefined();
    expect(result.evidence.triggering_event_id).toBeUndefined();
    expect(result.evidence.stall_type).toBe('watchdog_timeout');
  });

  it('stall_type (severity 50, model_stall) beats a lower-severity topic event (severity 30, tool_loop)', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([errorEventRow({ topic: 'orb.live.tool_loop_guard_activated' })]),
    );
    mockAnalysis({ stall_type: 'mid_stream_stall' });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.model_stall');
    expect(result.normalized_signature).toBe('mid_stream_stall');
    // The stall-based winner carries no topic/event evidence, even though
    // an event existed — evidence.triggering_topic only gets set when the
    // WINNING signal came from the event loop.
    expect(result.evidence.triggering_topic).toBeUndefined();
  });

  it('a higher-severity topic event (config_missing, 100) beats stall_type (model_stall, 50)', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([
        errorEventRow({
          id: 'evt-cfg',
          topic: 'orb.live.startup.config_missing',
          metadata: { error_message: 'VERTEX_PROJECT_ID is empty' },
        }),
      ]),
    );
    mockAnalysis({ stall_type: 'watchdog_timeout' });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.config_missing');
    expect(result.evidence.triggering_topic).toBe('orb.live.startup.config_missing');
    // Stall evidence is still surfaced even though it didn't win the class.
    expect(result.evidence.stall_type).toBe('watchdog_timeout');
  });

  it('mapStallTypeToClass returning null for an unrecognized stall_type never overrides an existing lower-severity best', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([errorEventRow({ topic: 'orb.live.tool_loop_guard_activated' })]),
    );
    mockAnalysis({ stall_type: 'totally_unrecognized_stall_type' });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.tool_loop');
  });

  it('upstream_disconnect_mid_response stall_type maps to voice.upstream_disconnect', async () => {
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockAnalysis({ stall_type: 'upstream_disconnect_mid_response' });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.upstream_disconnect');
    expect(result.normalized_signature).toBe('upstream_disconnect_mid_response');
  });

  it('no_model_response stall_type maps to voice.model_stall / no_model_response', async () => {
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockAnalysis({ stall_type: 'no_model_response' });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.model_stall');
    expect(result.normalized_signature).toBe('no_model_response');
  });
});

// ===========================================================================
// 5. Audio-one-way residual check (signal 3)
// ===========================================================================

describe('classifyVoiceSession — audio-one-way residual check', () => {
  it('detects audio_one_way when input chunks flowed but no output and no stall', async () => {
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockAnalysis({ audio_in_chunks: 42, audio_out_chunks: 0, stall_type: null });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.audio_one_way');
    expect(result.normalized_signature).toBe('audio_one_way_post_chime');
    expect(result.evidence.audio_in_chunks).toBe(42);
    expect(result.evidence.audio_out_chunks).toBe(0);
  });

  it('does NOT fire audio_one_way when a stall_type is already present, even if the audio pattern matches', async () => {
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockAnalysis({
      audio_in_chunks: 42,
      audio_out_chunks: 0,
      stall_type: 'no_model_response',
    });

    const result = await classifyVoiceSession('sess-1');

    // The stall_type mapping wins (model_stall, severity 50) — the residual
    // audio-one-way check is a no-op here because detectAudioOneWay itself
    // bails whenever stall_type is truthy.
    expect(result.class).toBe('voice.model_stall');
    expect(result.normalized_signature).toBe('no_model_response');
  });

  it('does NOT fire when audio_out_chunks is also non-zero (two-way audio, healthy)', async () => {
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockAnalysis({ audio_in_chunks: 42, audio_out_chunks: 10, stall_type: null });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.unknown');
    expect(result.normalized_signature).toBe('classifier_no_events');
  });

  it('does NOT fire when audio_in_chunks is zero (nothing was ever sent)', async () => {
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockAnalysis({ audio_in_chunks: 0, audio_out_chunks: 0, stall_type: null });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.unknown');
    expect(result.normalized_signature).toBe('classifier_no_events');
  });

  it('audio_one_way (severity 20) beats a lower-severity present-but-unmapped topic event (severity 0)', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([errorEventRow({ topic: 'some.unrecognized.topic' })]),
    );
    mockAnalysis({ audio_in_chunks: 15, audio_out_chunks: 0, stall_type: null });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.audio_one_way');
  });

  it('a topic event of higher severity than audio_one_way (20) still wins', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([errorEventRow({ topic: 'orb.live.tool_loop_guard_activated' })]), // sev 30
    );
    mockAnalysis({ audio_in_chunks: 15, audio_out_chunks: 0, stall_type: null });

    const result = await classifyVoiceSession('sess-1');

    expect(result.class).toBe('voice.tool_loop');
  });
});

// ===========================================================================
// 6. Evidence composition
// ===========================================================================

describe('classifyVoiceSession — evidence composition', () => {
  it('always echoes the input session_id in evidence', async () => {
    mockedFetch.mockResolvedValueOnce(eventsResponse([]));
    mockAnalysis({});

    const result = await classifyVoiceSession('session-xyz-999');

    expect(result.evidence.session_id).toBe('session-xyz-999');
  });

  it('error_count reflects the number of fetched events, independent of which one won', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([
        errorEventRow({ id: 'e1', topic: 'orb.live.tool_loop_guard_activated' }),
        errorEventRow({ id: 'e2', topic: 'orb.live.tool_loop_guard_activated' }),
        errorEventRow({ id: 'e3', topic: 'orb.live.startup.config_missing' }),
      ]),
    );
    mockAnalysis({});

    const result = await classifyVoiceSession('sess-1');

    expect(result.evidence.error_count).toBe(3);
  });

  it('surfaces stall_description alongside the winning topic-based class', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([errorEventRow({ topic: 'orb.live.startup.config_missing' })]),
    );
    mockAnalysis({
      stall_type: 'mid_stream_stall',
      stall_description: 'Model started speaking but never sent turn_complete — audio froze mid-stream',
    });

    const result = await classifyVoiceSession('sess-1');

    expect(result.evidence.stall_description).toBe(
      'Model started speaking but never sent turn_complete — audio froze mid-stream',
    );
  });

  it('audio chunk counts in evidence always come from the analyzer, even when a topic event wins', async () => {
    mockedFetch.mockResolvedValueOnce(
      eventsResponse([errorEventRow({ topic: 'orb.live.startup.config_missing' })]),
    );
    mockAnalysis({ audio_in_chunks: 7, audio_out_chunks: 3 });

    const result = await classifyVoiceSession('sess-1');

    expect(result.evidence.audio_in_chunks).toBe(7);
    expect(result.evidence.audio_out_chunks).toBe(3);
  });
});
