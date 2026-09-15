/**
 * VTID-03902: Operator Planner.
 *
 * Covers the gap this file exists to close: autopilot_create_task left
 * every operator-chat task stranded at status=scheduled/spec_status=missing
 * forever, because nothing ever consumed GET
 * /api/v1/autopilot/tasks/pending-plan. These tests pin:
 * - the query scope (operator-chat only, scheduled+missing+no prior error —
 *   never touches self-healing/autonomous-execution rows, VTID-03516)
 * - that a found task gets a spec-generation call via the existing
 *   POST /api/v1/specs/:vtid/generate pipeline, not a reimplementation
 * - that a quiet sweep (nothing to plan) emits no OASIS event, but a real
 *   sweep does (one summary event, not per-task noise)
 * - the OPERATOR_PLANNER_ENABLED kill switch defaults OFF
 */

jest.mock('node-fetch');
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import fetch from 'node-fetch';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import {
  findPlannableOperatorTasks,
  generateSpecForTask,
  runOperatorPlannerOnce,
  isOperatorPlannerEnabled,
} from '../src/services/operator-planner';

const mockedFetch = fetch as unknown as jest.Mock;
const mockedEmitOasisEvent = emitOasisEvent as jest.Mock;

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as any;
}

describe('Operator Planner (VTID-03902)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE: 'test-key',
      PORT: '8080',
    };
    mockedFetch.mockReset();
    mockedEmitOasisEvent.mockClear();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('isOperatorPlannerEnabled', () => {
    it('defaults to disabled', () => {
      delete process.env.OPERATOR_PLANNER_ENABLED;
      expect(isOperatorPlannerEnabled()).toBe(false);
    });

    it('is enabled only by the exact string "true"', () => {
      process.env.OPERATOR_PLANNER_ENABLED = 'yes';
      expect(isOperatorPlannerEnabled()).toBe(false);
      process.env.OPERATOR_PLANNER_ENABLED = 'true';
      expect(isOperatorPlannerEnabled()).toBe(true);
    });
  });

  describe('findPlannableOperatorTasks', () => {
    it('queries vtid_ledger scoped to operator-chat, scheduled, missing spec, no prior error', async () => {
      mockedFetch.mockResolvedValueOnce(jsonRes(200, []));

      await findPlannableOperatorTasks();

      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const [url] = mockedFetch.mock.calls[0];
      expect(url).toContain('/rest/v1/vtid_ledger');
      expect(url).toContain('status=eq.scheduled');
      expect(url).toContain('spec_status=eq.missing');
      expect(url).toContain('spec_last_error=is.null');
      expect(url).toContain('metadata->>source=eq.operator-chat');
    });

    it('returns [] and logs a warning on a failed query, never throws', async () => {
      mockedFetch.mockResolvedValueOnce(jsonRes(500, { error: 'boom' }));
      await expect(findPlannableOperatorTasks()).resolves.toEqual([]);
    });

    it('returns [] on a network error, never throws', async () => {
      mockedFetch.mockRejectedValueOnce(new Error('network down'));
      await expect(findPlannableOperatorTasks()).resolves.toEqual([]);
    });
  });

  describe('generateSpecForTask', () => {
    it('calls the existing internal spec-generation endpoint, not a reimplementation', async () => {
      mockedFetch.mockResolvedValueOnce(jsonRes(201, { ok: true, spec_status: 'draft' }));

      const result = await generateSpecForTask({ vtid: 'VTID-04000', title: 'Gateway: fix thing', summary: null });

      expect(result.ok).toBe(true);
      const [url, opts] = mockedFetch.mock.calls[0];
      expect(url).toBe('http://localhost:8080/api/v1/specs/VTID-04000/generate');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.source).toBe('operator-planner');
    });

    it('surfaces the error and does not throw when spec generation fails', async () => {
      mockedFetch.mockResolvedValueOnce(jsonRes(502, { ok: false, error: 'spec_insert_failed' }));
      const result = await generateSpecForTask({ vtid: 'VTID-04001', title: 'x', summary: null });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('spec_insert_failed');
    });
  });

  describe('runOperatorPlannerOnce', () => {
    it('emits no OASIS event on a quiet sweep (polling is not progress)', async () => {
      mockedFetch.mockResolvedValueOnce(jsonRes(200, []));

      const summary = await runOperatorPlannerOnce();

      expect(summary).toEqual({ found: 0, generated: 0, failed: 0, results: [] });
      expect(mockedEmitOasisEvent).not.toHaveBeenCalled();
    });

    it('generates a spec for each found task and emits one summary event', async () => {
      mockedFetch
        .mockResolvedValueOnce(
          jsonRes(200, [{ vtid: 'VTID-04002', title: 'Gateway: a', summary: null }])
        )
        .mockResolvedValueOnce(jsonRes(201, { ok: true }));

      const summary = await runOperatorPlannerOnce();

      expect(summary.found).toBe(1);
      expect(summary.generated).toBe(1);
      expect(summary.failed).toBe(0);
      expect(mockedEmitOasisEvent).toHaveBeenCalledTimes(1);
      const [event] = mockedEmitOasisEvent.mock.calls[0];
      expect(event.type).toBe('operator.planner.sweep_completed');
      expect(event.status).toBe('success');
    });

    it('marks the sweep event as a warning when at least one task fails', async () => {
      mockedFetch
        .mockResolvedValueOnce(
          jsonRes(200, [{ vtid: 'VTID-04003', title: 'Gateway: b', summary: null }])
        )
        .mockResolvedValueOnce(jsonRes(502, { ok: false, error: 'llm_failed' }));

      const summary = await runOperatorPlannerOnce();

      expect(summary.failed).toBe(1);
      const [event] = mockedEmitOasisEvent.mock.calls[0];
      expect(event.status).toBe('warning');
    });
  });
});
