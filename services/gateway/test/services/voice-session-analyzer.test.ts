// VTID-01958 — unit tests for the Voice Session Analyzer
// (`analyzeSessionEvents()` — extracted from the routes/voice-lab.ts
// diagnostics endpoint, now also consumed by the Voice Session Classifier
// during autonomous self-healing dispatch).
//
// Scope (this file):
//   1. Env guard — missing SUPABASE_URL / SUPABASE_SERVICE_ROLE short-circuits
//      to the empty result without calling fetch.
//   2. Query construction — topic/session_id/order/limit + auth headers.
//   3. Non-ok HTTP response degrades to the empty result.
//   4. DiagEvent mapping from raw oasis_events rows.
//   5. stages_seen / last_stage derivation.
//   6. The full stall_type decision tree (every branch + priority ordering
//      between branches, since this classification directly drives
//      self-healing dispatch — misdiagnosis here is high-impact).
//   7. suspicious_gaps computation (boundary at exactly 5000ms).
//   8. audio_in_chunks / audio_out_chunks max-aggregation.
//
// This is a pure "fetch the Supabase REST API directly" service (no
// src/lib/supabase client) — mocked at the module boundary via global.fetch,
// matching test/services/oasis-context-reader.test.ts's convention.

import { analyzeSessionEvents, DiagEvent } from '../../src/services/voice-session-analyzer';

const mockedFetch = global.fetch as jest.MockedFunction<typeof fetch>;

beforeEach(() => {
  mockedFetch.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResponse(events: Array<{ metadata?: Record<string, unknown>; created_at?: string }>) {
  return {
    ok: true,
    status: 200,
    json: async () => events,
  } as any;
}

/** Build a raw oasis_events row (the shape returned by the Supabase REST call). */
function diagRow(
  metadata: Record<string, unknown>,
  created_at = '2026-07-01T00:00:00Z',
): { metadata: Record<string, unknown>; created_at: string } {
  return { metadata, created_at };
}

const EMPTY_FLOW = {
  greeting_sent: false,
  model_start_speaking: false,
  turn_complete: false,
  input_transcription: false,
  watchdog_fired: false,
  upstream_ws_error: false,
  upstream_ws_close: false,
};

// ---------------------------------------------------------------------------
// 1. Env guard
// ---------------------------------------------------------------------------

describe('analyzeSessionEvents — env guard', () => {
  // SUPABASE_URL / SUPABASE_SERVICE_ROLE are read into module-level consts
  // at import time (not per-call), so exercising the guard requires
  // deleting the env var BEFORE the module is (re)required via
  // jest.resetModules() — mutating process.env after the top-level import
  // above has no effect on the already-captured constants.
  it('returns the empty result and never calls fetch when SUPABASE_URL is missing at import time', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    let freshAnalyze: typeof analyzeSessionEvents;
    try {
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      freshAnalyze = require('../../src/services/voice-session-analyzer').analyzeSessionEvents;
    } finally {
      process.env.SUPABASE_URL = prevUrl;
    }

    mockedFetch.mockClear();
    const result = await freshAnalyze('sess-1');

    expect(result.diagnostics).toEqual([]);
    expect(result.analysis.total_events).toBe(0);
    expect(result.analysis.stall_detected).toBe(false);
    expect(result.analysis.flow).toEqual(EMPTY_FLOW);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns the empty result and never calls fetch when SUPABASE_SERVICE_ROLE is missing at import time', async () => {
    const prevKey = process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_SERVICE_ROLE;
    let freshAnalyze: typeof analyzeSessionEvents;
    try {
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      freshAnalyze = require('../../src/services/voice-session-analyzer').analyzeSessionEvents;
    } finally {
      process.env.SUPABASE_SERVICE_ROLE = prevKey;
    }

    mockedFetch.mockClear();
    const result = await freshAnalyze('sess-1');

    expect(result.diagnostics).toEqual([]);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Query construction
// ---------------------------------------------------------------------------

describe('analyzeSessionEvents — query construction', () => {
  it('builds the REST URL with topic, session_id, order, and limit=200', async () => {
    mockedFetch.mockResolvedValueOnce(okResponse([]));

    await analyzeSessionEvents('session-abc-123');

    const [url] = mockedFetch.mock.calls[0];
    const u = String(url);
    expect(u).toContain('/rest/v1/oasis_events');
    expect(u).toContain('topic=eq.orb.live.diag');
    expect(u).toContain('metadata->>session_id=eq.session-abc-123');
    expect(u).toContain('order=created_at.asc');
    expect(u).toContain('limit=200');
  });

  it('sends the service-role apikey and bearer auth headers', async () => {
    mockedFetch.mockResolvedValueOnce(okResponse([]));

    await analyzeSessionEvents('sess-1');

    const [, opts] = mockedFetch.mock.calls[0];
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers.apikey).toBe(process.env.SUPABASE_SERVICE_ROLE);
    expect(headers.Authorization).toBe(`Bearer ${process.env.SUPABASE_SERVICE_ROLE}`);
  });
});

// ---------------------------------------------------------------------------
// 3. Non-ok HTTP response
// ---------------------------------------------------------------------------

describe('analyzeSessionEvents — non-ok HTTP response', () => {
  it('degrades to the empty result when the REST call returns non-ok', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as any);

    const result = await analyzeSessionEvents('sess-1');

    expect(result.diagnostics).toEqual([]);
    expect(result.analysis.total_events).toBe(0);
    expect(result.analysis.stall_detected).toBe(false);
    expect(result.analysis.suspicious_gaps).toEqual([]);
    expect(result.analysis.audio_in_chunks).toBe(0);
    expect(result.analysis.audio_out_chunks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. DiagEvent mapping
// ---------------------------------------------------------------------------

describe('analyzeSessionEvents — DiagEvent mapping', () => {
  it('maps every metadata field onto the DiagEvent shape and carries created_at from the row', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow(
          {
            stage: 'greeting_sent',
            ts: 1000,
            active: true,
            turn_count: 2,
            audio_in: 10,
            audio_out: 5,
            is_model_speaking: true,
            greeting_sent: true,
            consecutive_model_turns: 1,
            has_upstream_ws: true,
            upstream_ws_state: 'open',
            has_sse: true,
            has_watchdog: true,
            reason: 'audio_stall',
            error: 'some error',
            code: 'ERR_X',
            tool_name: 'search',
          },
          '2026-07-01T00:00:01Z',
        ),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');
    const d: DiagEvent = result.diagnostics[0];

    expect(d).toEqual({
      stage: 'greeting_sent',
      ts: 1000,
      created_at: '2026-07-01T00:00:01Z',
      active: true,
      turn_count: 2,
      audio_in: 10,
      audio_out: 5,
      is_model_speaking: true,
      greeting_sent: true,
      consecutive_model_turns: 1,
      has_upstream_ws: true,
      upstream_ws_state: 'open',
      has_sse: true,
      has_watchdog: true,
      reason: 'audio_stall',
      error: 'some error',
      code: 'ERR_X',
      tool_name: 'search',
    });
  });

  it('handles a row with no metadata at all without throwing', async () => {
    mockedFetch.mockResolvedValueOnce(okResponse([{ created_at: '2026-07-01T00:00:01Z' }]));

    const result = await analyzeSessionEvents('sess-1');

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].stage).toBeUndefined();
    expect(result.analysis.total_events).toBe(1);
    expect(result.analysis.stages_seen).toEqual([]);
    expect(result.analysis.last_stage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. stages_seen / last_stage derivation
// ---------------------------------------------------------------------------

describe('analyzeSessionEvents — stages_seen / last_stage', () => {
  it('dedupes stages_seen while preserving first-seen order, but last_stage is the actual last event stage (not deduped)', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent' }),
        diagRow({ stage: 'model_start_speaking' }),
        diagRow({ stage: 'greeting_sent' }), // repeat
        diagRow({ stage: 'turn_complete' }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stages_seen).toEqual([
      'greeting_sent',
      'model_start_speaking',
      'turn_complete',
    ]);
    expect(result.analysis.last_stage).toBe('turn_complete');
    expect(result.analysis.total_events).toBe(4);
  });

  it('last_stage falls back to the last event that HAS a stage, skipping trailing stage-less events', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent' }),
        diagRow({ audio_in: 3 }), // no stage field
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.last_stage).toBe('greeting_sent');
  });

  it('last_stage is null when no event in the session carries a stage', async () => {
    mockedFetch.mockResolvedValueOnce(okResponse([diagRow({ audio_in: 1 }), diagRow({ audio_out: 2 })]));

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.last_stage).toBeNull();
    expect(result.analysis.stages_seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. stall_type decision tree
// ---------------------------------------------------------------------------

describe('analyzeSessionEvents — stall detection: watchdog_timeout', () => {
  it('classifies watchdog_fired as watchdog_timeout regardless of any other stage present', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent' }),
        diagRow({ stage: 'model_start_speaking' }),
        diagRow({ stage: 'watchdog_fired' }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_detected).toBe(true);
    expect(result.analysis.stall_type).toBe('watchdog_timeout');
    expect(result.analysis.stall_description).toBe(
      'Watchdog fired — model stopped responding mid-stream',
    );
  });

  it('watchdog_fired takes priority over upstream_ws_error even when both are present', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent' }),
        diagRow({ stage: 'model_start_speaking' }),
        diagRow({ stage: 'upstream_ws_error' }),
        diagRow({ stage: 'watchdog_fired' }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_type).toBe('watchdog_timeout');
  });
});

describe('analyzeSessionEvents — stall detection: upstream disconnect family', () => {
  it('upstream_ws_error + model started speaking + no turn_complete → upstream_disconnect_mid_response', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent' }),
        diagRow({ stage: 'model_start_speaking' }),
        diagRow({ stage: 'upstream_ws_error' }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_type).toBe('upstream_disconnect_mid_response');
    expect(result.analysis.stall_description).toBe('Upstream WS dropped while model was speaking');
  });

  it('upstream_ws_close (not _error) also triggers the disconnect family', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent' }),
        diagRow({ stage: 'model_start_speaking' }),
        diagRow({ stage: 'upstream_ws_close' }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_type).toBe('upstream_disconnect_mid_response');
  });

  it('upstream_ws_error + greeting sent + model never started → upstream_disconnect_before_response', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([diagRow({ stage: 'greeting_sent' }), diagRow({ stage: 'upstream_ws_error' })]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_type).toBe('upstream_disconnect_before_response');
    expect(result.analysis.stall_description).toBe(
      'Upstream WS dropped before model started speaking',
    );
  });

  it('upstream_ws_error with turn_complete already seen (clean end, late WS close) → generic upstream_disconnect', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent' }),
        diagRow({ stage: 'model_start_speaking' }),
        diagRow({ stage: 'turn_complete' }),
        diagRow({ stage: 'upstream_ws_error' }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_type).toBe('upstream_disconnect');
    expect(result.analysis.stall_description).toBe('Upstream WebSocket disconnected');
  });

  it('upstream_ws_error with neither greeting nor model_start_speaking → generic upstream_disconnect', async () => {
    mockedFetch.mockResolvedValueOnce(okResponse([diagRow({ stage: 'upstream_ws_error' })]));

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_type).toBe('upstream_disconnect');
  });

  it('a WS error still wins over the mid_stream_stall branch (ws-error checked first)', async () => {
    // greeting + model_start + no turn_complete would otherwise be mid_stream_stall,
    // but the ws-error branch is checked earlier in the if/else-if chain.
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent' }),
        diagRow({ stage: 'model_start_speaking' }),
        diagRow({ stage: 'upstream_ws_close' }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_type).toBe('upstream_disconnect_mid_response');
  });
});

describe('analyzeSessionEvents — stall detection: mid_stream_stall', () => {
  it('greeting sent + model started speaking + no turn_complete + no ws error → mid_stream_stall', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([diagRow({ stage: 'greeting_sent' }), diagRow({ stage: 'model_start_speaking' })]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_type).toBe('mid_stream_stall');
    expect(result.analysis.stall_description).toBe(
      'Model started speaking but never sent turn_complete — audio froze mid-stream',
    );
  });

  it('is NOT reported once turn_complete also appears (the session actually finished)', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent' }),
        diagRow({ stage: 'model_start_speaking' }),
        diagRow({ stage: 'turn_complete' }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_detected).toBe(false);
    expect(result.analysis.stall_type).toBeNull();
  });
});

describe('analyzeSessionEvents — stall detection: no_model_response', () => {
  it('greeting sent but model never started speaking → no_model_response', async () => {
    mockedFetch.mockResolvedValueOnce(okResponse([diagRow({ stage: 'greeting_sent' })]));

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_type).toBe('no_model_response');
    expect(result.analysis.stall_description).toBe(
      'Greeting sent but model never started speaking',
    );
  });
});

describe('analyzeSessionEvents — no stall / ambiguous or incomplete signals', () => {
  it('no events at all → no stall (nothing to classify), all flow flags false', async () => {
    mockedFetch.mockResolvedValueOnce(okResponse([]));

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_detected).toBe(false);
    expect(result.analysis.stall_type).toBeNull();
    expect(result.analysis.stall_description).toBeNull();
    expect(result.analysis.flow).toEqual(EMPTY_FLOW);
  });

  it('model_start_speaking with no greeting_sent at all → ambiguous, no branch matches, no stall reported', async () => {
    // Every stall branch that could fire off model_start_speaking requires
    // hasGreeting too — a model speaking without a recorded greeting stage
    // falls through every condition.
    mockedFetch.mockResolvedValueOnce(okResponse([diagRow({ stage: 'model_start_speaking' })]));

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_detected).toBe(false);
    expect(result.analysis.stall_type).toBeNull();
    expect(result.analysis.flow.model_start_speaking).toBe(true);
    expect(result.analysis.flow.greeting_sent).toBe(false);
  });

  it('only input_transcription and turn_complete, no greeting → no stall (input-only conversation fragment)', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([diagRow({ stage: 'input_transcription' }), diagRow({ stage: 'turn_complete' })]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.stall_detected).toBe(false);
    expect(result.analysis.flow.input_transcription).toBe(true);
    expect(result.analysis.flow.turn_complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. suspicious_gaps
// ---------------------------------------------------------------------------

describe('analyzeSessionEvents — suspicious_gaps', () => {
  it('records a gap strictly greater than 5000ms between consecutive events', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent', ts: 1000 }),
        diagRow({ stage: 'model_start_speaking', ts: 1000 + 5001 }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.suspicious_gaps).toEqual([
      { from: 'greeting_sent', to: 'model_start_speaking', gap_ms: 5001 },
    ]);
  });

  it('does NOT record a gap of exactly 5000ms (boundary is exclusive)', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent', ts: 1000 }),
        diagRow({ stage: 'model_start_speaking', ts: 1000 + 5000 }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.suspicious_gaps).toEqual([]);
  });

  it('does not record a gap when either side is missing a ts', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent' }), // no ts
        diagRow({ stage: 'model_start_speaking', ts: 999999 }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.suspicious_gaps).toEqual([]);
  });

  it('uses "?" as the stage label when a gap-bounding event has no stage', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([diagRow({ ts: 1000 }), diagRow({ stage: 'turn_complete', ts: 20000 })]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.suspicious_gaps).toEqual([
      { from: '?', to: 'turn_complete', gap_ms: 19000 },
    ]);
  });

  it('collects multiple gaps across a session, in order', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ stage: 'greeting_sent', ts: 0 }),
        diagRow({ stage: 'model_start_speaking', ts: 6000 }), // gap 1: 6000
        diagRow({ stage: 'turn_complete', ts: 6100 }), // no gap
        diagRow({ stage: 'input_transcription', ts: 20000 }), // gap 2: 13900
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.suspicious_gaps).toEqual([
      { from: 'greeting_sent', to: 'model_start_speaking', gap_ms: 6000 },
      { from: 'turn_complete', to: 'input_transcription', gap_ms: 13900 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8. audio_in_chunks / audio_out_chunks aggregation
// ---------------------------------------------------------------------------

describe('analyzeSessionEvents — audio chunk aggregation', () => {
  it('reports the max audio_in / audio_out seen across all events, not the sum or the last value', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([
        diagRow({ audio_in: 5, audio_out: 2 }),
        diagRow({ audio_in: 40, audio_out: 30 }),
        diagRow({ audio_in: 12, audio_out: 55 }),
      ]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.audio_in_chunks).toBe(40);
    expect(result.analysis.audio_out_chunks).toBe(55);
  });

  it('ignores events missing audio_in/audio_out and defaults to 0 when none are numeric', async () => {
    mockedFetch.mockResolvedValueOnce(
      okResponse([diagRow({ stage: 'greeting_sent' }), diagRow({ stage: 'turn_complete' })]),
    );

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.audio_in_chunks).toBe(0);
    expect(result.analysis.audio_out_chunks).toBe(0);
  });

  it('a single event with only audio_in set still yields audio_out_chunks=0', async () => {
    mockedFetch.mockResolvedValueOnce(okResponse([diagRow({ audio_in: 77 })]));

    const result = await analyzeSessionEvents('sess-1');

    expect(result.analysis.audio_in_chunks).toBe(77);
    expect(result.analysis.audio_out_chunks).toBe(0);
  });
});
