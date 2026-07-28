// VTID-01179 — unit tests for the autopilot loop persistence layer
// (autopilot-loop-store.ts). This is a thin Supabase REST wrapper: every
// exported function builds a request via the shared `supabaseRequest()`
// helper and interprets its `{ ok, data, error }` result. These tests drive
// `global.fetch` directly (as the module does) rather than mocking a
// Supabase SDK client.
//
// Scope:
//   1. Loop state operations (get/set running/cursor/error/stats)
//   2. Processed-events dedup operations (idempotency ledger)
//   3. Run state operations (get/upsert/update/transition)
//   4. Locking / backoff — the concurrency-safety-relevant surface:
//      acquireRunLock's RPC-atomic path vs. its non-atomic direct-update
//      fallback, isRunLocked, releaseRunLock, setBackoffLock.
//   5. Attempt counters and terminal-state helpers (markRunFailed/Completed).

import {
  getLoopState,
  setLoopRunning,
  updateLoopCursor,
  resetLoopCursor,
  incrementProcessedCount,
  recordLoopError,
  getLoopStats,
  isEventProcessed,
  recordProcessedEvent,
  getProcessedEventHistory,
  getRunState,
  upsertRunState,
  updateRunState,
  transitionRunState,
  isRunLocked,
  acquireRunLock,
  releaseRunLock,
  incrementActionAttempt,
  canAttemptAction,
  setBackoffLock,
  getActiveRuns,
  markRunFailed,
  markRunCompleted,
  type RunState,
  type LoopState,
} from '../../src/services/autopilot-loop-store';

const mockFetch = global.fetch as jest.Mock;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, text = 'boom') {
  return {
    ok: false,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => text,
  };
}

function lastCall() {
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  const [url, options] = call;
  return {
    url: String(url),
    method: options?.method,
    headers: options?.headers as Record<string, string> | undefined,
    body: options?.body ? JSON.parse(options.body) : undefined,
  };
}

function callAt(index: number) {
  const call = mockFetch.mock.calls[index];
  const [url, options] = call;
  return {
    url: String(url),
    method: options?.method,
    headers: options?.headers as Record<string, string> | undefined,
    body: options?.body ? JSON.parse(options.body) : undefined,
  };
}

function baseRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    vtid: 'VTID-01179',
    state: 'building',
    run_id: 'run-1',
    started_at: '2026-07-01T00:00:00Z',
    last_transition_at: '2026-07-01T00:00:00Z',
    completed_at: null,
    last_event_id: null,
    last_event_type: null,
    pr_number: null,
    pr_url: null,
    merge_sha: null,
    attempts: { dispatch: 0, create_pr: 0, validate: 0, merge: 0, verify: 0 },
    max_attempts: 3,
    lock_until: null,
    locked_by: null,
    validator_passed: null,
    validator_result: null,
    verification_passed: null,
    verification_result: null,
    error: null,
    error_code: null,
    error_at: null,
    spec_checksum: null,
    metadata: {},
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
});

// ---------------------------------------------------------------------------
// Missing credentials — shared short-circuit
// ---------------------------------------------------------------------------

describe('missing Supabase credentials', () => {
  it('short-circuits without calling fetch when SUPABASE_URL is unset', async () => {
    delete process.env.SUPABASE_URL;

    const result = await getLoopState();

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('short-circuits without calling fetch when SUPABASE_SERVICE_ROLE is unset', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE;

    const ok = await setLoopRunning(true);

    expect(ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Loop state operations
// ---------------------------------------------------------------------------

describe('getLoopState', () => {
  it('returns the first row when the query succeeds with data', async () => {
    const row = { id: 'gateway', is_running: true } as LoopState;
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [row]));

    const result = await getLoopState();

    expect(result).toEqual(row);
    expect(lastCall().url).toContain('/rest/v1/autopilot_loop_state?id=eq.gateway&select=*');
  });

  it('returns null when the query succeeds but returns no rows', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    expect(await getLoopState()).toBeNull();
  });

  it('returns null when the query fails', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500));
    expect(await getLoopState()).toBeNull();
  });
});

describe('setLoopRunning', () => {
  it('sets is_running=true and stamps started_at (not stopped_at)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    const ok = await setLoopRunning(true);

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.method).toBe('PATCH');
    expect(call.url).toContain('/rest/v1/autopilot_loop_state?id=eq.gateway');
    expect(call.body.is_running).toBe(true);
    expect(call.body.started_at).toBeDefined();
    expect(call.body.stopped_at).toBeUndefined();
  });

  it('sets is_running=false and stamps stopped_at (not started_at)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    await setLoopRunning(false);

    const call = lastCall();
    expect(call.body.is_running).toBe(false);
    expect(call.body.stopped_at).toBeDefined();
    expect(call.body.started_at).toBeUndefined();
  });

  it('propagates failure', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500));
    expect(await setLoopRunning(true)).toBe(false);
  });
});

describe('updateLoopCursor', () => {
  it('PATCHes cursor + timestamp fields', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    const ok = await updateLoopCursor('evt-123', '2026-07-01T00:00:00Z');

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.method).toBe('PATCH');
    expect(call.body.last_event_cursor).toBe('evt-123');
    expect(call.body.last_event_timestamp).toBe('2026-07-01T00:00:00Z');
  });
});

describe('resetLoopCursor', () => {
  it('generates a reset-<timestamp> cursor sentinel and sets the target timestamp', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    const ok = await resetLoopCursor('2026-06-01T00:00:00Z');

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.body.last_event_cursor).toMatch(/^reset-\d+$/);
    expect(call.body.last_event_timestamp).toBe('2026-06-01T00:00:00Z');
  });

  it('returns false and does not throw when the PATCH fails', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500));
    expect(await resetLoopCursor('2026-06-01T00:00:00Z', 'catch-up')).toBe(false);
  });
});

describe('incrementProcessedCount', () => {
  it('sends a minimal-return PATCH and reports success', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    const ok = await incrementProcessedCount(5);

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.method).toBe('PATCH');
    expect(call.headers?.Prefer).toBe('return=minimal');
  });
});

describe('recordLoopError', () => {
  it('stamps last_error and last_error_at', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    const ok = await recordLoopError('poll failed: ECONNRESET');

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.body.last_error).toBe('poll failed: ECONNRESET');
    expect(call.body.last_error_at).toBeDefined();
  });
});

describe('getLoopStats', () => {
  it('returns the RPC result directly when the RPC succeeds with data', async () => {
    const stats = { is_running: true, active_runs: 4 };
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [stats]));

    const result = await getLoopStats();

    expect(result).toEqual(stats);
    expect(lastCall().url).toContain('/rest/v1/rpc/get_autopilot_loop_stats');
    expect(lastCall().body).toEqual({ p_loop_id: 'gateway' });
  });

  it('falls back to a derived stats object from getLoopState when the RPC fails', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404)); // RPC not found
    const loopStateRow: LoopState = {
      id: 'gateway',
      environment: 'test',
      last_event_cursor: 'evt-9',
      last_event_timestamp: '2026-07-01T00:00:00Z',
      is_running: true,
      started_at: '2026-07-01T00:00:00Z',
      stopped_at: null,
      poll_interval_ms: 30000,
      batch_size: 10,
      events_processed_total: 42,
      events_processed_1h: 3,
      errors_1h: 0,
      last_error: null,
      last_error_at: null,
      updated_at: '2026-07-01T00:00:00Z',
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [loopStateRow]));

    const result = await getLoopStats();

    expect(result).toEqual({
      is_running: true,
      poll_interval_ms: 30000,
      last_cursor: 'evt-9',
      last_event_timestamp: '2026-07-01T00:00:00Z',
      events_processed_total: 42,
      processed_1h: 3,
      errors_1h: 0,
      active_runs: 0,
      runs_by_state: {},
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('falls back and returns null when the RPC fails AND no loop state row exists', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));

    expect(await getLoopStats()).toBeNull();
  });

  it('falls back when the RPC succeeds but returns an empty array', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));

    expect(await getLoopStats()).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Processed events (idempotency / dedup ledger)
// ---------------------------------------------------------------------------

describe('isEventProcessed', () => {
  it('returns true when a matching row exists', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [{ event_id: 'evt-1' }]));
    expect(await isEventProcessed('evt-1')).toBe(true);
    expect(lastCall().url).toContain('event_id=eq.evt-1');
  });

  it('returns false when no matching row exists', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    expect(await isEventProcessed('evt-1')).toBe(false);
  });

  it('returns false (fail-safe, not throw) when the query errors', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500));
    expect(await isEventProcessed('evt-1')).toBe(false);
  });

  it('URL-encodes the event id', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await isEventProcessed('evt with spaces/slash');
    expect(lastCall().url).toContain(encodeURIComponent('evt with spaces/slash'));
  });
});

describe('recordProcessedEvent', () => {
  it('defaults optional fields to null and uses ignore-duplicates resolution', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    const ok = await recordProcessedEvent({
      event_id: 'evt-1',
      event_type: 'vtid.lifecycle.completed',
      result: { foo: 'bar' },
    });

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.headers?.Prefer).toBe('resolution=ignore-duplicates,return=minimal');
    expect(call.body).toMatchObject({
      event_id: 'evt-1',
      vtid: null,
      event_type: 'vtid.lifecycle.completed',
      event_timestamp: null,
      action_triggered: null,
      transition_from: null,
      transition_to: null,
      error: null,
      raw_event: null,
    });
    expect(call.body.processed_at).toBeDefined();
  });

  it('passes through all provided optional fields', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    await recordProcessedEvent({
      event_id: 'evt-2',
      vtid: 'VTID-01179',
      event_type: 'vtid.state.merged',
      event_timestamp: '2026-07-01T00:00:00Z',
      result: {},
      action_triggered: 'merge',
      transition_from: 'validated',
      transition_to: 'merged',
      error: 'none',
      raw_event: { a: 1 },
    });

    const call = lastCall();
    expect(call.body).toMatchObject({
      vtid: 'VTID-01179',
      action_triggered: 'merge',
      transition_from: 'validated',
      transition_to: 'merged',
      error: 'none',
      raw_event: { a: 1 },
    });
  });
});

describe('getProcessedEventHistory', () => {
  it('defaults to limit=100', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await getProcessedEventHistory();
    expect(lastCall().url).toContain('limit=100');
  });

  it('honors a custom limit', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    await getProcessedEventHistory(5);
    expect(lastCall().url).toContain('limit=5');
  });

  it('returns [] (not throw) on query failure', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500));
    expect(await getProcessedEventHistory()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Run state operations
// ---------------------------------------------------------------------------

describe('getRunState', () => {
  it('returns the first matching row', async () => {
    const row = baseRunState();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [row]));

    const result = await getRunState('VTID-01179');

    expect(result).toEqual(row);
    expect(lastCall().url).toContain('vtid=eq.VTID-01179');
  });

  it('returns null when no run exists for the VTID', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    expect(await getRunState('VTID-99999')).toBeNull();
  });
});

describe('upsertRunState', () => {
  it('POSTs with merge-duplicates resolution and stamps updated_at', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    const ok = await upsertRunState('VTID-01179', { state: 'building' });

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.headers?.Prefer).toBe('resolution=merge-duplicates,return=minimal');
    expect(call.body.vtid).toBe('VTID-01179');
    expect(call.body.state).toBe('building');
    expect(call.body.updated_at).toBeDefined();
  });
});

describe('updateRunState', () => {
  it('PATCHes the run scoped by vtid and stamps updated_at', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    const ok = await updateRunState('VTID-01179', { pr_number: 42 });

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.method).toBe('PATCH');
    expect(call.url).toContain('vtid=eq.VTID-01179');
    expect(call.body.pr_number).toBe(42);
    expect(call.body.updated_at).toBeDefined();
  });
});

describe('transitionRunState', () => {
  it('does not stamp completed_at for a non-terminal target state', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    const ok = await transitionRunState('VTID-01179', 'building', 'evt-1', 'vtid.state.building');

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.body.state).toBe('building');
    expect(call.body.last_event_id).toBe('evt-1');
    expect(call.body.last_event_type).toBe('vtid.state.building');
    expect(call.body.completed_at).toBeUndefined();
  });

  it('stamps completed_at when transitioning to completed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));
    await transitionRunState('VTID-01179', 'completed', 'evt-2', 'vtid.state.completed');
    expect(lastCall().body.completed_at).toBeDefined();
  });

  it('stamps completed_at when transitioning to failed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));
    await transitionRunState('VTID-01179', 'failed', 'evt-3', 'vtid.state.failed');
    expect(lastCall().body.completed_at).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Locking (concurrency-safety surface) — VTID governance §5:
// "One VTID at a time per worker (no parallel execution)"
// ---------------------------------------------------------------------------

describe('isRunLocked', () => {
  it('returns false when there is no run state', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    expect(await isRunLocked('VTID-01179')).toBe(false);
  });

  it('returns false when lock_until is null', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [baseRunState({ lock_until: null })]));
    expect(await isRunLocked('VTID-01179')).toBe(false);
  });

  it('returns true when lock_until is in the future', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [baseRunState({ lock_until: future })]));
    expect(await isRunLocked('VTID-01179')).toBe(true);
  });

  it('returns false when lock_until is in the past (expired lock)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [baseRunState({ lock_until: past })]));
    expect(await isRunLocked('VTID-01179')).toBe(false);
  });
});

describe('acquireRunLock — RPC (atomic) path', () => {
  it('returns true and sends p_vtid/p_locked_by/p_lock_duration_ms (default 30000ms) when the RPC grants the lock', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [{ acquire_autopilot_run_lock: true }]));

    const ok = await acquireRunLock('VTID-01179', 'worker-a');

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = lastCall();
    expect(call.url).toContain('/rest/v1/rpc/acquire_autopilot_run_lock');
    expect(call.body).toEqual({ p_vtid: 'VTID-01179', p_locked_by: 'worker-a', p_lock_duration_ms: 30000 });
  });

  it('honors a custom lock duration', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [{ acquire_autopilot_run_lock: true }]));
    await acquireRunLock('VTID-01179', 'worker-a', 5000);
    expect(lastCall().body.p_lock_duration_ms).toBe(5000);
  });

  it('returns false when the RPC explicitly denies the lock (already held elsewhere)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [{ acquire_autopilot_run_lock: false }]));
    expect(await acquireRunLock('VTID-01179', 'worker-a')).toBe(false);
  });

  it('returns false without a second call when the RPC succeeds but returns no rows', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    expect(await acquireRunLock('VTID-01179', 'worker-a')).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('acquireRunLock — direct-update fallback (non-atomic, single-writer assumption)', () => {
  it('falls back to a direct read-then-write when the RPC is unavailable, and succeeds when unlocked', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404)); // RPC missing
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [baseRunState({ lock_until: null })])); // getRunState
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null)); // updateRunState (PATCH)

    const ok = await acquireRunLock('VTID-01179', 'worker-a', 15000);

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const patchCall = callAt(2);
    expect(patchCall.method).toBe('PATCH');
    expect(patchCall.body.locked_by).toBe('worker-a');
    expect(patchCall.body.lock_until).toBeDefined();
  });

  it('does NOT write a new lock when the fallback finds the run already locked (respects single-writer invariant)', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404));
    const future = new Date(Date.now() + 60_000).toISOString();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, [baseRunState({ lock_until: future, locked_by: 'worker-b' })])
    );

    const ok = await acquireRunLock('VTID-01179', 'worker-a');

    expect(ok).toBe(false);
    // Only the failed RPC + the read — no write attempted while another
    // worker's lock is still valid.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns false when the fallback finds no run state at all', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));

    expect(await acquireRunLock('VTID-01179', 'worker-a')).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('acquires the fallback lock when a previous lock has expired', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404));
    const past = new Date(Date.now() - 60_000).toISOString();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [baseRunState({ lock_until: past })]));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    expect(await acquireRunLock('VTID-01179', 'worker-a')).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('releaseRunLock', () => {
  it('clears both lock_until and locked_by', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    const ok = await releaseRunLock('VTID-01179', 'worker-a');

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.method).toBe('PATCH');
    expect(call.body.lock_until).toBeNull();
    expect(call.body.locked_by).toBeNull();
  });
});

describe('setBackoffLock (exponential backoff)', () => {
  const FIXED_NOW = 1_800_000_000_000; // arbitrary fixed epoch ms

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses base delay (2000ms) for attempt 1', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));
    await setBackoffLock('VTID-01179', 1);
    const call = lastCall();
    expect(call.body.lock_until).toBe(new Date(FIXED_NOW + 2000).toISOString());
  });

  it('doubles the delay per attempt (attempt 3 -> 8000ms with default base)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));
    await setBackoffLock('VTID-01179', 3);
    const call = lastCall();
    expect(call.body.lock_until).toBe(new Date(FIXED_NOW + 8000).toISOString());
  });

  it('honors a custom base delay', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));
    await setBackoffLock('VTID-01179', 2, 1000);
    const call = lastCall();
    // 1000 * 2^(2-1) = 2000
    expect(call.body.lock_until).toBe(new Date(FIXED_NOW + 2000).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Action attempt counters
// ---------------------------------------------------------------------------

describe('incrementActionAttempt', () => {
  it('returns 0 without writing when there is no run state', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));

    const count = await incrementActionAttempt('VTID-01179', 'merge');

    expect(count).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the read
  });

  it('increments the specific counter and preserves the others', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, [baseRunState({ attempts: { dispatch: 1, create_pr: 0, validate: 0, merge: 2, verify: 0 } })])
    );
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    const count = await incrementActionAttempt('VTID-01179', 'merge');

    expect(count).toBe(3);
    const patchCall = callAt(1);
    expect(patchCall.body.attempts).toEqual({ dispatch: 1, create_pr: 0, validate: 0, merge: 3, verify: 0 });
  });
});

describe('canAttemptAction', () => {
  it('returns false when there is no run state', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    expect(await canAttemptAction('VTID-01179', 'merge')).toBe(false);
  });

  it('returns true when attempts are below max_attempts', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, [baseRunState({ attempts: { dispatch: 0, create_pr: 0, validate: 0, merge: 1, verify: 0 }, max_attempts: 3 })])
    );
    expect(await canAttemptAction('VTID-01179', 'merge')).toBe(true);
  });

  it('returns false once attempts reach max_attempts', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, [baseRunState({ attempts: { dispatch: 0, create_pr: 0, validate: 0, merge: 3, verify: 0 }, max_attempts: 3 })])
    );
    expect(await canAttemptAction('VTID-01179', 'merge')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Active runs + terminal-state helpers
// ---------------------------------------------------------------------------

describe('getActiveRuns', () => {
  it('queries excluding completed/failed states', async () => {
    const rows = [baseRunState({ state: 'building' })];
    mockFetch.mockResolvedValueOnce(jsonResponse(200, rows));

    const result = await getActiveRuns();

    expect(result).toEqual(rows);
    expect(lastCall().url).toContain('state=not.in.(completed,failed)');
  });

  it('returns [] on query failure rather than throwing', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500));
    expect(await getActiveRuns()).toEqual([]);
  });
});

describe('markRunFailed', () => {
  it('sets state=failed with error, error_code, and both timestamp fields', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    const ok = await markRunFailed('VTID-01179', 'deploy timed out', 'DEPLOY_TIMEOUT');

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.body.state).toBe('failed');
    expect(call.body.error).toBe('deploy timed out');
    expect(call.body.error_code).toBe('DEPLOY_TIMEOUT');
    expect(call.body.completed_at).toBeDefined();
    expect(call.body.error_at).toBeDefined();
  });

  it('defaults error_code to null when omitted', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));
    await markRunFailed('VTID-01179', 'unspecified failure');
    expect(lastCall().body.error_code).toBeNull();
  });
});

describe('markRunCompleted (VTID-01208: recovery from failed state)', () => {
  it('sets state=completed and clears error fields, allowing recovery from a prior failed state', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, null));

    const ok = await markRunCompleted('VTID-01179');

    expect(ok).toBe(true);
    const call = lastCall();
    expect(call.body.state).toBe('completed');
    expect(call.body.completed_at).toBeDefined();
    expect(call.body.error).toBeNull();
    expect(call.body.error_code).toBeNull();
  });
});
