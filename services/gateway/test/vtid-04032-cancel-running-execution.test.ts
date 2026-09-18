/**
 * VTID-04032 (W4h): cancel a RUNNING Dev Autopilot agent execution.
 *
 * Pinned here: the heartbeat's cancel read-back (fires once, only on a
 * cancelled row, never throws), the loop stopping at a turn and a tool
 * boundary with `cancelled: true`, cancelExecution on cooling / running /
 * other rows (StopTask attempted with the remembered task ARN, outcome on
 * the row, one event, terminal side effects), applyExecutionResult
 * closing a cancelled result as cancelled — never failed, never self-heal —
 * and ignoring a late result on an already-cancelled row, the dispatch
 * recording the task ARN, the route passing the verified actor, and the
 * Command Hub wiring.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('node-fetch');
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
  cicdEvents: {},
  default: { deployRequested: jest.fn(), deployAccepted: jest.fn(), deployFailed: jest.fn() },
}));
jest.mock('../src/services/github-service', () => ({
  createPullRequest: jest.fn(),
  searchCode: jest.fn(), getFileContents: jest.fn(), listOpenPrsWithStatus: jest.fn(), listOpenPrsBare: jest.fn(),
  default: { triggerWorkflow: jest.fn(), getWorkflowRuns: jest.fn().mockResolvedValue({ workflow_runs: [] }) },
}));
const stopTaskMock = jest.fn();
jest.mock('../src/services/aws-ecs-admin', () => ({
  dispatchExecutorJobAws: jest.fn(),
  stopExecutorTaskAws: (...a: unknown[]) => stopTaskMock(...a),
}));
const bridgeMock = jest.fn(async () => undefined);
jest.mock('../src/services/dev-autopilot-bridge', () => ({ bridgeFailureToSelfHealing: (...a: unknown[]) => bridgeMock(...(a as [])) }));
jest.mock('../src/services/dev-autopilot-outcomes', () => ({
  recordExecutionOutcomeMemory: jest.fn().mockResolvedValue(undefined),
  appendAgentRunUsage: jest.fn().mockResolvedValue(undefined),
}));

// PostgREST double behind global fetch (the executor's own `supa` helper is
// module-internal, so it must be caught at the fetch layer): rows by id,
// PATCH merges the body (status filter honoured), every call recorded.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://supa.test';
process.env.SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || 'k';
type Row = Record<string, any>;
const db: { rows: Map<string, Row>; calls: Array<{ path: string; method: string; body?: any }> } = { rows: new Map(), calls: [] };
function resetDb(rows: Row[]) { db.rows = new Map(rows.map((r) => [r.id, { ...r }])); db.calls = []; }
function res(status: number, data?: unknown) {
  const text = data === undefined ? '' : JSON.stringify(data);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => (data === undefined ? null : JSON.parse(text)) } as any; // fresh copy, like real PostgREST
}
const fetchMock = jest.fn(async (url: string, init: any = {}) => {
  const p = url.replace(/^https?:\/\/[^/]+/, '');
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  db.calls.push({ path: p, method, body });
  if (!p.startsWith('/rest/v1/dev_autopilot_executions')) return res(200, []);
  const m = p.match(/dev_autopilot_executions\?id=eq\.([^&]+)/);
  const id = m ? decodeURIComponent(m[1]) : null;
  const row = id ? db.rows.get(id) : undefined;
  if (method === 'GET') return res(200, row ? [row] : []);
  if (method === 'PATCH') {
    if (!row) return res(204);
    const f = p.match(/status=eq\.([a-z_]+)/);
    if (f && row.status !== f[1]) return res(204);
    Object.assign(row, body);
    return res(204);
  }
  return res(200, []);
});
beforeAll(() => { (global as any).fetch = fetchMock; });

import { emitOasisEvent } from '../src/services/oasis-event-service';
import { startExecutionHeartbeat, heartbeatReadPath, cancelRequestedOnRow } from '../src/services/autopilot-agent/agent-heartbeat';
import { runAgentLoop } from '../src/services/autopilot-agent/agent-loop';
import { cancelExecution, applyExecutionResult, recordDispatchedTask, CANCELLABLE_STATUSES } from '../src/services/dev-autopilot-execute';

const EXEC = 'ab12cd34-0000-4000-8000-000000000001';
const ARN = 'arn:aws:ecs:eu-central-1:472838866351:task/Vitana-ECS-Cluster/0123456789abcdef';
const S = { url: process.env.SUPABASE_URL as string, key: process.env.SUPABASE_SERVICE_ROLE as string } as any;
const emitted = () => (emitOasisEvent as jest.Mock).mock.calls.map((c) => c[0]);

beforeEach(() => {
  jest.useRealTimers();
  (emitOasisEvent as jest.Mock).mockClear();
  stopTaskMock.mockReset();
  bridgeMock.mockClear();
  resetDb([]);
});

describe('VTID-04032 heartbeat cancel read-back', () => {
  it('cancelRequestedOnRow: off-running status or a cancel marker; a plain running row is not', () => {
    expect(cancelRequestedOnRow({ status: 'running', metadata: {} })).toBe(false);
    expect(cancelRequestedOnRow({ status: 'running', metadata: null })).toBe(false);
    expect(cancelRequestedOnRow({ status: 'cancelled', metadata: {} })).toBe(true);
    expect(cancelRequestedOnRow({ status: 'running', metadata: { cancel_requested: { by: 'x' } } })).toBe(true);
    expect(cancelRequestedOnRow({ status: 'running', metadata: { cancelled: { by: 'x' } } })).toBe(true);
    expect(cancelRequestedOnRow(null)).toBe(false);
    expect(heartbeatReadPath(EXEC)).toBe(`/rest/v1/dev_autopilot_executions?id=eq.${EXEC}&select=status,metadata&limit=1`);
  });

  it('reads the row after each beat, fires onCancelRequested exactly once when the row was cancelled, and survives a failing read', async () => {
    jest.useFakeTimers();
    const rows = [{ status: 'running', metadata: {} }, { status: 'cancelled', metadata: { cancelled: { by: 'owner' } } }, { status: 'cancelled', metadata: {} }];
    let i = 0;
    const read = jest.fn(async () => rows[Math.min(i++, rows.length - 1)]);
    const patch = jest.fn(async () => undefined);
    const onCancel = jest.fn();
    const hb = startExecutionHeartbeat(S, EXEC, { intervalMs: 1000, patch, read, onCancelRequested: onCancel });
    await jest.advanceTimersByTimeAsync(1000);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(heartbeatReadPath(EXEC));
    expect(onCancel).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(onCancel).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(onCancel).toHaveBeenCalledTimes(1); // once, ever
    expect(patch).toHaveBeenCalledTimes(4); // beating continues (a no-op PATCH on a non-running row)
    hb.stop();

    const hb2 = startExecutionHeartbeat(S, EXEC, { intervalMs: 1000, patch, read: jest.fn(async () => { throw new Error('boom'); }), onCancelRequested: onCancel });
    await jest.advanceTimersByTimeAsync(1000);
    expect(onCancel).toHaveBeenCalledTimes(1);
    hb2.stop();
  });

  it('without onCancelRequested the beat never reads the row (VTID-04011 behaviour unchanged)', async () => {
    jest.useFakeTimers();
    const read = jest.fn(async () => ({ status: 'cancelled' }));
    const patch = jest.fn(async () => undefined);
    const hb = startExecutionHeartbeat(S, EXEC, { intervalMs: 1000, patch, read });
    await jest.advanceTimersByTimeAsync(2000);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
    hb.stop();
  });
});

describe('VTID-04032 loop stops on cancel', () => {
  const tools = [{ name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } }] as any;

  it('at a turn boundary: no further LLM call, cancelled:true, an error step', async () => {
    let flag = false;
    const callLlm = jest.fn(async () => { flag = true; return { ok: true, text: '', toolCalls: [{ name: 'read_file', arguments: { path: 'a' } }], provider: 'deepseek', model: 'deepseek-flash' }; });
    const execute = jest.fn(async () => ({ result: 'x', isError: false }));
    const steps: any[] = [];
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools, execute, callLlm, isCancelled: () => flag, onStep: (s) => steps.push(s), maxTurns: 10 } as any);
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(r.error).toBe('cancelled by operator');
    // The first call ran (flag flipped inside it); the tool boundary then stopped the loop before any tool executed.
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(steps.some((s) => s.kind === 'error' && s.detail === 'cancelled by operator')).toBe(true);
  });

  it('before the first turn when already cancelled; never when the predicate stays false', async () => {
    const callLlm = jest.fn(async () => ({ ok: true, text: '', toolCalls: [{ name: 'finish', arguments: { summary: 's', pr_title: 't', pr_body: 'b' } }] }));
    const execute = jest.fn(async () => ({ result: 'ok', isError: false, finish: { summary: 's', pr_title: 't', pr_body: 'b' } }));
    const r = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools, execute, callLlm, isCancelled: () => true } as any);
    expect(r).toMatchObject({ ok: false, cancelled: true, turns: 0 });
    expect(callLlm).not.toHaveBeenCalled();
    const r2 = await runAgentLoop({ systemPrompt: 's', prompt: 'p', tools, execute, callLlm, isCancelled: () => false, maxTurns: 1 } as any);
    expect(r2.cancelled).toBeUndefined();
    expect(callLlm).toHaveBeenCalledTimes(1);
  });
});

describe('VTID-04032 cancelExecution', () => {
  it('running row with a remembered task: StopTask with the ARN, row cancelled with the decision merged, one event, terminal side effects', async () => {
    resetDb([{ id: EXEC, status: 'running', metadata: { executor: 'agent', claimed_env: 'staging', ecs_task_arn: ARN } }]);
    stopTaskMock.mockResolvedValue({ ok: true });
    const r = await cancelExecution(EXEC, { actor: 'owner@example.test', reason: '  wrong file  ' });
    expect(r).toEqual({ ok: true, was: 'running', ecs_task_stopped: true });
    expect(stopTaskMock).toHaveBeenCalledWith(ARN, 'cancelled by owner@example.test: wrong file');
    const row = db.rows.get(EXEC)!;
    expect(row.status).toBe('cancelled');
    expect(row.cancelled_at).toBeTruthy();
    expect(row.metadata).toMatchObject({ executor: 'agent', claimed_env: 'staging', ecs_task_arn: ARN, cancelled: { by: 'owner@example.test', reason: 'wrong file', was: 'running', ecs_task_arn: ARN, ecs_task_stopped: true } });
    const patch = db.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path).toMatch(/status=eq\.running$/);
    const ev = emitted().filter((e) => e.type === 'dev_autopilot.execution.cancelled');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ execution_id: EXEC, actor: 'owner@example.test', was: 'running', ecs_task_stopped: true });
    expect(ev[0].message).toMatch(/ECS task stopped/);
  });

  it('running row where StopTask is refused: still cancelled, the error recorded on the row and returned, message says the agent stops itself', async () => {
    resetDb([{ id: EXEC, status: 'running', metadata: { ecs_task_arn: ARN } }]);
    stopTaskMock.mockResolvedValue({ ok: false, error: 'AccessDeniedException: ecs:StopTask' });
    const r = await cancelExecution(EXEC, { actor: 'u' });
    expect(r).toEqual({ ok: true, was: 'running', ecs_task_stopped: false, ecs_task_error: 'AccessDeniedException: ecs:StopTask' });
    expect(db.rows.get(EXEC)!.metadata.cancelled).toMatchObject({ ecs_task_stopped: false, ecs_task_error: 'AccessDeniedException: ecs:StopTask', reason: null });
    expect(emitted()[0].message).toMatch(/NOT stopped, agent stops on its next heartbeat/);
  });

  it('running row without a remembered task never calls StopTask; cooling row keeps the old behaviour; anything else is refused', async () => {
    resetDb([{ id: EXEC, status: 'running', metadata: null }]);
    expect(await cancelExecution(EXEC, { actor: 'u' })).toEqual({ ok: true, was: 'running' });
    expect(stopTaskMock).not.toHaveBeenCalled();
    expect(db.rows.get(EXEC)!.status).toBe('cancelled');

    resetDb([{ id: EXEC, status: 'cooling', metadata: {} }]);
    expect(await cancelExecution(EXEC)).toEqual({ ok: true, was: 'cooling' });
    expect(emitted().pop().message).toMatch(/cancelled during cooldown/);
    expect(stopTaskMock).not.toHaveBeenCalled();

    resetDb([{ id: EXEC, status: 'ci', metadata: {} }]);
    expect((await cancelExecution(EXEC)).error).toMatch(/execution is ci, only cooling\/running can be cancelled/);
    expect(db.rows.get(EXEC)!.status).toBe('ci');
    expect((await cancelExecution('missing')).error).toBe('execution not found');
    expect(CANCELLABLE_STATUSES).toEqual(['cooling', 'running']);
  });
});

describe('VTID-04032 applyExecutionResult and a cancel', () => {
  it('a cancelled agent result on a row the route already cancelled writes nothing more and never bridges', async () => {
    resetDb([{ id: EXEC, status: 'cancelled', metadata: { cancelled: { by: 'owner' } } }]);
    await applyExecutionResult(S, EXEC, { ok: false, cancelled: true, error: 'cancelled by operator', session_id: 'agent_x' });
    expect(db.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(bridgeMock).not.toHaveBeenCalled();
    expect(emitted()).toHaveLength(0);
  });

  it('a cancelled agent result on a row still running closes it as cancelled (not failed), one cancelled event, no bridge', async () => {
    resetDb([{ id: EXEC, status: 'running', metadata: { executor: 'agent', cancel_requested: { by: 'owner' } } }]);
    await applyExecutionResult(S, EXEC, { ok: false, cancelled: true, error: 'cancelled by operator', session_id: 'agent_x' });
    const row = db.rows.get(EXEC)!;
    expect(row.status).toBe('cancelled');
    expect(row.execution_session_id).toBe('agent_x');
    expect(row.metadata).toMatchObject({ executor: 'agent', cancel_requested: { by: 'owner' }, cancelled: { by: 'agent', was: 'running' } });
    const types = emitted().map((e) => e.type);
    expect(types).toEqual(['dev_autopilot.execution.cancelled']);
    expect(bridgeMock).not.toHaveBeenCalled();
  });

  it('a late FAILED result on an already-cancelled row is ignored: no failed patch, no failed event, no self-heal', async () => {
    resetDb([{ id: EXEC, status: 'cancelled', metadata: { cancelled: { by: 'owner' } } }]);
    await applyExecutionResult(S, EXEC, { ok: false, error: 'deadline exceeded', session_id: 'agent_x' });
    expect(db.rows.get(EXEC)!.status).toBe('cancelled');
    expect(db.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(emitted().map((e) => e.type)).not.toContain('dev_autopilot.execution.failed');
    expect(bridgeMock).not.toHaveBeenCalled();
  });

  it('an ordinary failure on a running row still fails and bridges (unchanged)', async () => {
    resetDb([{ id: EXEC, status: 'running', metadata: { executor: 'agent' } }]);
    await applyExecutionResult(S, EXEC, { ok: false, error: 'tsc failed', session_id: 'agent_x' });
    expect(db.rows.get(EXEC)!.status).toBe('failed');
    expect(emitted().map((e) => e.type)).toContain('dev_autopilot.execution.failed');
    expect(bridgeMock).toHaveBeenCalledTimes(1);
  });

  it('recordDispatchedTask merges the ECS task ARN into the existing metadata', async () => {
    resetDb([{ id: EXEC, status: 'running', metadata: { executor: 'agent', claimed_env: 'staging' } }]);
    await recordDispatchedTask(S, EXEC, ARN);
    expect(db.rows.get(EXEC)!.metadata).toMatchObject({ executor: 'agent', claimed_env: 'staging', ecs_task_arn: ARN });
    expect(db.rows.get(EXEC)!.metadata.dispatched_at).toBeTruthy();
  });
});

describe('VTID-04032 wiring', () => {
  const SRC = path.resolve(__dirname, '../src');
  const runner = fs.readFileSync(path.join(SRC, 'services/autopilot-agent/run-agent-execution.ts'), 'utf8');
  const execute = fs.readFileSync(path.join(SRC, 'services/dev-autopilot-execute.ts'), 'utf8');
  const routes = fs.readFileSync(path.join(SRC, 'routes/dev-autopilot.ts'), 'utf8');
  const appJs = fs.readFileSync(path.join(SRC, 'frontend/command-hub/app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(SRC, 'frontend/command-hub/index.html'), 'utf8');

  it('runner: heartbeat raises the flag, the loop polls it, every check and the push are guarded, the outcome is cancelled', () => {
    expect(runner).toContain('onCancelRequested: () => {');
    expect(runner).toContain('isCancelled: () => cancelRequested,');
    expect(runner).toContain('if (loop.cancelled || cancelRequested) return cancelledResult();');
    expect((runner.match(/if \(cancelRequested\) return cancelledResult\(\);/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(runner).toMatch(/if \(cancelRequested\) return cancelledResult\(\);\s*\n\s*const \{ sha \} = await commitAndPush\(/);
    expect(runner).toContain("run.outcome = !r.ok ? (r.cancelled ? 'cancelled' : 'failed')");
  });

  it('dispatch records the task ARN on the AWS path; the route passes the verified actor and the body reason', () => {
    expect(execute).toMatch(/if \(JOB_CLOUD === 'aws' && dispatched\.operation\) \{\s*\n\s*recordDispatchedTask\(s, exec\.id, dispatched\.operation\)/);
    expect(routes).toContain("const r = await cancelExecution(req.params.id, { actor: approvalActor(req), reason });");
  });

  it('Command Hub: Cancel on running/cooling Live rows, reason prompt, lists updated in place, cache-bust bumped', () => {
    expect(appJs).toContain("if (exec.status === 'running' || exec.status === 'cooling') {");
    expect(appJs).toContain("liveCancelBtn.onclick = function () { devAutopilotCancelExecution(exec.id); };");
    const start = appJs.indexOf('\nfunction devAutopilotCancelExecution(');
    const body = appJs.slice(start, appJs.indexOf('\nfunction ', start + 1));
    expect(body).toContain("window.prompt('Cancel this execution?");
    expect(body).toContain("devAutopilotApi('/executions/' + execId + '/cancel', 'POST', { reason: reason })");
    expect(body).toContain("Object.assign({}, e, { status: 'cancelled'");
    expect(body).toContain("data.was === 'running'");
    // At-or-after: a later Command Hub change bumps the same string (VTID-04033).
    const ver = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260917-vtid-04032-cancel-running').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + ver);
  });
});
