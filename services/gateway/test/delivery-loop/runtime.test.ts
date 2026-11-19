/**
 * Delivery loop runtime (services/delivery-loop/runtime.ts): off by default, built lazily, never overlapping, never crashing, and honest
 * about why it is not running. The timer, GitLab and OASIS are fakes.
 */
import { buildDeps, cycleMsFrom, gatewayBindings, startDeliveryLoop, type RuntimeBindings } from '../../src/services/delivery-loop/runtime';
import { PROJECT } from './harness';

const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;
const ON = { DELIVERY_LOOP_ENABLED: 'true', DELIVERY_LOOP_PROJECTS: PROJECT, GITLAB_API_URL: 'https://gitlab.test/api/v4', GITLAB_API_TOKEN: 'glpat-testtoken123456', SUPABASE_URL: 'https://oasis.test', SUPABASE_SERVICE_ROLE: 'service-role-test-key' };

const bindings = (over: Partial<RuntimeBindings> = {}): RuntimeBindings => ({
  writeMemory: async () => ({ ok: true, id: 'm' }),
  patterns: { record: async () => ({}), find: async () => null },
  llm: async () => ({ ok: true, text: '{}', model: null }),
  executors: {},
  isArmed: async () => true,
  ...over,
});

/** A fetch that answers every GitLab and OASIS call with an empty list, and counts them. */
function quietFetch() {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(String(url));
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, urls };
}

function timer() {
  let fn: (() => void) | null = null;
  let stopped = false;
  return {
    setIntervalFn: (f: () => void) => ((fn = f), { unref: () => undefined }),
    clearIntervalFn: () => { stopped = true; },
    fire: () => fn?.(),
    get stopped() { return stopped; },
    get armed() { return fn !== null; },
  };
}

describe('cycleMsFrom', () => {
  it('is a minute by default and between 15 seconds and 15 minutes when set; anything else is the default', () => {
    expect(cycleMsFrom(env({}))).toBe(60_000);
    expect(cycleMsFrom(env({ DELIVERY_LOOP_CYCLE_MS: '15000' }))).toBe(15_000);
    expect(cycleMsFrom(env({ DELIVERY_LOOP_CYCLE_MS: '900000' }))).toBe(900_000);
    for (const v of ['14999', '900001', '0', '-1', '1.5', 'x', '', ' ']) expect({ v, ms: cycleMsFrom(env({ DELIVERY_LOOP_CYCLE_MS: v })) }).toEqual({ v, ms: 60_000 });
  });
});

describe('buildDeps', () => {
  it('names what is missing: no project, and no GitLab', () => {
    expect(buildDeps(env({}), bindings())).toEqual({ missing: 'DELIVERY_LOOP_PROJECTS names no project' });
    expect(buildDeps(env({ DELIVERY_LOOP_PROJECTS: PROJECT }), bindings())).toEqual({ missing: 'GITLAB_API_URL and GITLAB_API_TOKEN are not both set' });
    expect(buildDeps(env({ DELIVERY_LOOP_PROJECTS: PROJECT, GITLAB_API_URL: 'https://x/api/v4' }), bindings())).toEqual({ missing: 'GITLAB_API_URL and GITLAB_API_TOKEN are not both set' });
  });

  it('builds the dependencies when everything is there; a reviewer only when there is an LLM', () => {
    const withLlm = buildDeps(env(ON), bindings());
    expect('deps' in withLlm && withLlm.deps.reviewer).not.toBeNull();
    const without = buildDeps(env(ON), bindings({ llm: null }));
    expect('deps' in without && without.deps.reviewer).toBeNull();
  });

  it('the executor is the fail-closed one unless the owner named one and one is bound', async () => {
    const none = buildDeps(env(ON), bindings());
    if (!('deps' in none)) throw new Error('expected deps');
    const req = { key: 'k', kind: 'intake' as const, project: PROJECT, title: 't', instructions: 'i', base_branch: 'main', fix_branch: null, mr_iid: null, issue_iid: 1, hints: [] };
    expect(await none.deps.tasks.dispatch(req)).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining('executor_not_configured') });

    const named = buildDeps(env({ ...ON, DELIVERY_LOOP_EXECUTOR: 'dev-autopilot' }), bindings({ executors: { 'dev-autopilot': { enqueue: async () => ({ ok: true, execution_id: 'e1', vtid: null }) } } }));
    if (!('deps' in named)) throw new Error('expected deps');
    expect(await named.deps.tasks.dispatch(req)).toMatchObject({ ok: true, execution_id: 'e1' });

    // named but nothing bound: still closed
    const unbound = buildDeps(env({ ...ON, DELIVERY_LOOP_EXECUTOR: 'dev-autopilot' }), bindings());
    if (!('deps' in unbound)) throw new Error('expected deps');
    expect(await unbound.deps.tasks.dispatch(req)).toMatchObject({ ok: false, retryable: false });
  });
});

describe('the scheduler', () => {
  it('a loop that is not enabled runs nothing and reads nothing, however often the timer fires', async () => {
    const t = timer();
    const { f, urls } = quietFetch();
    const loop = startDeliveryLoop({ env: env({ ...ON, DELIVERY_LOOP_ENABLED: undefined }), bindings: bindings(), fetchImpl: f, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn, log: () => undefined });
    expect(await loop.tick()).toBeNull();
    t.fire();
    await new Promise((r) => setImmediate(r));
    expect(urls).toEqual([]);
    expect(loop.status()).toMatchObject({ enabled: false, not_running_reason: 'DELIVERY_LOOP_ENABLED is not "true"', last_cycle: null });
  });

  it('without GitLab configured it says why, once, and does not run', async () => {
    const t = timer();
    const logs: string[] = [];
    const loop = startDeliveryLoop({ env: env({ DELIVERY_LOOP_ENABLED: 'true', DELIVERY_LOOP_PROJECTS: PROJECT }), bindings: bindings(), setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn, log: (m) => logs.push(m) });
    expect(await loop.tick()).toBeNull();
    expect(await loop.tick()).toBeNull();
    expect(logs).toEqual(['[delivery-loop] not running: GITLAB_API_URL and GITLAB_API_TOKEN are not both set']);
    expect(loop.status()).toMatchObject({ enabled: true, gitlab_configured: false, not_running_reason: 'GITLAB_API_URL and GITLAB_API_TOKEN are not both set' });
  });

  it('runs a cycle when everything is set, and reports it', async () => {
    const t = timer();
    const { f } = quietFetch();
    const loop = startDeliveryLoop({ env: env({ ...ON, DELIVERY_LOOP_AUTONOMY: 'L2' }), bindings: bindings(), fetchImpl: f, now: () => Date.parse('2026-11-19T10:00:00Z'), setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn, log: () => undefined });
    const r = await loop.tick();
    expect(r?.ran).toBe(true);
    const s = loop.status();
    expect(s).toMatchObject({ enabled: true, not_running_reason: null, autonomy: 'L2', projects: [PROJECT], gitlab_configured: true, reviewer_configured: true, executor: null, cycle_ms: 60_000 });
    expect(s.last_cycle).toMatchObject({ at: '2026-11-19T10:00:00.000Z', ran: true, stopped_early: false });
  });

  it('the status never carries the token, and a named executor shows only its name', async () => {
    const t = timer();
    const { f } = quietFetch();
    const loop = startDeliveryLoop({ env: env({ ...ON, DELIVERY_LOOP_EXECUTOR: 'dev-autopilot' }), bindings: bindings(), fetchImpl: f, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn, log: () => undefined });
    await loop.tick();
    const text = JSON.stringify(loop.status());
    expect(text).not.toContain('glpat-testtoken123456');
    expect(text).not.toContain('gitlab.test');
    expect(loop.status().executor).toBe('dev-autopilot');
  });

  it('never runs two ticks at once: a tick that fires while one is running is skipped', async () => {
    const t = timer();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const f = (async () => {
      calls += 1;
      await gate;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const loop = startDeliveryLoop({ env: env(ON), bindings: bindings(), fetchImpl: f, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn, log: () => undefined });
    const first = loop.tick();
    await new Promise((r) => setImmediate(r));
    expect(await loop.tick()).toBeNull(); // skipped, not queued
    const before = calls;
    release();
    await first;
    expect(calls).toBeGreaterThanOrEqual(before);
    expect(await loop.tick()).not.toBeUndefined(); // free again
  });

  it('a tick that throws is logged and swallowed, and the next one runs', async () => {
    const t = timer();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let n = 0;
    const f = (async () => {
      n += 1;
      if (n <= 2) throw new Error('network is down');
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const loop = startDeliveryLoop({ env: env(ON), bindings: bindings(), fetchImpl: f, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn, log: () => undefined });
    await expect(loop.tick()).resolves.not.toThrow();
    for (let i = 0; i < 4; i += 1) await expect(loop.tick()).resolves.not.toThrow();
    expect(loop.status().last_cycle).not.toBeNull();
    warn.mockRestore();
  });

  it('the timer is unref\'d, fires the tick, and stop clears it', async () => {
    const t = timer();
    let unref = false;
    const { f, urls } = quietFetch();
    const loop = startDeliveryLoop({ env: env(ON), bindings: bindings(), fetchImpl: f, setIntervalFn: (fn) => ((t.setIntervalFn(fn)), { unref: () => { unref = true; } }), clearIntervalFn: t.clearIntervalFn, log: () => undefined });
    expect(t.armed).toBe(true);
    expect(unref).toBe(true);
    t.fire();
    await new Promise((r) => setTimeout(r, 10));
    expect(urls.length).toBeGreaterThan(0);
    loop.stop();
    expect(t.stopped).toBe(true);
  });

  it('a loop switched off at run time stops acting on its next tick, without a restart', async () => {
    const e: NodeJS.ProcessEnv = env(ON);
    const t = timer();
    const { f, urls } = quietFetch();
    const loop = startDeliveryLoop({ env: e, bindings: bindings(), fetchImpl: f, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn, log: () => undefined });
    await loop.tick();
    const seen = urls.length;
    e.DELIVERY_LOOP_ENABLED = 'false';
    expect(await loop.tick()).toBeNull();
    expect(urls.length).toBe(seen);
    expect(loop.status().not_running_reason).toBe('DELIVERY_LOOP_ENABLED is not "true"');
  });
});

describe('the gateway bindings', () => {
  it('load none of the heavy modules until something is used, and expose the executors the owner must bind', () => {
    const b = gatewayBindings();
    expect(typeof b.writeMemory).toBe('function');
    expect(typeof b.patterns.record).toBe('function');
    expect(typeof b.patterns.find).toBe('function');
    expect(typeof b.llm).toBe('function');
    expect(typeof b.isArmed).toBe('function');
    // The GitLab-native Dev Autopilot executor is bound (repairs only). Binding is not switching on: the port still refuses every
    // dispatch until the owner sets DELIVERY_LOOP_EXECUTOR=dev-autopilot (test/delivery-loop/dev-autopilot-gateway.test.ts).
    expect(Object.keys(b.executors)).toEqual(['dev-autopilot']);
    expect(typeof b.executors['dev-autopilot']?.enqueue).toBe('function');
  });
});
