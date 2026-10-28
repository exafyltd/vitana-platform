/**
 * VTID-04415 — delegation jobs written through to the run ledger (agent_runs).
 */
import {
  cancelJob,
  clearDelegationTargets,
  delegateToAgent,
  findJob,
  latestJob,
  registerDelegationTarget,
  resetDelegationJobs,
  setDelegationRunStore,
  type DelegationCaller,
  type DelegationTarget,
} from '../../../src/services/orchestrator/dispatcher';
import {
  boundResult,
  createSupabaseDelegationRunStore,
  defaultDelegationRunStore,
  fromRow,
  isPersistableJob,
  MAX_PERSISTED_RESULT_CHARS,
  toStartRow,
  type DelegationRunStore,
  type PersistableJob,
} from '../../../src/services/orchestrator/delegation-run-store';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const T1 = '33333333-3333-4333-8333-333333333333';

const caller = (o: Partial<DelegationCaller> = {}): DelegationCaller => ({
  user_id: U1, tenant_id: T1, platform_role: 'developer', exafy_admin: true,
  surface: 'command-hub', channel: 'voice', session_id: 's1', ...o,
});
const target = (o: Partial<DelegationTarget> = {}): DelegationTarget => ({
  agent_id: 'echo', description: 'test', surfaces: ['command-hub', 'vitanaland'], domain: 'dev', tier: 'read',
  run: jest.fn(async (r: string) => ({ ok: true, result: { echo: r } })), ...o,
});
const flush = () => new Promise((r) => setTimeout(r, 5));

/** In-memory fake that records the order of calls. */
function fakeStore() {
  const rows = new Map<string, PersistableJob>();
  const calls: string[] = [];
  const store: DelegationRunStore = {
    recordStart: jest.fn(async (job) => { await flush(); calls.push(`start:${job.status}`); rows.set(job.job_id, { ...job }); }),
    recordFinish: jest.fn(async (job) => { calls.push(`finish:${job.status}`); rows.set(job.job_id, { ...job }); }),
    find: jest.fn(async (id) => rows.get(id) ?? null),
    latest: jest.fn(async () => [...rows.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null),
  };
  return { store, rows, calls };
}

beforeEach(() => {
  clearDelegationTargets();
  resetDelegationJobs();
  setDelegationRunStore(null);
});
afterAll(() => setDelegationRunStore(undefined));

describe('VTID-04415 opt-in', () => {
  test('AC-1: the default store is null unless the flag is exactly "true"', () => {
    expect(defaultDelegationRunStore({})).toBeNull();
    expect(defaultDelegationRunStore({ ORCHESTRATOR_DELEGATION_PERSIST_ENABLED: 'TRUE' })).toBeNull();
    expect(defaultDelegationRunStore({ ORCHESTRATOR_DELEGATION_PERSIST_ENABLED: 'true' })).not.toBeNull();
  });
});

describe('VTID-04415 write-through', () => {
  test('AC-2: start is written, and finish is written only after start — even when the job finishes inside the ack window', async () => {
    const { store, calls, rows } = fakeStore();
    setDelegationRunStore(store);
    registerDelegationTarget(target());
    const r = await delegateToAgent('echo', 'hello', caller());
    expect(r.status).toBe('done');
    await flush(); await flush();
    expect(calls).toEqual(['start:running', 'finish:succeeded']);
    expect(rows.get((r as { job_id: string }).job_id)).toMatchObject({ status: 'succeeded', result: { echo: 'hello' } });
    expect((store.recordStart as jest.Mock).mock.calls[0][1]).toEqual({ tenant_id: T1, platform_role: 'developer', channel: 'voice' });
    expect((store.recordStart as jest.Mock).mock.calls[0][2]).toBe('read');
  });

  test('AC-3: a cancelled job is written as cancelled', async () => {
    const { store, calls } = fakeStore();
    setDelegationRunStore(store);
    registerDelegationTarget(target({ run: () => new Promise(() => undefined) }));
    const r = await delegateToAgent('echo', 'slow', caller(), { ackWindowMs: 1 });
    expect(r.status).toBe('working');
    expect(cancelJob((r as { job_id: string }).job_id, caller()).ok).toBe(true);
    await flush(); await flush();
    expect(calls).toEqual(['start:running', 'finish:cancelled']);
  });

  test('AC-4: a failing store never changes the delegation outcome', async () => {
    const broken: DelegationRunStore = {
      recordStart: jest.fn(async () => { throw new Error('db down'); }),
      recordFinish: jest.fn(async () => { throw new Error('db down'); }),
      find: jest.fn(async () => { throw new Error('db down'); }),
      latest: jest.fn(async () => null),
    };
    setDelegationRunStore(broken);
    registerDelegationTarget(target());
    const r = await delegateToAgent('echo', 'hi', caller());
    expect(r).toMatchObject({ status: 'done', result: { echo: 'hi' } });
    await flush();
    expect(broken.recordFinish).toHaveBeenCalled();
  });
});

describe('VTID-04415 reading across gateway tasks', () => {
  test('AC-5: a job this task no longer holds is found in the ledger, only by its owner on its surface', async () => {
    const { store } = fakeStore();
    setDelegationRunStore(store);
    registerDelegationTarget(target());
    const r = (await delegateToAgent('echo', 'q', caller())) as { job_id: string };
    await flush(); await flush();
    resetDelegationJobs(); // the next session lands on another task

    expect(await findJob(r.job_id, caller())).toMatchObject({ job_id: r.job_id, status: 'succeeded', result: { echo: 'q' } });
    // Even if the store answered with the row, a different owner or surface reads nothing.
    expect(await findJob(r.job_id, caller({ user_id: U2 }))).toBeNull();
    expect(await findJob(r.job_id, caller({ surface: 'vitanaland' }))).toBeNull();
    expect(await findJob(r.job_id, caller({ user_id: null }))).toBeNull();
  });

  test('AC-6: latestJob prefers the newest of local and ledger; without a store it is local only', async () => {
    const { store, rows } = fakeStore();
    rows.set('old-remote', {
      job_id: 'old-remote', agent_id: 'echo', user_id: U1, surface: 'command-hub', session_id: 'x', status: 'succeeded',
      request: 'r', result: 1, error: null, created_at: '2020-01-01T00:00:00.000Z', completed_at: '2020-01-01T00:00:01.000Z',
    });
    setDelegationRunStore(store);
    registerDelegationTarget(target());
    const r = (await delegateToAgent('echo', 'new', caller())) as { job_id: string };
    expect((await latestJob(caller()))?.job_id).toBe(r.job_id);
    resetDelegationJobs();
    await flush();
    expect((await latestJob(caller()))?.job_id).toBe(r.job_id);

    setDelegationRunStore(null);
    expect(await latestJob(caller())).toBeNull();
  });
});

describe('VTID-04415 row shape', () => {
  const job: PersistableJob = {
    job_id: '44444444-4444-4444-8444-444444444444', agent_id: 'support', user_id: U1, surface: 'vitanaland',
    session_id: 'live-1', status: 'running', request: 'x'.repeat(900), result: null, error: null,
    created_at: '2026-09-23T10:00:00.000Z', completed_at: null,
  };

  test('AC-7: the start row fits agent_runs (plane orb, surface in metadata, intent bounded, created_via allowed)', () => {
    const row = toStartRow(job, { tenant_id: 'not-a-uuid', platform_role: 'community', channel: 'voice' }, 'read');
    expect(row).toMatchObject({
      id: job.job_id, agent_id: 'support', plane: 'orb', user_id: U1, tenant_id: null, status: 'running',
      tier: 'read', created_via: 'voice', metadata: { surface: 'vitanaland', session_id: 'live-1', source: 'delegate_to_agent' },
    });
    expect((row.intent as string).length).toBe(500);
    expect(toStartRow(job, { tenant_id: null, platform_role: null, channel: 'weird' }, 'bogus')).toMatchObject({ created_via: 'system', tier: null });
  });

  test('AC-8: only uuid-keyed jobs persist; results are bounded; unknown rows are rejected', () => {
    expect(isPersistableJob(job)).toBe(true);
    expect(isPersistableJob({ ...job, user_id: 'u1' })).toBe(false);
    expect(isPersistableJob({ ...job, job_id: 'x' })).toBe(false);
    const big = boundResult({ s: 'y'.repeat(MAX_PERSISTED_RESULT_CHARS + 10) });
    expect(big.truncated).toBe(true);
    expect((big.result as string).length).toBe(MAX_PERSISTED_RESULT_CHARS);
    expect(boundResult({ a: 1 })).toEqual({ result: { a: 1 }, truncated: false });
    const base = { id: job.job_id, agent_id: 'support', user_id: U1, intent: 'q', result_ref: { result: 'r' }, error: null,
      created_at: job.created_at, completed_at: null };
    expect(fromRow({ ...base, status: 'succeeded', metadata: { surface: 'vitanaland' } })).toMatchObject({ result: 'r', surface: 'vitanaland' });
    expect(fromRow({ ...base, status: 'queued', metadata: { surface: 'vitanaland' } })).toBeNull();
    expect(fromRow({ ...base, status: 'succeeded', metadata: {} })).toBeNull();
  });

  test('AC-9: the Supabase store filters by plane, owner and surface on read', async () => {
    const filters: Array<[string, unknown]> = [];
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: unknown) => { filters.push([k, v]); return chain; },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    const sb: any = { from: (t: string) => { expect(t).toBe('agent_runs'); return chain; } };
    const store = createSupabaseDelegationRunStore(async () => sb);
    expect(await store.find(job.job_id, { user_id: U1, surface: 'vitanaland' })).toBeNull();
    expect(filters).toEqual([['id', job.job_id], ['plane', 'orb'], ['user_id', U1], ['metadata->>surface', 'vitanaland']]);
    expect(await store.find('not-a-uuid', { user_id: U1, surface: 'vitanaland' })).toBeNull();
  });
});
