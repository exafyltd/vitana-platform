/**
 * VTID-04165 (Operator Console, console task 03): a rejection must carry a
 * real reason.
 *
 * Pinned here against the REAL write path — executeRejectExecution →
 * dev-autopilot-approval's rejectExecution — with only the PostgREST layer
 * (global fetch) and the OASIS emitter doubled:
 *   - an empty ("") or whitespace-only ("   ") reason is refused with a clear
 *     "needs an actual reason" error and the execution row is never read and
 *     never written (not one Supabase request),
 *   - a real, non-empty reason still rejects exactly as before (trimmed,
 *     ≤ 500 chars, recorded under metadata.rejected, one OASIS event),
 *   - an OMITTED reason is unchanged — the user simply gave none, which the
 *     tool schema still allows,
 *   - autopilot_approve_execution never asks for a reason and is unaffected.
 */

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import { emitOasisEvent } from '../src/services/oasis-event-service';
import { setThreadAuth } from '../src/services/operator-execute-authz';
import { executeRejectExecution, executeApproveExecution } from '../src/services/operator-approval-tools';

const emitted = () => (emitOasisEvent as jest.Mock).mock.calls.map((c) => c[0]);

const S = { url: 'https://supa.test', key: 'k' } as any;
const EXEC = '4f7d5ea4-1111-4222-8333-444444444444';
const ADMIN = 't-admin';
/** `deps.reject`'s third argument, captured per call. */
const recorded: Array<{ path: string; method: string; body: any }> = [];

/** A held row with no branch → rejectExecution never reaches GitHub. */
const row = { id: EXEC, status: 'awaiting_approval', branch: null, finding_id: 'f-4f7d5ea4', metadata: { executor: 'agent' } };

function res(status: number, data?: unknown) {
  const text = data === undefined ? '' : JSON.stringify(data);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => (data === undefined ? null : JSON.parse(text)) } as any;
}

const fetchMock = jest.fn(async (url: string, init: any = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  recorded.push({ path, method, body });
  if (!path.startsWith('/rest/v1/dev_autopilot_executions')) return res(200, []);
  if (method === 'GET') return res(200, [row]);
  if (method === 'PATCH') return res(204);
  return res(200, []);
});

beforeAll(() => { (global as any).fetch = fetchMock; });

const patches = () => recorded.filter((c) => c.method === 'PATCH');
const rejectCalls = () => recorded.filter((c) => c.path.startsWith('/rest/v1/dev_autopilot_executions'));

beforeEach(() => {
  recorded.length = 0;
  fetchMock.mockClear();
  (emitOasisEvent as jest.Mock).mockClear();
  setThreadAuth(ADMIN, { user_id: 'u-admin', exafy_admin: true });
});

describe('VTID-04165 autopilot_reject_execution: the reason must be real', () => {
  it('AC-1: refuses an empty string and a whitespace-only reason with a clear error, and touches nothing', async () => {
    for (const reason of ['', '   ', ' \n\t ']) {
      const r = await executeRejectExecution({ execution_id: EXEC, reason }, ADMIN, { s: S });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/autopilot_reject_execution needs an actual reason/);
      expect(r.error).toMatch(/empty \(or whitespace-only\)/);
      expect(r.error).toMatch(/was NOT rejected/);
      expect(r.data).toBeUndefined();
    }
    // The refusal happens on the argument: no read, no PATCH, nothing at all.
    expect(rejectCalls()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emitted()).toHaveLength(0);
  });

  it('AC-1: the execution row is NOT modified — no status write, no rejection event', async () => {
    const r = await executeRejectExecution({ execution_id: EXEC, reason: '   ' }, ADMIN, { s: S });
    expect(r.ok).toBe(false);
    expect(patches()).toHaveLength(0);
    expect(emitted().filter((e) => e.type === 'dev_autopilot.execution.rejected')).toHaveLength(0);
  });

  it('AC-2: a real reason still rejects exactly as before — trimmed, bounded, recorded on the row and in the event', async () => {
    const long = 'wrong approach '.repeat(60); // 900 chars → stored capped at 500
    const r = await executeRejectExecution({ execution_id: EXEC, reason: `  ${long}  ` }, ADMIN, { s: S });

    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      execution_id: EXEC,
      status: 'cancelled',
      branch_deleted: false,
      reason: long.trim().slice(0, 500),
      rejected_by: 'operator-chat:u-admin',
    });
    // VTID-04378: a trailing GET is the ledger close looking up the finding.
    expect(rejectCalls().map((c) => c.method).slice(0, 2)).toEqual(['GET', 'PATCH']);
    expect(rejectCalls().filter((c) => c.method === 'PATCH')).toHaveLength(1);
    const patch = patches()[0];
    expect(patch.path).toBe(`/rest/v1/dev_autopilot_executions?id=eq.${EXEC}&status=eq.awaiting_approval`);
    expect(patch.body.status).toBe('cancelled');
    expect(patch.body.metadata.rejected).toMatchObject({
      by: 'operator-chat:u-admin',
      reason: long.trim().slice(0, 500),
      branch_deleted: false,
    });
    const ev = emitted().filter((e) => e.type === 'dev_autopilot.execution.rejected');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ execution_id: EXEC, actor: 'operator-chat:u-admin', reason: long.trim().slice(0, 500) });
  });

  it('a short real reason is stored verbatim, and an OMITTED reason is still allowed (unchanged)', async () => {
    const r = await executeRejectExecution({ execution_id: EXEC, reason: '  wrong approach  ' }, ADMIN, { s: S });
    expect(r.data).toMatchObject({ reason: 'wrong approach' });
    expect(patches()[0].body.metadata.rejected.reason).toBe('wrong approach');

    recorded.length = 0;
    const omitted = await executeRejectExecution({ execution_id: EXEC }, ADMIN, { s: S });
    expect(omitted.ok).toBe(true);
    expect((omitted.data as { reason: unknown }).reason).toBeNull();
    expect(patches()[0].body.metadata.rejected.reason).toBeNull();
  });

  it('a non-admin caller is still refused before the reason is even considered', async () => {
    setThreadAuth('t-user', { user_id: 'u-1', exafy_admin: false });
    const r = await executeRejectExecution({ execution_id: EXEC, reason: '   ' }, 't-user', { s: S });
    expect(r.error).toMatch(/autopilot_reject_execution requires an exafy_admin session/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('autopilot_approve_execution needs no reason and is unaffected', async () => {
    const approve = jest.fn(async () => ({ ok: true, pr_url: 'https://github.com/exafyltd/vitana-platform/pull/3400', pr_number: 3400 }));
    const r = await executeApproveExecution({ execution_id: EXEC }, ADMIN, { s: S, approve });
    expect(approve).toHaveBeenCalledWith(EXEC, 'operator-chat:u-admin');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ pr_number: 3400, status: 'ci' });
  });
});
