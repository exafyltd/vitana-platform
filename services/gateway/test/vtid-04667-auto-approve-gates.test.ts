/**
 * VTID-04667 (P4): autoApproveTick and lazyPlanTick stop spending tokens on
 * work that does not land. Global fetch is mocked (the VTID-04280 /
 * VTID-04657 pattern); the marker that a finding got past every P4 gate is
 * the allocate_global_vtid RPC (ensureFindingVtid), which answers 500 here so
 * no approval is ever written.
 */
jest.mock('../src/services/dev-autopilot-planning', () => ({
  extractFilePaths: jest.fn((md: string) => (md.match(/`([^`]+\.ts)`/g) || []).map((x) => x.slice(1, -1))),
  generatePlanVersion: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
  cicdEvents: {},
}));
jest.mock('../src/services/codeintel-index', () => ({
  loadCodeIndex: jest.fn(async () => ({
    bundle: {
      sha: 'abcdef1234',
      risk: { files: { 'services/gateway/src/services/known.ts': {} } },
      byFile: new Map(),
    },
    fromCache: false,
    source: 'test',
    loadMs: 0,
  })),
}));

import { autoApproveTick, lazyPlanTick } from '../src/services/dev-autopilot-execute';
import { generatePlanVersion } from '../src/services/dev-autopilot-planning';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import { resetScannerBreakerCache } from '../src/services/dev-autopilot-scanner-breaker';

const OUTAGE = { error: 'LLM call failed ... both providers failed: primary=Bedrock invoke_failed / DeepSeek 402' };
const REAL = { error: 'tsc failed after 3 fix round(s)' };

type Finding = { id: string; risk_class: string; effort_score: number; impact_score: number; spec_snapshot: Record<string, unknown>; activated_vtid: null; source_type?: string };

interface World {
  config: Record<string, unknown>;
  baseline: Finding[];
  impact: Finding[];
  /** decided executions the breaker reads, keyed to findings */
  breakerExecs: Array<{ finding_id: string; status: string; metadata?: unknown }>;
  breakerRecs: Array<{ id: string; source_type: string; scanner: string | null; rule: string | null }>;
  latestExec: Record<string, { status: string; updated_at: string; metadata: unknown }>;
  outcomes: Record<string, Array<{ metadata: unknown }>>;
  planMarkdown: Record<string, string>;
}

const calls: Array<{ url: string; init?: RequestInit }> = [];
function res(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } } as unknown as Response;
}

function install(w: World) {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const u = decodeURIComponent(url);
    const method = (init?.method || 'GET').toUpperCase();
    if (u.includes('/rpc/allocate_global_vtid')) return res(500, { message: 'test stop' });
    if (method === 'PATCH') return res(204, '');
    if (u.includes('/dev_autopilot_config')) return res(200, [w.config]);
    if (u.includes('/autopilot_recommendations?source_type=in.(')) return res(200, w.baseline);
    if (u.includes('/autopilot_recommendations?source_type=eq.dev_autopilot_impact')) return res(200, w.impact);
    if (u.includes('/autopilot_recommendations?id=in.(')) return res(200, w.breakerRecs);
    if (u.includes('/dev_autopilot_plan_versions?finding_id=in.(')) {
      return res(200, [...w.baseline, ...w.impact].map((f) => ({ finding_id: f.id })));
    }
    const planOne = u.match(/dev_autopilot_plan_versions\?finding_id=eq\.([^&]+)/);
    if (planOne) {
      const md = w.planMarkdown[planOne[1]] ?? '- `services/gateway/src/services/known.ts`';
      return res(200, [{ version: 1, plan_markdown: md, files_referenced: [] }]);
    }
    if (u.includes('/dev_autopilot_executions?status=in.(completed,self_healed,failed,failed_escalated,reverted)')) {
      return res(200, w.breakerExecs.map((e, i) => ({ ...e, updated_at: new Date(Date.now() - i * 60_000).toISOString(), metadata: e.metadata ?? REAL })));
    }
    const latest = u.match(/dev_autopilot_executions\?finding_id=eq\.([^&]+)&order=updated_at\.desc&limit=1/);
    if (latest) return res(200, w.latestExec[latest[1]] ? [w.latestExec[latest[1]]] : []);
    const outc = u.match(/dev_autopilot_outcomes\?finding_id=eq\.([^&]+)/);
    if (outc) return res(200, w.outcomes[outc[1]] || []);
    return res(200, []);
  });
}

const cfg = {
  id: 1, kill_switch: false, auto_approve_enabled: true, auto_approve_risk_classes: ['low', 'medium'],
  auto_approve_scanners: ['todo-scanner-v1', 'dead-code-scanner-v1', 'large-file-scanner-v1'], auto_approve_max_effort: 5,
  daily_budget: 50, concurrency_cap: 10, auto_approve_impact_enabled: true,
  auto_approve_impact_rules: ['new-env-var-requires-workflow-binding'],
};
const finding = (id: string, scanner: string, extra: Record<string, unknown> = {}): Finding => ({
  id, risk_class: 'low', effort_score: 2, impact_score: 6, activated_vtid: null, spec_snapshot: { scanner, ...extra },
});
const world = (over: Partial<World> = {}): World => ({
  config: cfg, baseline: [], impact: [], breakerExecs: [], breakerRecs: [], latestExec: {}, outcomes: {}, planMarkdown: {}, ...over,
});
const allocatedFor = () => calls
  .filter((c) => c.url.includes('/rpc/allocate_global_vtid'))
  .map((c) => JSON.parse(String(c.init?.body || '{}')));
const reachedApproval = () => allocatedFor().length;
const snoozePatches = () => calls.filter((c) => (c.init?.method || '') === 'PATCH' && c.url.includes('/autopilot_recommendations?id=eq.'));

beforeEach(() => {
  calls.length = 0;
  resetScannerBreakerCache();
  (emitOasisEvent as jest.Mock).mockClear();
  (generatePlanVersion as jest.Mock).mockClear();
  process.env.SUPABASE_URL = 'https://supa.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc';
  delete process.env.DEV_AUTOPILOT_PLAN_FILE_CHECK;
  delete process.env.AGENT_CODE_INDEX_ENABLED;
});

const failingTodo = {
  breakerExecs: Array.from({ length: 6 }, (_, i) => ({ finding_id: `old${i}`, status: 'failed' })),
  breakerRecs: Array.from({ length: 6 }, (_, i) => ({ id: `old${i}`, source_type: 'dev_autopilot', scanner: 'todo-scanner-v1', rule: null })),
};

describe('P4.1 circuit breaker in autoApproveTick', () => {
  it('control: an eligible finding reaches the approval step', async () => {
    install(world({ baseline: [finding('ok-1', 'dead-code-scanner-v1')] }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(1);
  });

  it('skips a scanner whose breaker is open, emits breaker opened once, approves the others', async () => {
    install(world({ ...failingTodo, baseline: [finding('todo-1', 'todo-scanner-v1'), finding('dead-1', 'dead-code-scanner-v1')] }));
    await autoApproveTick();
    expect(allocatedFor().map((b) => b.p_module ?? b)).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('finding_id=eq.todo-1'))).toBe(false);
    expect(calls.some((c) => c.url.includes('finding_id=eq.dead-1'))).toBe(true);
    const opened = (emitOasisEvent as jest.Mock).mock.calls.filter((c) => c[0].type === 'dev_autopilot.scanner_breaker.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0][0].payload.key).toBe('todo-scanner-v1');
  });

  it('control: the impact pass reaches approval when its rule breaker is closed', async () => {
    install(world({
      baseline: [finding('large-0', 'large-file-scanner-v1', { signal_type: 'large_file' })],
      impact: [{ ...finding('imp-0', 'impact:new-env-var-requires-workflow-binding', { rule: 'new-env-var-requires-workflow-binding' }), source_type: 'dev_autopilot_impact' }],
    }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(1);
    expect(calls.some((c) => c.url.includes('/dev_autopilot_outcomes?finding_id=eq.imp-0'))).toBe(true);
  });

  it('the impact pass skips a rule whose breaker (impact:<rule>) is open', async () => {
    install(world({
      breakerExecs: Array.from({ length: 5 }, (_, i) => ({ finding_id: `r${i}`, status: 'reverted' })),
      breakerRecs: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, source_type: 'dev_autopilot_impact', scanner: 'impact:new-env-var-requires-workflow-binding', rule: 'new-env-var-requires-workflow-binding' })),
      baseline: [finding('large-1', 'large-file-scanner-v1', { signal_type: 'large_file' })],
      impact: [{ ...finding('imp-1', 'impact:new-env-var-requires-workflow-binding', { rule: 'new-env-var-requires-workflow-binding' }), source_type: 'dev_autopilot_impact' }],
    }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(0);
    expect(calls.some((c) => c.url.includes('finding_id=eq.imp-1'))).toBe(false);
  });
});

describe('P4.2 large_file is never auto-approved', () => {
  it('a large_file finding from an opted-in scanner is skipped before any per-finding read', async () => {
    install(world({ baseline: [finding('large-1', 'large-file-scanner-v1', { signal_type: 'large_file' })] }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(0);
    expect(calls.some((c) => c.url.includes('finding_id=eq.large-1'))).toBe(false);
  });
});

describe('P4.2 plan files must exist in the codebase index', () => {
  it('a plan naming a file the index does not know is skipped (not snoozed)', async () => {
    install(world({
      baseline: [finding('ghost-1', 'dead-code-scanner-v1')],
      planMarkdown: { 'ghost-1': '- `services/gateway/src/services/ghost.ts`\n- `services/gateway/test/ghost.test.ts`' },
    }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(0);
    expect(snoozePatches()).toHaveLength(0);
  });
  it('with the check switched off the same plan proceeds', async () => {
    process.env.DEV_AUTOPILOT_PLAN_FILE_CHECK = 'false';
    install(world({
      baseline: [finding('ghost-2', 'dead-code-scanner-v1')],
      planMarkdown: { 'ghost-2': '- `services/gateway/src/services/ghost.ts`' },
    }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(1);
  });
});

describe('P4.3 per-finding token budget', () => {
  it('over budget → snoozed 7 d with dev_autopilot.finding.snoozed reason token_budget, no approval', async () => {
    install(world({
      baseline: [finding('spend-1', 'dead-code-scanner-v1')],
      outcomes: { 'spend-1': [{ metadata: { agent_runs: [{ execution_id: 'e1', cost_usd: 1.2, input_tokens: 5_600_000 }] } }] },
    }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(0);
    const patch = snoozePatches().find((c) => c.url.includes('id=eq.spend-1'))!;
    const body = JSON.parse(String(patch.init!.body));
    expect(body.status).toBe('snoozed');
    expect(Date.parse(body.snoozed_until)).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
    const ev = (emitOasisEvent as jest.Mock).mock.calls.map((c) => c[0]).find((e) => e.type === 'dev_autopilot.finding.snoozed');
    expect(ev.payload).toEqual(expect.objectContaining({ finding_id: 'spend-1', reason: 'token_budget', pass: 'baseline' }));
  });
  it('under budget proceeds', async () => {
    install(world({
      baseline: [finding('spend-2', 'dead-code-scanner-v1')],
      outcomes: { 'spend-2': [{ metadata: { agent_runs: [{ execution_id: 'e1', cost_usd: 0.4, input_tokens: 900_000 }] } }] },
    }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(1);
  });
});

describe('P4.4 outage requeue cap (the 467-execution loop)', () => {
  it('a finding whose last execution died on an outage < 60 min ago is not re-approved', async () => {
    install(world({
      baseline: [finding('out-1', 'dead-code-scanner-v1')],
      latestExec: { 'out-1': { status: 'failed', updated_at: new Date(Date.now() - 5 * 60_000).toISOString(), metadata: OUTAGE } },
    }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(0);
    expect(snoozePatches()).toHaveLength(0); // skipped, not snoozed
  });
  it('the impact pass has the same cap', async () => {
    install(world({
      baseline: [finding('large-2', 'large-file-scanner-v1', { signal_type: 'large_file' })],
      impact: [{ ...finding('imp-2', 'impact:new-env-var-requires-workflow-binding', { rule: 'new-env-var-requires-workflow-binding' }), source_type: 'dev_autopilot_impact' }],
      latestExec: { 'imp-2': { status: 'failed', updated_at: new Date(Date.now() - 60_000).toISOString(), metadata: OUTAGE } },
    }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(0);
    expect(calls.some((c) => c.url.includes('/dev_autopilot_outcomes?finding_id=eq.imp-2'))).toBe(false);
  });
  it('after the cooldown the finding is approved again', async () => {
    install(world({
      baseline: [finding('out-2', 'dead-code-scanner-v1')],
      latestExec: { 'out-2': { status: 'failed', updated_at: new Date(Date.now() - 61 * 60_000).toISOString(), metadata: OUTAGE } },
    }));
    await autoApproveTick();
    expect(reachedApproval()).toBe(1);
  });
});

describe('P4.1 lazyPlanTick spends no planner tokens on an open breaker', () => {
  it('plans only the findings whose scanner breaker is closed', async () => {
    const w = world({ ...failingTodo });
    install(w);
    (global as unknown as { fetch: jest.Mock }).fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const u = decodeURIComponent(url);
      if (u.includes('/dev_autopilot_config')) return res(200, [cfg]);
      if (u.includes('/autopilot_recommendations?source_type=in.(')) {
        return res(200, [
          { id: 'todo-9', source_type: 'dev_autopilot', spec_snapshot: { scanner: 'todo-scanner-v1' } },
          { id: 'dead-9', source_type: 'dev_autopilot', spec_snapshot: { scanner: 'dead-code-scanner-v1' } },
        ]);
      }
      if (u.includes('/autopilot_recommendations?id=in.(')) return res(200, w.breakerRecs);
      if (u.includes('/dev_autopilot_executions?status=in.(completed,self_healed,failed,failed_escalated,reverted)')) {
        return res(200, w.breakerExecs.map((e) => ({ ...e, updated_at: new Date().toISOString(), metadata: REAL })));
      }
      return res(200, []);
    });
    await lazyPlanTick();
    expect((generatePlanVersion as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['dead-9']);
    const candidateQuery = calls.find((c) => c.url.includes('/autopilot_recommendations?source_type=in.('))!.url;
    expect(candidateQuery).toContain('select=id,source_type,spec_snapshot');
  });
});
