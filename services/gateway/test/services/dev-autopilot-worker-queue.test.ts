/**
 * Tests for src/services/dev-autopilot-worker-queue.ts
 *
 * Contract under test (from source comments + code):
 *   - enqueueWorkerTask(): single Supabase INSERT into
 *     dev_autopilot_worker_queue, status='pending', with defaults applied
 *     (model, max_tokens, worker_owns_pr coerced to boolean).
 *   - waitForWorkerTask(): polls the row every 2s until status is
 *     'completed' | 'failed', tolerating up to 10 consecutive transient
 *     fetch failures before giving up, and gives up after the timeout
 *     (default 360s) elapses.
 *   - runWorkerTask(): enqueue + wait convenience wrapper.
 *   - reclaimStuckWorkerTasks(): PATCHes rows stuck in 'running' for
 *     > 15 minutes to 'failed'.
 *   - reclaimStuckPendingWorkerTasks(): finds rows stuck in 'pending' for
 *     > 15 minutes, conditionally PATCHes each to 'failed' (only if still
 *     pending), and writes a self-heal log entry per successfully reclaimed
 *     row.
 *
 * NOTE on CLAUDE.md §5 "one VTID at a time per worker (no parallel
 * execution)": this file is the *gateway* side of the queue (enqueue +
 * poll + watchdogs). It contains no claim/lock logic at all — no
 * `claimed_by`, no atomic "claim next pending row" query, nothing that
 * would serialize workers against each other. Enqueueing is a plain
 * INSERT with no uniqueness constraint asserted here, so nothing in this
 * file prevents two rows from being enqueued and processed concurrently.
 * Whatever single-worker exclusivity exists must live in the worker
 * daemon (services/autopilot-worker, not part of this gateway service) or
 * in a DB-level constraint outside this file. Tests below assert this
 * absence explicitly (multiple concurrent enqueues succeed independently)
 * rather than asserting a guarantee this file does not implement.
 */

import {
  isWorkerQueueEnabled,
  isWorkerOwnsPrEnabled,
  enqueueWorkerTask,
  waitForWorkerTask,
  runWorkerTask,
  reclaimStuckWorkerTasks,
  reclaimStuckPendingWorkerTasks,
  type WorkerTaskInput,
} from '../../src/services/dev-autopilot-worker-queue';
import { writeAutopilotFailure } from '../../src/services/dev-autopilot-self-heal-log';

jest.mock('../../src/services/dev-autopilot-self-heal-log', () => ({
  writeAutopilotFailure: jest.fn().mockResolvedValue(undefined),
}));

const mockedFetch = global.fetch as jest.MockedFunction<typeof fetch>;
const mockedWriteFailure = writeAutopilotFailure as jest.MockedFunction<typeof writeAutopilotFailure>;

function jsonResponse(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(status: number, text: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

const BASE_INPUT: WorkerTaskInput = {
  kind: 'plan',
  finding_id: 'finding-abc-123',
  prompt: 'do the thing',
};

beforeEach(() => {
  mockedFetch.mockReset();
  mockedWriteFailure.mockClear();
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
});

// ---------------------------------------------------------------------------
// isWorkerQueueEnabled / isWorkerOwnsPrEnabled
// ---------------------------------------------------------------------------

describe('isWorkerQueueEnabled', () => {
  const prev = process.env.DEV_AUTOPILOT_USE_WORKER;
  afterAll(() => {
    if (prev === undefined) delete process.env.DEV_AUTOPILOT_USE_WORKER;
    else process.env.DEV_AUTOPILOT_USE_WORKER = prev;
  });

  it('is false when unset', () => {
    delete process.env.DEV_AUTOPILOT_USE_WORKER;
    expect(isWorkerQueueEnabled()).toBe(false);
  });

  it('is true for "true"', () => {
    process.env.DEV_AUTOPILOT_USE_WORKER = 'true';
    expect(isWorkerQueueEnabled()).toBe(true);
  });

  it('is true for "TRUE" (case-insensitive)', () => {
    process.env.DEV_AUTOPILOT_USE_WORKER = 'TRUE';
    expect(isWorkerQueueEnabled()).toBe(true);
  });

  it('is false for any other value', () => {
    process.env.DEV_AUTOPILOT_USE_WORKER = 'yes';
    expect(isWorkerQueueEnabled()).toBe(false);
  });
});

describe('isWorkerOwnsPrEnabled', () => {
  const prev = process.env.AUTOPILOT_WORKER_OWNS_PR;
  afterAll(() => {
    if (prev === undefined) delete process.env.AUTOPILOT_WORKER_OWNS_PR;
    else process.env.AUTOPILOT_WORKER_OWNS_PR = prev;
  });

  it('is false when unset', () => {
    delete process.env.AUTOPILOT_WORKER_OWNS_PR;
    expect(isWorkerOwnsPrEnabled()).toBe(false);
  });

  it('is true for "true" case-insensitively', () => {
    process.env.AUTOPILOT_WORKER_OWNS_PR = 'True';
    expect(isWorkerOwnsPrEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enqueueWorkerTask
// ---------------------------------------------------------------------------

describe('enqueueWorkerTask', () => {
  it('returns an error and does not call fetch when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;

    const r = await enqueueWorkerTask(BASE_INPUT);

    expect(r.ok).toBe(false);
    expect(r.error).toBe('Supabase not configured');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('POSTs to dev_autopilot_worker_queue with defaults applied and returns the new row id', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(201, [{ id: 'row-1' }]));

    const r = await enqueueWorkerTask(BASE_INPUT);

    expect(r.ok).toBe(true);
    expect(r.id).toBe('row-1');

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(String(url)).toBe('http://localhost:54321/rest/v1/dev_autopilot_worker_queue');
    expect(init?.method).toBe('POST');
    expect((init?.headers as any).apikey).toBe('test-service-role-key-mock');
    expect((init?.headers as any).Authorization).toBe('Bearer test-service-role-key-mock');

    const body = JSON.parse(init?.body as string);
    expect(body.kind).toBe('plan');
    expect(body.finding_id).toBe('finding-abc-123');
    expect(body.execution_id).toBeNull();
    expect(body.status).toBe('pending');
    expect(body.input_payload.prompt).toBe('do the thing');
    expect(body.input_payload.model).toBe('claude-sonnet-4-6');
    expect(body.input_payload.max_tokens).toBe(16_000);
    expect(body.input_payload.notes).toBeNull();
    expect(body.input_payload.worker_owns_pr).toBe(false);
  });

  it('carries through caller-supplied overrides instead of defaults', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(201, [{ id: 'row-2' }]));

    await enqueueWorkerTask({
      kind: 'execute',
      finding_id: 'f-2',
      execution_id: 'exec-9',
      prompt: 'p',
      model: 'claude-opus-4',
      max_tokens: 5000,
      notes: 'a note',
      worker_owns_pr: true,
      branch_name: 'autopilot/f-2',
      base_branch: 'main',
      vtid_like: 'VTID-09999',
    });

    const body = JSON.parse(mockedFetch.mock.calls[0][1]?.body as string);
    expect(body.execution_id).toBe('exec-9');
    expect(body.input_payload.model).toBe('claude-opus-4');
    expect(body.input_payload.max_tokens).toBe(5000);
    expect(body.input_payload.notes).toBe('a note');
    expect(body.input_payload.worker_owns_pr).toBe(true);
    expect(body.input_payload.branch_name).toBe('autopilot/f-2');
    expect(body.input_payload.base_branch).toBe('main');
    expect(body.input_payload.vtid_like).toBe('VTID-09999');
  });

  it('returns an error when the insert responds with a non-2xx status', async () => {
    mockedFetch.mockResolvedValueOnce(textResponse(500, 'internal error'));

    const r = await enqueueWorkerTask(BASE_INPUT);

    expect(r.ok).toBe(false);
    expect(r.error).toContain('500');
  });

  it('returns "enqueue returned no row" when the insert responds with an empty array', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(201, []));

    const r = await enqueueWorkerTask(BASE_INPUT);

    expect(r.ok).toBe(false);
    expect(r.error).toBe('enqueue returned no row');
  });

  it('surfaces a network-level fetch rejection as an error string', async () => {
    mockedFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const r = await enqueueWorkerTask(BASE_INPUT);

    expect(r.ok).toBe(false);
    expect(r.error).toContain('fetch failed');
  });

  it('lets two concurrent enqueues for the same finding both succeed independently (no exclusivity enforced here)', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(201, [{ id: 'row-a' }]))
      .mockResolvedValueOnce(jsonResponse(201, [{ id: 'row-b' }]));

    const [a, b] = await Promise.all([
      enqueueWorkerTask(BASE_INPUT),
      enqueueWorkerTask(BASE_INPUT),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// waitForWorkerTask
// ---------------------------------------------------------------------------

describe('waitForWorkerTask', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns an error and does not call fetch when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;

    const r = await waitForWorkerTask('row-1');

    expect(r.ok).toBe(false);
    expect(r.error).toBe('Supabase not configured');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns the full result immediately when the row is already completed', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          status: 'completed',
          output_payload: {
            text: 'the answer',
            usage: { input_tokens: 10, output_tokens: 20 },
            pr_url: 'https://github.com/x/y/pull/1',
            pr_number: 1,
            branch: 'autopilot/x',
            attempt_failures: [{ attempt: 1, stage: 'tsc', pattern_key: 'p', example_message: 'm' }],
          },
          error_message: null,
        },
      ]),
    );

    const r = await waitForWorkerTask('row-1');

    expect(r.ok).toBe(true);
    expect(r.text).toBe('the answer');
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(r.pr_url).toBe('https://github.com/x/y/pull/1');
    expect(r.pr_number).toBe(1);
    expect(r.branch).toBe('autopilot/x');
    expect(r.attempt_failures).toHaveLength(1);
    expect(r.queue_row_id).toBe('row-1');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(String(mockedFetch.mock.calls[0][0])).toContain('id=eq.row-1');
  });

  it('returns ok:false with the error_message when the row is failed', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, [
        {
          status: 'failed',
          output_payload: { attempt_failures: [{ attempt: 2, stage: 'jest', pattern_key: 'p2', example_message: 'boom' }] },
          error_message: 'worker crashed',
        },
      ]),
    );

    const r = await waitForWorkerTask('row-9');

    expect(r.ok).toBe(false);
    expect(r.error).toBe('worker crashed');
    expect(r.attempt_failures).toHaveLength(1);
    expect(r.queue_row_id).toBe('row-9');
  });

  it('falls back to a generic message when a failed row has no error_message', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, [{ status: 'failed', output_payload: null, error_message: null }]),
    );

    const r = await waitForWorkerTask('row-9');

    expect(r.ok).toBe(false);
    expect(r.error).toBe('worker reported failure with no message');
  });

  it('polls again while the row is pending/running, then returns on completion', async () => {
    jest.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(200, [{ status: 'pending', output_payload: null, error_message: null }]))
      .mockResolvedValueOnce(jsonResponse(200, [{ status: 'running', output_payload: null, error_message: null }]))
      .mockResolvedValueOnce(jsonResponse(200, [{ status: 'completed', output_payload: { text: 'done' }, error_message: null }]));

    const promise = waitForWorkerTask('row-3');

    await jest.advanceTimersByTimeAsync(2_000); // pending -> running poll
    await jest.advanceTimersByTimeAsync(2_000); // running -> completed poll

    const r = await promise;

    expect(r.ok).toBe(true);
    expect(r.text).toBe('done');
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after MAX_CONSECUTIVE_FAILURES (10) transient lookup failures', async () => {
    jest.useFakeTimers();
    mockedFetch.mockResolvedValue(textResponse(500, 'db down'));

    const promise = waitForWorkerTask('row-flaky');

    // Each failed poll backs off POLL_INTERVAL_MS * 2 = 4000ms before retrying.
    for (let i = 0; i < 10; i++) {
      await jest.advanceTimersByTimeAsync(4_000);
    }

    const r = await promise;

    expect(r.ok).toBe(false);
    expect(r.error).toContain('10× in a row');
    expect(r.queue_row_id).toBe('row-flaky');
    expect(mockedFetch).toHaveBeenCalledTimes(10);
  });

  it('times out once the deadline elapses while the row stays non-terminal', async () => {
    jest.useFakeTimers();
    mockedFetch.mockResolvedValue(
      jsonResponse(200, [{ status: 'running', output_payload: null, error_message: null }]),
    );

    const promise = waitForWorkerTask('row-slow', { timeoutMs: 5_000 });

    await jest.advanceTimersByTimeAsync(2_000);
    await jest.advanceTimersByTimeAsync(2_000);
    await jest.advanceTimersByTimeAsync(2_000); // pushes past the 5s deadline

    const r = await promise;

    expect(r.ok).toBe(false);
    expect(r.error).toBe('worker-queue wait timed out after 5s');
    expect(r.queue_row_id).toBe('row-slow');
  });
});

// ---------------------------------------------------------------------------
// runWorkerTask
// ---------------------------------------------------------------------------

describe('runWorkerTask', () => {
  it('returns the enqueue error without polling when enqueue fails', async () => {
    mockedFetch.mockResolvedValueOnce(textResponse(500, 'insert failed'));

    const r = await runWorkerTask(BASE_INPUT);

    expect(r.ok).toBe(false);
    expect(r.error).toContain('500');
    // Only the enqueue POST — no polling GET.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('enqueues then waits, returning the polled result', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse(201, [{ id: 'row-run-1' }]))
      .mockResolvedValueOnce(
        jsonResponse(200, [{ status: 'completed', output_payload: { text: 'ok' }, error_message: null }]),
      );

    const r = await runWorkerTask(BASE_INPUT);

    expect(r.ok).toBe(true);
    expect(r.text).toBe('ok');
    expect(r.queue_row_id).toBe('row-run-1');
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// reclaimStuckWorkerTasks
// ---------------------------------------------------------------------------

describe('reclaimStuckWorkerTasks', () => {
  it('returns an error and does not call fetch when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;

    const r = await reclaimStuckWorkerTasks();

    expect(r.reclaimed).toBe(0);
    expect(r.error).toBe('Supabase not configured');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('PATCHes rows stuck in running to failed and returns the reclaimed count', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, [{ id: 'stuck-1' }, { id: 'stuck-2' }]));

    const r = await reclaimStuckWorkerTasks();

    expect(r.reclaimed).toBe(2);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(String(url)).toContain('status=eq.running');
    expect(String(url)).toContain('started_at=lt.');
    expect(init?.method).toBe('PATCH');
    const body = JSON.parse(init?.body as string);
    expect(body.status).toBe('failed');
    expect(body.error_message).toContain("stuck in 'running' > 15m");
  });

  it('returns 0 reclaimed and the error when the PATCH fails', async () => {
    mockedFetch.mockResolvedValueOnce(textResponse(500, 'patch failed'));

    const r = await reclaimStuckWorkerTasks();

    expect(r.reclaimed).toBe(0);
    expect(r.error).toContain('500');
  });
});

// ---------------------------------------------------------------------------
// reclaimStuckPendingWorkerTasks
// ---------------------------------------------------------------------------

describe('reclaimStuckPendingWorkerTasks', () => {
  it('returns an error and does not call fetch when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;

    const r = await reclaimStuckPendingWorkerTasks();

    expect(r.reclaimed).toBe(0);
    expect(r.error).toBe('Supabase not configured');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns 0 reclaimed with no PATCHes when no rows are stuck pending', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, []));

    const r = await reclaimStuckPendingWorkerTasks();

    expect(r.reclaimed).toBe(0);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedWriteFailure).not.toHaveBeenCalled();
  });

  it('propagates the error from the initial select without writing failures', async () => {
    mockedFetch.mockResolvedValueOnce(textResponse(500, 'select failed'));

    const r = await reclaimStuckPendingWorkerTasks();

    expect(r.reclaimed).toBe(0);
    expect(r.error).toContain('500');
    expect(mockedWriteFailure).not.toHaveBeenCalled();
  });

  it('reclaims a stuck pending "plan" row: PATCHes it and logs a plan_gen self-heal entry', async () => {
    const createdAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
    mockedFetch
      .mockResolvedValueOnce(
        jsonResponse(200, [
          { id: 'pend-1', kind: 'plan', finding_id: 'find-1', execution_id: null, created_at: createdAt },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse(200, [])); // conditional PATCH success (return=minimal -> empty ok body)

    const r = await reclaimStuckPendingWorkerTasks();

    expect(r.reclaimed).toBe(1);

    // Conditional PATCH included both status=eq.pending and id filter
    const [patchUrl, patchInit] = mockedFetch.mock.calls[1];
    expect(String(patchUrl)).toContain('id=eq.pend-1');
    expect(String(patchUrl)).toContain('status=eq.pending');
    expect(patchInit?.method).toBe('PATCH');
    const patchBody = JSON.parse(patchInit?.body as string);
    expect(patchBody.status).toBe('failed');
    expect(patchBody.error_message).toContain('no worker claimed task in');

    expect(mockedWriteFailure).toHaveBeenCalledTimes(1);
    const [, args] = mockedWriteFailure.mock.calls[0];
    expect(args.stage).toBe('plan_gen');
    expect(args.vtid).toBe('VTID-DA-FIND-find-1');
    expect(args.endpoint).toBe('autopilot.worker_queue.plan');
    expect(args.failure_class).toBe('dev_autopilot_worker_queue_unclaimed');
    expect(args.outcome).toBe('escalated');
  });

  it('reclaims a stuck pending "execute" row using the execution_id-based VTID and execute_run stage', async () => {
    const createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    mockedFetch
      .mockResolvedValueOnce(
        jsonResponse(200, [
          { id: 'pend-2', kind: 'execute', finding_id: 'find-2', execution_id: 'exec-77', created_at: createdAt },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse(200, []));

    const r = await reclaimStuckPendingWorkerTasks();

    expect(r.reclaimed).toBe(1);
    const [, args] = mockedWriteFailure.mock.calls[0];
    expect(args.stage).toBe('execute_run');
    expect(args.vtid).toBe('VTID-DA-exec-77');
  });

  it('does not count a row toward reclaimed and does not log when the conditional PATCH fails (already claimed)', async () => {
    const createdAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    mockedFetch
      .mockResolvedValueOnce(
        jsonResponse(200, [
          { id: 'pend-3', kind: 'plan', finding_id: 'find-3', execution_id: null, created_at: createdAt },
        ]),
      )
      .mockResolvedValueOnce(textResponse(500, 'row already claimed / conflict'));

    const r = await reclaimStuckPendingWorkerTasks();

    expect(r.reclaimed).toBe(0);
    expect(mockedWriteFailure).not.toHaveBeenCalled();
  });

  it('processes multiple stuck rows independently, only counting successful PATCHes', async () => {
    const createdAt = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    mockedFetch
      .mockResolvedValueOnce(
        jsonResponse(200, [
          { id: 'pend-a', kind: 'plan', finding_id: 'find-a', execution_id: null, created_at: createdAt },
          { id: 'pend-b', kind: 'execute', finding_id: 'find-b', execution_id: 'exec-b', created_at: createdAt },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse(200, [])) // pend-a PATCH succeeds
      .mockResolvedValueOnce(textResponse(409, 'conflict')); // pend-b PATCH fails

    const r = await reclaimStuckPendingWorkerTasks();

    expect(r.reclaimed).toBe(1);
    expect(mockedWriteFailure).toHaveBeenCalledTimes(1);
    expect(mockedWriteFailure.mock.calls[0][1].endpoint).toBe('autopilot.worker_queue.plan');
  });
});
