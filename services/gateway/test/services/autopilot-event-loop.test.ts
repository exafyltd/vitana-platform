// Autopilot Event Loop (VTID-01179) — unit tests
//
// This is the autonomous poller that turns OASIS events into autopilot
// state transitions and dispatches follow-on actions (dispatch / validate /
// merge / verify). Only a small surface is exported
// (startEventLoop / stopEventLoop / getEventLoopStatus / getEventLoopHistory
// / initializeEventLoop / resetEventLoopCursor) — everything else
// (processEvent, performTransition, triggerActionForState, runLoopIteration,
// checkForStuckTasks, …) is module-private, so it is exercised here through
// that public surface plus the real scheduled loop under fake timers.
//
// Scope:
//   1. The two AUTOPILOT_LOOP_ENABLED === 'true' call sites (startEventLoop,
//      initializeEventLoop) — enabled AND disabled paths at each.
//   2. startEventLoop idempotency + config clamping.
//   3. stopEventLoop idempotency / cleanup.
//   4. getEventLoopStatus — VTID-01187's hard separation of "is the loop
//      process running" from "is execution armed", including its fail-CLOSED
//      behavior on error (never fail open on a governance flag).
//   5. resetEventLoopCursor / getEventLoopHistory — thin wrappers.
//   6. The EXECUTION_DISARMED gate inside the real scheduled loop iteration:
//      proven via fake timers that a disarmed loop still advances its cursor
//      (monitoring) but never attempts to process/transition events (no
//      autonomous action taken while disarmed).

// ---------------------------------------------------------------------------
// Module mocks (must precede the import of the module under test)
// ---------------------------------------------------------------------------

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt' }),
}));

jest.mock('../../src/services/system-controls-service', () => ({
  isAutopilotExecutionArmed: jest.fn(),
}));

jest.mock('../../src/services/autopilot-controller', () => ({
  markInProgress: jest.fn(),
  markBuilding: jest.fn(),
  markPrCreated: jest.fn(),
  markReviewing: jest.fn(),
  markValidated: jest.fn(),
  markMerged: jest.fn(),
  markDeploying: jest.fn(),
  markVerifying: jest.fn(),
  markCompleted: jest.fn(),
  markFailed: jest.fn(),
  getAutopilotRun: jest.fn(),
  startAutopilotRun: jest.fn(),
  hasValidatorPass: jest.fn(),
}));

jest.mock('../../src/services/autopilot-loop-store', () => ({
  getLoopState: jest.fn(),
  setLoopRunning: jest.fn(),
  updateLoopCursor: jest.fn(),
  resetLoopCursor: jest.fn(),
  recordLoopError: jest.fn(),
  getLoopStats: jest.fn(),
  isEventProcessed: jest.fn(),
  recordProcessedEvent: jest.fn(),
  getProcessedEventHistory: jest.fn(),
  getRunState: jest.fn(),
  upsertRunState: jest.fn(),
  updateRunState: jest.fn(),
  transitionRunState: jest.fn(),
  acquireRunLock: jest.fn(),
  releaseRunLock: jest.fn(),
  incrementActionAttempt: jest.fn(),
  canAttemptAction: jest.fn(),
  setBackoffLock: jest.fn(),
  markRunFailed: jest.fn(),
  markRunCompleted: jest.fn(),
}));

jest.mock('../../src/services/autopilot-event-mapper', () => ({
  normalizeEventType: jest.fn((e: any) => e.kind || e.type || 'unknown'),
  mapEventToTransition: jest.fn(),
  isAutopilotRelevantEvent: jest.fn(),
}));

import { isAutopilotExecutionArmed } from '../../src/services/system-controls-service';
import * as autopilotController from '../../src/services/autopilot-controller';
import * as loopStore from '../../src/services/autopilot-loop-store';
import * as eventMapper from '../../src/services/autopilot-event-mapper';
import * as eventLoop from '../../src/services/autopilot-event-loop';

const mockIsArmed = isAutopilotExecutionArmed as jest.Mock;
const mockGetRunState = loopStore.getRunState as jest.Mock;
const mockUpsertRunState = loopStore.upsertRunState as jest.Mock;
const mockUpdateLoopCursor = loopStore.updateLoopCursor as jest.Mock;
const mockGetLoopState = loopStore.getLoopState as jest.Mock;
const mockSetLoopRunning = loopStore.setLoopRunning as jest.Mock;
const mockResetLoopCursor = loopStore.resetLoopCursor as jest.Mock;
const mockRecordLoopError = loopStore.recordLoopError as jest.Mock;
const mockGetLoopStats = loopStore.getLoopStats as jest.Mock;
const mockGetProcessedEventHistory = loopStore.getProcessedEventHistory as jest.Mock;
const mockIsEventProcessed = loopStore.isEventProcessed as jest.Mock;
const mockRecordProcessedEvent = loopStore.recordProcessedEvent as jest.Mock;
const mockIsAutopilotRelevantEvent = eventMapper.isAutopilotRelevantEvent as jest.Mock;
const mockMapEventToTransition = eventMapper.mapEventToTransition as jest.Mock;
const mockMarkInProgress = autopilotController.markInProgress as jest.Mock;
const mockFetch = global.fetch as jest.Mock;

function jsonResponse(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
}

/** Default fetch behavior: no OASIS events, no stuck/zombie ledger rows. */
function defaultFetchImpl(url: any) {
  const u = String(url);
  if (u.includes('/rest/v1/oasis_events')) {
    return Promise.resolve(jsonResponse(200, []));
  }
  if (u.includes('/rest/v1/vtid_ledger')) {
    return Promise.resolve(jsonResponse(200, []));
  }
  return Promise.resolve(jsonResponse(200, {}));
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  originalEnv = { ...process.env };
  jest.clearAllMocks();

  mockIsArmed.mockResolvedValue(true);
  mockGetLoopState.mockResolvedValue({ last_event_timestamp: null });
  mockSetLoopRunning.mockResolvedValue(true);
  mockUpdateLoopCursor.mockResolvedValue(true);
  mockResetLoopCursor.mockResolvedValue(true);
  mockRecordLoopError.mockResolvedValue(true);
  mockGetLoopStats.mockResolvedValue({
    is_running: false, poll_interval_ms: 2000, last_cursor: null, last_event_timestamp: null,
    events_processed_total: 0, processed_1h: 0, errors_1h: 0, active_runs: 0, runs_by_state: {},
  });
  mockGetProcessedEventHistory.mockResolvedValue([]);
  mockIsEventProcessed.mockResolvedValue(false);
  mockRecordProcessedEvent.mockResolvedValue(true);
  mockIsAutopilotRelevantEvent.mockReturnValue(false);
  mockMapEventToTransition.mockReturnValue({ matched: false, reason: 'no-rule' });
  mockGetRunState.mockResolvedValue(null);
  mockUpsertRunState.mockResolvedValue(true);

  mockFetch.mockReset();
  mockFetch.mockImplementation((url: any) => defaultFetchImpl(url));

  // Note: the loop is guaranteed stopped entering this hook because
  // afterEach() (below) always stops it after the previous test —
  // loopRunning/currentConfig are module-level singletons shared across
  // every test in this file. Stopping again here (after clearAllMocks)
  // would itself register a spurious setLoopRunning(false) call and
  // pollute call-count assertions in this test.
});

afterEach(async () => {
  await eventLoop.stopEventLoop();
  process.env = originalEnv;
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. startEventLoop — AUTOPILOT_LOOP_ENABLED gate (call site ~line 1102)
// ---------------------------------------------------------------------------

describe('startEventLoop — AUTOPILOT_LOOP_ENABLED gate', () => {
  it('ENABLED path: AUTOPILOT_LOOP_ENABLED="true" starts the loop and reports is_running=true', async () => {
    process.env.AUTOPILOT_LOOP_ENABLED = 'true';

    const started = await eventLoop.startEventLoop();

    expect(started).toBe(true);
    expect(mockSetLoopRunning).toHaveBeenCalledWith(true);
    const status = await eventLoop.getEventLoopStatus();
    expect(status.is_running).toBe(true);
  });

  it('DISABLED path: AUTOPILOT_LOOP_ENABLED unset leaves the loop stopped', async () => {
    delete process.env.AUTOPILOT_LOOP_ENABLED;

    const started = await eventLoop.startEventLoop();

    expect(started).toBe(false);
    expect(mockSetLoopRunning).not.toHaveBeenCalled();
    const status = await eventLoop.getEventLoopStatus();
    expect(status.is_running).toBe(false);
  });

  it('DISABLED path: AUTOPILOT_LOOP_ENABLED="false" leaves the loop stopped', async () => {
    process.env.AUTOPILOT_LOOP_ENABLED = 'false';

    const started = await eventLoop.startEventLoop();

    expect(started).toBe(false);
    const status = await eventLoop.getEventLoopStatus();
    expect(status.is_running).toBe(false);
  });

  it('DISABLED path: a truthy-looking but non-literal value ("1") does NOT enable the loop (strict === "true" check)', async () => {
    process.env.AUTOPILOT_LOOP_ENABLED = '1';

    const started = await eventLoop.startEventLoop();

    expect(started).toBe(false);
    const status = await eventLoop.getEventLoopStatus();
    expect(status.is_running).toBe(false);
  });

  it('is idempotent: calling startEventLoop twice while already running short-circuits the second call', async () => {
    process.env.AUTOPILOT_LOOP_ENABLED = 'true';

    const first = await eventLoop.startEventLoop();
    const second = await eventLoop.startEventLoop();

    expect(first).toBe(true);
    expect(second).toBe(true);
    // setLoopRunning(true) must only be armed once — the second call must
    // short-circuit before re-parsing config or re-arming anything.
    expect(mockSetLoopRunning).toHaveBeenCalledTimes(1);
  });

  it('clamps an out-of-range poll interval / batch size to the documented safe bounds', async () => {
    process.env.AUTOPILOT_LOOP_ENABLED = 'true';
    process.env.AUTOPILOT_LOOP_POLL_MS = '1'; // below the 500ms floor
    process.env.AUTOPILOT_LOOP_BATCH_SIZE = '99999'; // above the 500 ceiling

    await eventLoop.startEventLoop();

    const status = await eventLoop.getEventLoopStatus();
    expect(status.config.pollIntervalMs).toBe(500);
    expect(status.config.batchSize).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 2. initializeEventLoop — AUTOPILOT_LOOP_ENABLED gate (call site ~line 1202)
// ---------------------------------------------------------------------------

describe('initializeEventLoop — AUTOPILOT_LOOP_ENABLED gate', () => {
  it('ENABLED path: AUTOPILOT_LOOP_ENABLED="true" auto-starts the loop', async () => {
    process.env.AUTOPILOT_LOOP_ENABLED = 'true';

    await eventLoop.initializeEventLoop();

    const status = await eventLoop.getEventLoopStatus();
    expect(status.is_running).toBe(true);
    expect(mockSetLoopRunning).toHaveBeenCalledWith(true);
  });

  it('DISABLED path: AUTOPILOT_LOOP_ENABLED unset never starts the loop', async () => {
    delete process.env.AUTOPILOT_LOOP_ENABLED;

    await eventLoop.initializeEventLoop();

    const status = await eventLoop.getEventLoopStatus();
    expect(status.is_running).toBe(false);
    expect(mockSetLoopRunning).not.toHaveBeenCalled();
  });

  it('DISABLED path: AUTOPILOT_LOOP_ENABLED="false" never starts the loop', async () => {
    process.env.AUTOPILOT_LOOP_ENABLED = 'false';

    await eventLoop.initializeEventLoop();

    const status = await eventLoop.getEventLoopStatus();
    expect(status.is_running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. stopEventLoop
// ---------------------------------------------------------------------------

describe('stopEventLoop', () => {
  it('flips is_running back to false and clears the pending timer', async () => {
    jest.useFakeTimers();
    process.env.AUTOPILOT_LOOP_ENABLED = 'true';
    await eventLoop.startEventLoop();
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await eventLoop.stopEventLoop();

    expect(jest.getTimerCount()).toBe(0);
    const status = await eventLoop.getEventLoopStatus();
    expect(status.is_running).toBe(false);
    expect(mockSetLoopRunning).toHaveBeenCalledWith(false);
  });

  it('is safe (idempotent) to call when the loop was never started', async () => {
    await expect(eventLoop.stopEventLoop()).resolves.toBeUndefined();
    const status = await eventLoop.getEventLoopStatus();
    expect(status.is_running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. getEventLoopStatus — separates "loop running" from "execution armed"
//    (VTID-01187 defense-in-depth) and fails CLOSED on error.
// ---------------------------------------------------------------------------

describe('getEventLoopStatus — governance visibility (VTID-01187)', () => {
  it('reports execution_armed from the DB-backed governance flag, independent of is_running', async () => {
    mockIsArmed.mockResolvedValue(true);
    const status = await eventLoop.getEventLoopStatus();
    expect(status.is_running).toBe(false); // loop not started in this test
    expect(status.execution_armed).toBe(true);
  });

  it('DEFENSE IN DEPTH: the loop can be running while execution is DISARMED simultaneously (monitor-only mode)', async () => {
    process.env.AUTOPILOT_LOOP_ENABLED = 'true';
    mockIsArmed.mockResolvedValue(false);

    await eventLoop.startEventLoop();
    const status = await eventLoop.getEventLoopStatus();

    expect(status.is_running).toBe(true);
    expect(status.execution_armed).toBe(false);
  });

  it('fails CLOSED (execution_armed=false) when getLoopStats() throws', async () => {
    mockGetLoopStats.mockRejectedValueOnce(new Error('db unavailable'));
    mockIsArmed.mockResolvedValue(true); // even though the real flag is armed...

    const status = await eventLoop.getEventLoopStatus();

    expect(status.ok).toBe(false);
    expect(status.execution_armed).toBe(false); // ...the fail-closed default wins
  });

  it('fails CLOSED (execution_armed=false) when isAutopilotExecutionArmed() itself throws', async () => {
    mockIsArmed.mockRejectedValueOnce(new Error('governance service down'));

    const status = await eventLoop.getEventLoopStatus();

    expect(status.ok).toBe(false);
    expect(status.execution_armed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. resetEventLoopCursor
// ---------------------------------------------------------------------------

describe('resetEventLoopCursor', () => {
  it('"now" expands to the current wall-clock time', async () => {
    const before = Date.now();
    const result = await eventLoop.resetEventLoopCursor('now');
    const after = Date.now();

    expect(result.ok).toBe(true);
    const cursorMs = new Date(result.cursor).getTime();
    expect(cursorMs).toBeGreaterThanOrEqual(before);
    expect(cursorMs).toBeLessThanOrEqual(after);
    expect(mockResetLoopCursor).toHaveBeenCalledWith(result.cursor, 'manual-reset');
  });

  it('passes an explicit timestamp through unchanged', async () => {
    const ts = '2026-01-01T00:00:00.000Z';
    const result = await eventLoop.resetEventLoopCursor(ts, 'catch-up');
    expect(result.cursor).toBe(ts);
    expect(result.reason).toBe('catch-up');
    expect(mockResetLoopCursor).toHaveBeenCalledWith(ts, 'catch-up');
  });

  it('defaults reason to "manual-reset" when not provided', async () => {
    const result = await eventLoop.resetEventLoopCursor('2026-02-02T00:00:00.000Z');
    expect(result.reason).toBe('manual-reset');
  });

  it('reports ok:false when the underlying persistence write fails', async () => {
    mockResetLoopCursor.mockResolvedValueOnce(false);
    const result = await eventLoop.resetEventLoopCursor('2026-03-03T00:00:00.000Z');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. getEventLoopHistory
// ---------------------------------------------------------------------------

describe('getEventLoopHistory', () => {
  it('delegates to getProcessedEventHistory with the default limit of 100', async () => {
    await eventLoop.getEventLoopHistory();
    expect(mockGetProcessedEventHistory).toHaveBeenCalledWith(100);
  });

  it('forwards a custom limit', async () => {
    await eventLoop.getEventLoopHistory(25);
    expect(mockGetProcessedEventHistory).toHaveBeenCalledWith(25);
  });
});

// ---------------------------------------------------------------------------
// 7. EXECUTION_DISARMED governance gate inside the real scheduled loop
//    ("IF execution is disarmed THEN monitor only" — CLAUDE.md §5/§Governance)
// ---------------------------------------------------------------------------

describe('runLoopIteration (via the real scheduled loop under fake timers) — EXECUTION_DISARMED gate', () => {
  const oneEvent = [{
    id: 'evt-1',
    created_at: '2026-01-01T00:00:00.000Z',
    vtid: 'VTID-LOOP-TEST-1',
    kind: 'vtid.lifecycle.started',
  }];

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.AUTOPILOT_LOOP_ENABLED = 'true';
    process.env.AUTOPILOT_LOOP_POLL_MS = '500'; // clamp floor, keeps test fast
    mockFetch.mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('/rest/v1/oasis_events')) {
        return Promise.resolve(jsonResponse(200, oneEvent));
      }
      return defaultFetchImpl(url);
    });
  });

  it('DISARMED: still advances the cursor (monitoring) but never looks up run state for the fetched event', async () => {
    mockIsArmed.mockResolvedValue(false);

    await eventLoop.startEventLoop();
    await jest.advanceTimersByTimeAsync(500);

    // Cursor still moves forward so armed-later iterations don't reprocess
    // the same events — "loop keeps running for monitoring" per VTID-01187.
    expect(mockUpdateLoopCursor).toHaveBeenCalledWith(oneEvent[0].created_at, oneEvent[0].created_at);

    // But NO autonomous action was attempted: processEvent() is never
    // reached while disarmed, so run-state lookup / event-processed checks
    // must never fire.
    expect(mockGetRunState).not.toHaveBeenCalled();
    expect(mockIsEventProcessed).not.toHaveBeenCalled();
    expect(mockMarkInProgress).not.toHaveBeenCalled();
  });

  it('ARMED: attempts to process the fetched event (reaches the idempotency + run-state lookup)', async () => {
    mockIsArmed.mockResolvedValue(true);
    mockIsAutopilotRelevantEvent.mockReturnValue(true);

    await eventLoop.startEventLoop();
    await jest.advanceTimersByTimeAsync(500);

    expect(mockIsEventProcessed).toHaveBeenCalledWith('evt-1');
    expect(mockGetRunState).toHaveBeenCalledWith('VTID-LOOP-TEST-1');
  });

  it('ARMED but event already processed (idempotency/dedup): skips without touching run state', async () => {
    mockIsArmed.mockResolvedValue(true);
    mockIsEventProcessed.mockResolvedValue(true);

    await eventLoop.startEventLoop();
    await jest.advanceTimersByTimeAsync(500);

    expect(mockIsEventProcessed).toHaveBeenCalledWith('evt-1');
    // Already-processed events must never re-enter relevance/transition logic.
    expect(mockIsAutopilotRelevantEvent).not.toHaveBeenCalled();
    expect(mockGetRunState).not.toHaveBeenCalled();
  });
});
