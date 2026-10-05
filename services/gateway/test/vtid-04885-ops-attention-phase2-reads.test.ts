/**
 * VTID-04885 — the Phase 2 production reads: in-process (the orchestrator
 * budget arithmetic, never an HTTP call to /orchestrator/budgets), bounded
 * (LIMIT + an indexed filter), and they THROW on a failed read — never
 * "nothing found". Every dependency is mocked; no network, no database.
 */

const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
let tableResult: Record<string, { data: unknown; error: unknown }> = {};

function chain(table: string) {
  const rec = { table, ops: [] as Array<[string, unknown[]]> };
  calls.push(rec);
  const c: any = {};
  for (const m of ['select', 'in', 'gte', 'lt', 'eq', 'neq', 'not', 'like', 'or', 'order', 'limit', 'upsert']) {
    c[m] = (...args: unknown[]) => { rec.ops.push([m, args]); return c; };
  }
  c.then = (res: any, rej: any) => Promise.resolve(tableResult[table] ?? { data: [], error: null }).then(res, rej);
  return c;
}

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({ from: (t: string) => chain(t) }) }));
jest.mock('../src/services/health-summary-builder', () => ({ buildHealthSummary: jest.fn() }));
jest.mock('../src/services/voice-supervisor-overview', () => ({ buildVoiceOverview: jest.fn() }));
jest.mock('../src/services/dev-autopilot-supervisor', () => ({ buildSupervisorSnapshot: jest.fn() }));
jest.mock('../src/services/system-controls-service', () => ({ getAllSystemControls: jest.fn(async () => []) }));
jest.mock('../src/routes/worker-orchestrator', () => ({ isAutonomousExecutionTask: jest.fn(() => false) }));
jest.mock('../src/routes/approvals', () => ({ fetchApprovalEligibleVtids: jest.fn(), fetchPrInfoForVtids: jest.fn() }));
jest.mock('../src/routes/ops-runtime-health', () => ({ runRuntimeCheckCached: jest.fn() }));
let spend: { rows: any[]; since: string; truncated: boolean; error: string | null } = { rows: [], since: 'S', truncated: false, error: null };
jest.mock('../src/services/orchestrator/budgets', () => {
  const real = jest.requireActual('../src/services/orchestrator/budgets');
  return { ...real, loadSpendToday: jest.fn(async () => spend) };
});

import { createAttentionReads } from '../src/services/ops-attention-reads';
import { loadSpendToday } from '../src/services/orchestrator/budgets';

const fetchSpy = jest.fn();
beforeAll(() => { (global as any).fetch = fetchSpy; });
beforeEach(() => {
  calls.length = 0;
  tableResult = {};
  spend = { rows: [], since: 'S', truncated: false, error: null };
});

describe('cost & budgets', () => {
  it('LLM budget lines come from loadSpendToday + the budgets arithmetic (same as GET /orchestrator/budgets)', async () => {
    spend = {
      since: '2026-10-04T00:00:00.000Z', truncated: false, error: null,
      rows: [{ service: 'autopilot-agent', vtid: 'VTID-1', model: 'm', input_tokens: 0, output_tokens: 0, cost_estimate_usd: 70 }],
    };
    const out = await createAttentionReads().llmBudgetLines();
    expect(loadSpendToday).toHaveBeenCalled();
    expect(out.since).toBe('2026-10-04T00:00:00.000Z');
    expect(out.lines.find((l) => l.scope === 'agent' && l.key === 'autopilot-agent')).toMatchObject({ spent_usd: 70, limit_usd: 60, over: true });
    expect(out.lines.find((l) => l.scope === 'run' && l.key === 'VTID-1')).toMatchObject({ over: true });
  });

  it('a failed spend read throws (never "no spend")', async () => {
    spend = { rows: [], since: 'S', truncated: false, error: 'boom' };
    await expect(createAttentionReads().llmBudgetLines()).rejects.toThrow(/llm.call.completed.*boom/);
  });

  it('Jev budget alerts: oasis_events topic = jev.budget.threshold_crossed, since, LIMIT 200', async () => {
    await createAttentionReads().jevBudgetAlerts('M');
    expect(calls[0]).toEqual({
      table: 'oasis_events',
      ops: [
        ['select', ['topic,created_at,metadata']],
        ['eq', ['topic', 'jev.budget.threshold_crossed']],
        ['gte', ['created_at', 'M']],
        ['order', ['created_at', { ascending: false }]],
        ['limit', [200]],
      ],
    });
    tableResult.oasis_events = { data: null, error: { message: 'denied' } };
    await expect(createAttentionReads().jevBudgetAlerts('M')).rejects.toThrow('oasis_events: denied');
  });
});

describe('tests & contracts', () => {
  it('ci_test_runs on main since the window (LIMIT 1000) + the oldest repository sync time', async () => {
    tableResult.ci_test_sync_state = { data: [{ last_synced_at: '2026-10-04T10:00:00Z' }, { last_synced_at: '2026-10-04T08:00:00Z' }], error: null };
    const out = await createAttentionReads().ciTestRuns('W');
    expect(out.last_synced_at).toBe('2026-10-04T08:00:00Z');
    const runs = calls.find((c) => c.table === 'ci_test_runs')!.ops;
    expect(runs).toContainEqual(['eq', ['branch', 'main']]);
    expect(runs).toContainEqual(['gte', ['run_created_at', 'W']]);
    expect(runs).toContainEqual(['limit', [1000]]);
  });

  it('a repository that never synced makes last_synced_at null; a failed read throws', async () => {
    tableResult.ci_test_sync_state = { data: [{ last_synced_at: '2026-10-04T10:00:00Z' }, { last_synced_at: null }], error: null };
    expect((await createAttentionReads().ciTestRuns('W')).last_synced_at).toBeNull();
    tableResult.ci_test_runs = { data: null, error: { message: 'boom' } };
    await expect(createAttentionReads().ciTestRuns('W')).rejects.toThrow('ci_test_runs: boom');
  });

  it('failing contracts: test_contracts status = fail, LIMIT 100', async () => {
    await createAttentionReads().failingTestContracts();
    expect(calls[0].table).toBe('test_contracts');
    expect(calls[0].ops).toContainEqual(['eq', ['status', 'fail']]);
    expect(calls[0].ops).toContainEqual(['limit', [100]]);
  });
});

describe('routines, support tickets, Google fallback', () => {
  it('routines: enabled only, LIMIT 200; an error throws', async () => {
    await createAttentionReads().routines();
    expect(calls[0].table).toBe('routines');
    expect(calls[0].ops).toContainEqual(['eq', ['enabled', true]]);
    tableResult.routines = { data: null, error: { message: 'gone' } };
    await expect(createAttentionReads().routines()).rejects.toThrow('routines: gone');
  });

  it('support tickets: open statuses only (the partial index), p0/p1 or aged, oldest first, LIMIT 300', async () => {
    await createAttentionReads().openSupportTickets('A');
    expect(calls[0].table).toBe('feedback_tickets');
    expect(calls[0].ops).toEqual([
      ['select', ['id,ticket_number,kind,status,priority,created_at']],
      ['not', ['status', 'in', '(resolved,user_confirmed,rejected,wont_fix,duplicate)']],
      ['or', ['priority.in.(p0,p1),created_at.lt.A']],
      ['order', ['created_at', { ascending: true }]],
      ['limit', [300]],
    ]);
  });

  it('Google calls: llm.call.completed in the window with a Google provider; fallback_used parsed', async () => {
    tableResult.oasis_events = {
      data: [{ created_at: 'C', metadata: { provider: 'vertex', model: 'gemini-x', stage: 'worker', service: 's', fallback_used: true } }],
      error: null,
    };
    const rows = await createAttentionReads().llmGoogleCalls('W');
    expect(rows).toEqual([{ created_at: 'C', provider: 'vertex', model: 'gemini-x', stage: 'worker', service: 's', fallback_used: true }]);
    expect(calls[0].ops).toContainEqual(['eq', ['topic', 'llm.call.completed']]);
    expect(calls[0].ops).toContainEqual(['in', ['metadata->>provider', ['vertex', 'google', 'gemini']]]);
    expect(calls[0].ops).toContainEqual(['limit', [500]]);
  });
});

describe('the in-progress ledger is read once per computation (operator_pipeline + stuck_vtids)', () => {
  it('two callers share one read; a failed read is retried by the next caller', async () => {
    const r = createAttentionReads();
    await Promise.all([r.inProgressLedger(), r.inProgressLedger()]);
    expect(calls.filter((c) => c.table === 'vtid_ledger')).toHaveLength(1);
    tableResult.vtid_ledger = { data: null, error: { message: 'x' } };
    const r2 = createAttentionReads();
    await expect(r2.inProgressLedger()).rejects.toThrow('vtid_ledger: x');
    tableResult.vtid_ledger = { data: [], error: null };
    await expect(r2.inProgressLedger()).resolves.toEqual([]);
  });

  it('nothing above used fetch', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
