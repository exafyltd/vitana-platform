/**
 * VTID-04375 — Orchestrator v2 P3 dispatcher (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.4, §5 P3).
 *
 * AC-1 delegateToAgent refuses an unknown agent (naming the ones available
 *      here), a surface the agent does not serve, an anonymous caller and an
 *      empty request — and runs nothing.
 * AC-2 the policy decides: a role without authority is refused; a tier the
 *      channel cannot confirm escalates without running.
 * AC-3 async pattern: a result inside the ack window is returned now; a slow
 *      agent returns `working` with a job id at once and the result is read
 *      later; a failure is reported, never thrown.
 * AC-4 cancel: a running job is cancelled, its late result discarded, and
 *      the agent's AbortSignal fires.
 * AC-5 isolation: a job is readable/cancellable only by the same user on the
 *      same surface — a job created in backoffice is not found from a
 *      community (vitanaland) session.
 * AC-6 the operator target reuses the VTID-04310 operator turn with the
 *      caller's verified identity and is command-hub only.
 */

import {
  cancelJob,
  clearDelegationTargets,
  delegateToAgent,
  getJob,
  jobStats,
  listDelegationTargets,
  listJobs,
  registerDelegationTarget,
  resetDelegationJobs,
  type DelegationCaller,
  type DelegationTarget,
} from '../../../src/services/orchestrator/dispatcher';

jest.mock('../../../src/orb/live/tools/operator-delegate', () => ({
  runOperatorDelegate: jest.fn(async () => ({ success: true, result: JSON.stringify({ operator_reply: 'queued', executions: [] }) })),
}));
import { runOperatorDelegate } from '../../../src/orb/live/tools/operator-delegate';
import { OPERATOR_TARGET, registerDefaultDelegationTargets, resetDefaultRegistration } from '../../../src/services/orchestrator/delegation-targets';

const caller = (o: Partial<DelegationCaller> = {}): DelegationCaller => ({
  user_id: 'u1', tenant_id: 't', platform_role: 'developer', exafy_admin: true,
  surface: 'command-hub', channel: 'voice', session_id: 's1', ...o,
});

function target(o: Partial<DelegationTarget> = {}): DelegationTarget {
  return {
    agent_id: 'echo', description: 'test agent', surfaces: ['command-hub', 'backoffice'],
    domain: 'dev', tier: 'read', run: jest.fn(async (r: string) => ({ ok: true, result: { echo: r } })), ...o,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  clearDelegationTargets();
  resetDelegationJobs();
});

describe('refusals (AC-1)', () => {
  test('unknown agent names the available ones', async () => {
    registerDelegationTarget(target());
    const r = await delegateToAgent('nope', 'x', caller());
    expect(r).toMatchObject({ status: 'refused' });
    expect((r as any).error).toMatch(/available here: echo/);
  });

  test('wrong surface, anonymous caller, empty request: nothing runs', async () => {
    const t = target();
    registerDelegationTarget(t);
    expect((await delegateToAgent('echo', 'x', caller({ surface: 'vitanaland' }))).status).toBe('refused');
    expect((await delegateToAgent('echo', 'x', caller({ user_id: null }))).status).toBe('refused');
    expect((await delegateToAgent('echo', '   ', caller())).status).toBe('refused');
    expect(t.run).not.toHaveBeenCalled();
  });

  test('targets are listed per surface', () => {
    registerDelegationTarget(target());
    expect(listDelegationTargets('backoffice').map((t) => t.agent_id)).toEqual(['echo']);
    expect(listDelegationTargets('vitanaland')).toEqual([]);
  });
});

describe('policy (AC-2)', () => {
  test('a role without authority in the domain is refused', async () => {
    const t = target();
    registerDelegationTarget(t);
    const r = await delegateToAgent('echo', 'x', caller({ platform_role: 'community' }));
    expect(r).toMatchObject({ status: 'refused', policy: { decision: 'deny' } });
    expect(t.run).not.toHaveBeenCalled();
  });

  test('a commit-tier target by voice escalates without running', async () => {
    const t = target({ tier: 'commit' });
    registerDelegationTarget(t);
    const r = await delegateToAgent('echo', 'x', caller());
    expect(r).toMatchObject({ status: 'escalate', policy: { decision: 'escalate' } });
    expect(t.run).not.toHaveBeenCalled();
  });
});

describe('async pattern (AC-3)', () => {
  test('fast agent: result now', async () => {
    registerDelegationTarget(target());
    const r = await delegateToAgent('echo', 'hi', caller());
    expect(r).toMatchObject({ status: 'done', result: { echo: 'hi' } });
  });

  test('slow agent: working at once, result on a later read', async () => {
    let release!: () => void;
    registerDelegationTarget(target({ run: () => new Promise((res) => { release = () => res({ ok: true, result: 'late' }); }) }));
    const t0 = Date.now();
    const r = await delegateToAgent('echo', 'hi', caller(), { ackWindowMs: 20 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.status).toBe('working');
    const id = (r as any).job_id;
    expect(getJob(id, caller())).toMatchObject({ status: 'running' });
    release();
    await flush();
    expect(getJob(id, caller())).toMatchObject({ status: 'succeeded', result: 'late' });
    expect(listJobs(caller())).toHaveLength(1);
    expect(jobStats().by_agent.echo.succeeded).toBe(1);
  });

  test('agent failure or throw is reported, never thrown', async () => {
    registerDelegationTarget(target({ run: async () => ({ ok: false, result: null, error: 'nope' }) }));
    expect(await delegateToAgent('echo', 'x', caller())).toMatchObject({ status: 'failed', error: 'nope' });
    registerDelegationTarget(target({ run: async () => { throw new Error('boom'); } }));
    expect(await delegateToAgent('echo', 'x', caller())).toMatchObject({ status: 'failed', error: 'boom' });
  });
});

describe('cancel (AC-4)', () => {
  test('cancelled job discards the late result and aborts the signal', async () => {
    let release!: () => void;
    let signal!: AbortSignal;
    registerDelegationTarget(target({ run: (_r, _c, s) => { signal = s; return new Promise((res) => { release = () => res({ ok: true, result: 'late' }); }); } }));
    const r = await delegateToAgent('echo', 'x', caller(), { ackWindowMs: 10 });
    const id = (r as any).job_id;
    expect(cancelJob(id, caller())).toEqual({ ok: true, status: 'cancelled' });
    expect(signal.aborted).toBe(true);
    release();
    await flush();
    expect(getJob(id, caller())).toMatchObject({ status: 'cancelled', result: null });
    expect(cancelJob(id, caller())).toMatchObject({ ok: false, status: 'cancelled' });
  });
});

describe('isolation (AC-5)', () => {
  test('a backoffice job is invisible from a community session and to another user', async () => {
    registerDelegationTarget(target({ run: () => new Promise(() => {}) }));
    const bo = caller({ surface: 'backoffice' });
    const r = await delegateToAgent('echo', 'x', bo, { ackWindowMs: 10 });
    const id = (r as any).job_id;
    expect(getJob(id, bo)).not.toBeNull();
    expect(getJob(id, { user_id: 'u1', surface: 'vitanaland' })).toBeNull();
    expect(getJob(id, { user_id: 'u2', surface: 'backoffice' })).toBeNull();
    expect(cancelJob(id, { user_id: 'u1', surface: 'vitanaland' })).toMatchObject({ ok: false, error: 'job not found' });
    expect(listJobs({ user_id: 'u1', surface: 'vitanaland' })).toEqual([]);
  });
});

describe('operator target (AC-6)', () => {
  beforeEach(() => resetDefaultRegistration());

  test('registered for command-hub only, dev domain', () => {
    registerDefaultDelegationTargets();
    expect(listDelegationTargets('command-hub').map((t) => t.agent_id)).toContain('operator');
    expect(listDelegationTargets('vitanaland').map((t) => t.agent_id)).not.toContain('operator');
    expect(OPERATOR_TARGET).toMatchObject({ domain: 'dev', tier: 'draft' });
  });

  test('runs the operator turn with the caller identity and parses the reply', async () => {
    registerDefaultDelegationTargets();
    const r = await delegateToAgent('operator', 'status of VTID-1', caller({ extras: { operator_thread_id: 'th-1' } }));
    expect(r).toMatchObject({ status: 'done', result: { operator_reply: 'queued' } });
    expect(runOperatorDelegate).toHaveBeenCalledWith(
      expect.objectContaining({ current_route: '/command-hub', operator_thread_id: 'th-1', identity: { user_id: 'u1', exafy_admin: true, tenant_id: 't' } }),
      { request: 'status of VTID-1' },
      expect.objectContaining({ waitMs: expect.any(Number) }),
    );
  });

  test('a community member cannot reach the operator', async () => {
    registerDefaultDelegationTargets();
    expect((await delegateToAgent('operator', 'x', caller({ platform_role: 'community' }))).status).toBe('refused');
  });
});
