/**
 * VTID-05141 (P4) — agents_registry.enabled is enforced before every native
 * agent_runs insert. Unknown agents and failed lookups are allowed (nothing
 * that works today breaks); enabled=false refuses the run and emits one
 * `agent.run.refused_disabled` event.
 */
import fs from 'fs';
import path from 'path';

const mockEmit = jest.fn(async (_e: unknown) => ({ ok: true }));
jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (e: unknown) => mockEmit(e),
}));
const mockDispatch = jest.fn();
jest.mock('../../../src/services/orb-tools-shared', () => ({
  dispatchOrbTool: (...a: unknown[]) => mockDispatch(...a),
}));

import { assertAgentEnabled, AGENT_RUN_REFUSED_EVENT } from '../../../src/services/orchestrator/run-ledger';
import { executeRecommendationAction } from '../../../src/services/community-autopilot/action-registry';
import { createSupabaseDelegationRunStore, type PersistableJob } from '../../../src/services/orchestrator/delegation-run-store';

type Registry = Record<string, { enabled: boolean }> | 'error' | 'throw';

/** Fake client: agents_registry lookups + an agent_runs insert recorder. */
function fakeSb(registry: Registry) {
  const inserts: Array<Record<string, unknown>> = [];
  const sb: any = {
    inserts,
    from(table: string) {
      if (table === 'agents_registry') {
        if (registry === 'throw') throw new Error('network down');
        let id = '';
        const chain: any = {
          select: () => chain,
          eq: (_c: string, v: string) => { id = v; return chain; },
          maybeSingle: async () => registry === 'error'
            ? { data: null, error: { message: 'relation unavailable' } }
            : { data: registry[id] ? { agent_id: id, ...registry[id] } : null, error: null },
        };
        return chain;
      }
      if (table === 'agent_runs') {
        const chain: any = {
          insert: async (row: Record<string, unknown>) => { inserts.push(row); return { error: null }; },
          update: () => chain,
          eq: () => chain,
          then: (res: any, rej: any) => Promise.resolve({ error: null }).then(res, rej),
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return sb;
}

let warn: jest.SpyInstance;
beforeEach(() => {
  mockEmit.mockClear();
  mockDispatch.mockReset();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('assertAgentEnabled', () => {
  it('allows an enabled agent without an event', async () => {
    const r = await assertAgentEnabled(fakeSb({ a: { enabled: true } }), 'a');
    expect(r).toEqual({ allowed: true, reason: 'enabled' });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('allows an agent with no registry row', async () => {
    const r = await assertAgentEnabled(fakeSb({}), 'ghost');
    expect(r).toEqual({ allowed: true, reason: 'unknown_agent' });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('allows (and logs) when the lookup returns an error', async () => {
    const r = await assertAgentEnabled(fakeSb('error'), 'a');
    expect(r).toEqual({ allowed: true, reason: 'lookup_failed' });
    expect(warn).toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('allows (and logs) when the lookup throws', async () => {
    const r = await assertAgentEnabled(fakeSb('throw'), 'a');
    expect(r).toEqual({ allowed: true, reason: 'lookup_failed' });
    expect(warn).toHaveBeenCalled();
  });

  it('refuses a disabled agent and emits exactly one warning event with agent_id', async () => {
    const r = await assertAgentEnabled(fakeSb({ a: { enabled: false } }), 'a', { plane: 'orb' });
    expect(r.allowed).toBe(false);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0]).toMatchObject({
      type: AGENT_RUN_REFUSED_EVENT,
      status: 'warning',
      payload: { agent_id: 'a', plane: 'orb' },
    });
    expect(AGENT_RUN_REFUSED_EVENT).toBe('agent.run.refused_disabled');
  });

  it('still refuses when the event emit fails', async () => {
    mockEmit.mockRejectedValueOnce(new Error('oasis down'));
    const r = await assertAgentEnabled(fakeSb({ a: { enabled: false } }), 'a');
    expect(r.allowed).toBe(false);
  });
});

describe('community autopilot action-registry', () => {
  const ctx = {
    userId: '11111111-1111-4111-8111-111111111111', tenantId: '33333333-3333-4333-8333-333333333333',
    recommendationId: 'rec-1', recommendationTitle: 'Hydration', channel: 'app' as const,
  };

  it('refuses the action when community-autopilot is disabled: no run row, no handler', async () => {
    const sb = fakeSb({ 'community-autopilot': { enabled: false } });
    const out = await executeRecommendationAction(sb, { kind: 'log_water', params: { amount_ml: 250 } }, ctx);
    expect(out).toMatchObject({ status: 'failed', kind: 'log_water', run_id: null });
    expect((out as { error: string }).error).toMatch(/disabled/);
    expect(sb.inserts).toHaveLength(0);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  it('runs as before when community-autopilot is enabled', async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: {} });
    const sb = fakeSb({ 'community-autopilot': { enabled: true } });
    const out = await executeRecommendationAction(sb, { kind: 'log_water', params: { amount_ml: 250 } }, ctx);
    expect(out.status).toBe('executed');
    expect(sb.inserts).toHaveLength(1);
  });
});

describe('delegation-run-store recordStart', () => {
  const job: PersistableJob = {
    job_id: '44444444-4444-4444-8444-444444444444', agent_id: 'support', user_id: '11111111-1111-4111-8111-111111111111',
    surface: 'vitanaland', session_id: 's1', status: 'running', request: 'help', result: null, error: null,
    created_at: new Date().toISOString(), completed_at: null,
  } as PersistableJob;
  const caller = { tenant_id: null, platform_role: 'community', channel: 'voice' } as any;

  it('writes no row for a disabled agent and does not throw (insert-failure handling)', async () => {
    const sb = fakeSb({ support: { enabled: false } });
    const store = createSupabaseDelegationRunStore(async () => sb);
    await expect(store.recordStart(job, caller, 'read')).resolves.toBeUndefined();
    expect(sb.inserts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('insert failed'), expect.stringMatching(/disabled/));
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  it('writes the row for an enabled or unknown agent', async () => {
    const sb = fakeSb({});
    const store = createSupabaseDelegationRunStore(async () => sb);
    await store.recordStart(job, caller, 'read');
    expect(sb.inserts).toHaveLength(1);
  });
});

describe('source guard: every native agent_runs writer checks the kill switch', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|js)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("each file with from('agent_runs').insert references assertAgentEnabled", () => {
    const src = path.resolve(__dirname, '../../../src');
    const insertRe = /from\(\s*['"]agent_runs['"]\s*\)\s*\.insert\b/;
    const writers = walk(src).filter((f) => insertRe.test(fs.readFileSync(f, 'utf8')));
    expect(writers.length).toBeGreaterThanOrEqual(2);
    const missing = writers.filter((f) => !fs.readFileSync(f, 'utf8').includes('assertAgentEnabled'));
    expect(missing.map((f) => path.relative(src, f))).toEqual([]);
  });
});

describe('VTID-05141 dispatcher: a disabled agent is refused before any work starts', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const d = require('../../../src/services/orchestrator/dispatcher');
  afterEach(() => { d.setAgentEnabledGate(null); d.clearDelegationTargets(); d.resetDelegationJobs(); });

  it('refuses with the gate error and never runs the target', async () => {
    let ran = 0;
    d.registerDelegationTarget({
      agent_id: 'x-agent', description: 'x', surfaces: ['community'], domain: 'community', tier: 'read',
      run: async () => { ran++; return 'ok'; },
    });
    d.setAgentEnabledGate(async () => ({ allowed: false, error: 'Run refused: agent x-agent is disabled in agents_registry' }));
    const res = await d.delegateToAgent('x-agent', 'do it', { user_id: 'u1', surface: 'community', platform_role: 'community', channel: 'voice' });
    expect(res).toEqual({ status: 'refused', agent_id: 'x-agent', error: 'Run refused: agent x-agent is disabled in agents_registry' });
    expect(ran).toBe(0);
  });
});
