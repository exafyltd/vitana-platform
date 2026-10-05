/**
 * VTID-04885 — Command Hub Overview Phase 2: the six new /ops/attention
 * adapters (cost & budgets, tests & contracts, routines, support tickets, LLM
 * Google fallback, stuck session VTIDs), their rubric, and the domain tiles
 * summary. Pure functions over fake reads; no network, no database.
 */

import {
  ATTENTION_ADAPTERS,
  NOT_WIRED_SOURCES,
  TILE_DOMAINS,
  costBudgetsAdapter,
  cronIntervalMs,
  isGoogleLlmCall,
  llmGoogleFallbackAdapter,
  routinesAdapter,
  stuckVtidsAdapter,
  supportTicketsAdapter,
  testsContractsAdapter,
  type AttentionReads,
  type LedgerRow,
} from '../src/services/ops-attention-adapters';
import { buildDomainSummary, buildOpsAttention, type AttentionSource, type AttentionStateStore } from '../src/services/ops-attention';
import { fakeReads, phase2Everything } from './fixtures/ops-attention-fakes';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ctx = { now: NOW };
const boom = async (): Promise<never> => {
  throw new Error('db down');
};
const memStore = (): AttentionStateStore => ({ load: async () => [], save: async () => {} });

describe('cost_budgets adapter', () => {
  it('an LLM budget over its daily limit is P2; >= 80% is P3; runs are grouped', async () => {
    const out = await costBudgetsAdapter(fakeReads({ llmBudgetLines: phase2Everything(NOW).llmBudgetLines, jevBudgetAlerts: async () => [] }), ctx);
    expect(out.partial_error).toBeUndefined();
    const byKey = Object.fromEntries(out.candidates.map((c) => [c.key.replace(/:\d{4}-\d{2}-\d{2}$/, ''), c]));
    expect(byKey['llm_budget:platform:platform']).toMatchObject({ severity: 'P2', domain: 'cost', title: 'Platform LLM budget crossed today' });
    expect(byKey['llm_budget:agent:autopilot-agent']).toMatchObject({ severity: 'P3', title: 'LLM budget for autopilot-agent at 83% today' });
    expect(byKey['llm_budget:runs:over']).toMatchObject({ severity: 'P2', count: 1 });
    // The fingerprint is per UTC day: a budget resets daily.
    expect(out.candidates[0].key).toMatch(/:\d{4}-\d{2}-\d{2}$/);
    expect(out.candidates.every((c) => c.deeplink.section === 'autopilot' && c.deeplink.tab === 'orchestrator')).toBe(true);
  });

  it('lines under 80% are not reported', async () => {
    const out = await costBudgetsAdapter(fakeReads(), ctx);
    expect(out.candidates).toEqual([]);
  });

  it('Jev: one item per tenant, the highest level wins — 100% is P2 (exhausted), 80% is P3', async () => {
    const out = await costBudgetsAdapter(fakeReads({ jevBudgetAlerts: phase2Everything(NOW).jevBudgetAlerts }), ctx);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({ key: 'jev_budget:t1:2026-10-01', severity: 'P2', since: ago(2 * H) });
    const only80 = await costBudgetsAdapter(fakeReads({
      jevBudgetAlerts: async () => [{ topic: 'jev.budget.threshold_crossed', created_at: ago(H), metadata: { tenant_id: 't2', level_pct: 80 } }],
    }), ctx);
    expect(only80.candidates[0]).toMatchObject({ severity: 'P3', title: 'Jev community budget past 80% for tenant t2' });
  });

  it('reads the Jev events from the start of the UTC month', async () => {
    const since: string[] = [];
    await costBudgetsAdapter(fakeReads({ jevBudgetAlerts: async (s) => { since.push(s); return []; } }), ctx);
    expect(since).toEqual(['2026-10-01T00:00:00.000Z']);
  });

  it('a truncated spend read or one failed half is partial (UNKNOWN); both failing throws', async () => {
    const trunc = await costBudgetsAdapter(fakeReads({ llmBudgetLines: async () => ({ since: ago(H), truncated: true, lines: [] }) }), ctx);
    expect(trunc.partial_error).toMatch(/truncated/);
    const half = await costBudgetsAdapter(fakeReads({ jevBudgetAlerts: boom }), ctx);
    expect(half.partial_error).toMatch(/jev_budget: db down/);
    await expect(costBudgetsAdapter(fakeReads({ jevBudgetAlerts: boom, llmBudgetLines: boom }), ctx)).rejects.toThrow(/llm_budgets/);
  });
});

describe('tests_contracts adapter', () => {
  it('a workflow failing on main >= 2 runs in a row is P2, since the first failure of the streak', async () => {
    const out = await testsContractsAdapter(fakeReads({ ciTestRuns: phase2Everything(NOW).ciTestRuns }), ctx);
    const wf = out.candidates.find((c) => c.key.startsWith('workflow:'))!;
    expect(wf).toMatchObject({ severity: 'P2', domain: 'quality', count: 2, since: ago(3 * H), deeplink: { section: 'testing-qa', tab: 'runs' } });
  });

  it('a single latest failure is P3; a green latest run or a non-main branch is not reported', async () => {
    const run = (conclusion: string, h: number, branch = 'main') => ({
      repo: 'r', workflow_file: 'W.yml', workflow_name: 'W', branch, conclusion, html_url: null, run_created_at: ago(h * H),
    });
    const one = await testsContractsAdapter(fakeReads({ ciTestRuns: async () => ({ last_synced_at: ago(H), rows: [run('failure', 1), run('success', 2)] }) }), ctx);
    expect(one.candidates[0]).toMatchObject({ severity: 'P3', count: 1 });
    const green = await testsContractsAdapter(fakeReads({ ciTestRuns: async () => ({ last_synced_at: ago(H), rows: [run('success', 1), run('failure', 2)] }) }), ctx);
    expect(green.candidates).toEqual([]);
    const branch = await testsContractsAdapter(fakeReads({ ciTestRuns: async () => ({ last_synced_at: ago(H), rows: [run('failure', 1, 'feature/x')] }) }), ctx);
    expect(branch.candidates).toEqual([]);
    // A cancelled run is not a verdict.
    const cancelled = await testsContractsAdapter(fakeReads({ ciTestRuns: async () => ({ last_synced_at: ago(H), rows: [run('cancelled', 1), run('success', 2)] }) }), ctx);
    expect(cancelled.candidates).toEqual([]);
  });

  it('failing capability contracts are one P3 item', async () => {
    const out = await testsContractsAdapter(fakeReads({ failingTestContracts: phase2Everything(NOW).failingTestContracts }), ctx);
    expect(out.candidates).toEqual([expect.objectContaining({ key: 'contracts:fail', severity: 'P3', count: 1, deeplink: { section: 'testing-qa', tab: 'test-contracts', query: {} } })]);
  });

  it('a stale or never-run results sync is UNKNOWN (never a clean OK)', async () => {
    const stale = await testsContractsAdapter(fakeReads({ ciTestRuns: async () => ({ last_synced_at: ago(30 * H), rows: [] }) }), ctx);
    expect(stale.partial_error).toMatch(/not synced for 30 h/);
    const never = await testsContractsAdapter(fakeReads({ ciTestRuns: async () => ({ last_synced_at: null, rows: [] }) }), ctx);
    expect(never.partial_error).toMatch(/not synced for ever/);
    await expect(testsContractsAdapter(fakeReads({ ciTestRuns: boom, failingTestContracts: boom }), ctx)).rejects.toThrow();
  });
});

describe('routines adapter', () => {
  const routine = (o: Record<string, unknown>) => ({
    name: 'r', display_name: 'R', cron_schedule: '0 4 * * *', last_run_at: ago(2 * H), last_run_status: 'success', consecutive_failures: 0, created_at: ago(1000 * H), ...o,
  });

  it('cronIntervalMs understands the simple shapes and refuses the rest', () => {
    expect(cronIntervalMs('0 4 * * *')).toBe(24 * H);
    expect(cronIntervalMs('15 * * * *')).toBe(H);
    expect(cronIntervalMs('0 */6 * * *')).toBe(6 * H);
    expect(cronIntervalMs('0 4 * * 1')).toBe(7 * 24 * H);
    expect(cronIntervalMs('0 4 1 * *')).toBe(31 * 24 * H);
    expect(cronIntervalMs('0 4,16 * * *')).toBeNull();
    expect(cronIntervalMs('nonsense')).toBeNull();
  });

  it('a failed last run is P3; three in a row is P2', async () => {
    const out = await routinesAdapter(fakeReads({ routines: async () => [routine({ last_run_status: 'failure', consecutive_failures: 1 }), routine({ name: 'x', last_run_status: 'failure', consecutive_failures: 3 })] as any }), ctx);
    expect(out.candidates.map((c) => [c.key, c.severity])).toEqual([['failed:r', 'P3'], ['failed:x', 'P2']]);
    expect(out.candidates[0].deeplink).toEqual({ section: 'routines', tab: 'history', query: {} });
  });

  it('overdue after 1.5 intervals without a run (P3, since = when it became overdue); never-run uses created_at', async () => {
    const out = await routinesAdapter(fakeReads({ routines: async () => [routine({ last_run_at: ago(40 * H) }), routine({ name: 'n', last_run_at: null, last_run_status: null, created_at: ago(48 * H) })] as any }), ctx);
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates[0]).toMatchObject({ key: 'overdue:r', severity: 'P3', since: ago(4 * H), deeplink: { section: 'routines', tab: 'catalog' } });
    expect(out.candidates[1].detail).toMatch(/never ran/);
    const onTime = await routinesAdapter(fakeReads({ routines: async () => [routine({ last_run_at: ago(30 * H) })] as any }), ctx);
    expect(onTime.candidates).toEqual([]);
  });

  it('a run still "running" after 6 h is P3', async () => {
    const out = await routinesAdapter(fakeReads({ routines: async () => [routine({ last_run_status: 'running', last_run_at: ago(7 * H) })] as any }), ctx);
    expect(out.candidates[0]).toMatchObject({ key: 'running:r', severity: 'P3' });
  });

  it('a schedule it cannot judge makes the source UNKNOWN; an unreadable table throws', async () => {
    const out = await routinesAdapter(fakeReads({ routines: async () => [routine({ cron_schedule: '0 4,16 * * *' })] as any }), ctx);
    expect(out.partial_error).toMatch(/schedule not understood for r/);
    await expect(routinesAdapter(fakeReads({ routines: boom }), ctx)).rejects.toThrow('db down');
  });
});

describe('support_tickets adapter', () => {
  const t = (o: Record<string, unknown>) => ({ id: 'tk', ticket_number: 'FB-9', kind: 'bug', status: 'new', priority: 'p2', created_at: ago(H), ...o });

  it('an open p0 is P2 and deep-links to that ticket (?ticket=)', async () => {
    const out = await supportTicketsAdapter(fakeReads({ openSupportTickets: phase2Everything(NOW).openSupportTickets }), ctx);
    const p0 = out.candidates.find((c) => c.key === 'tickets:p0')!;
    expect(p0).toMatchObject({ severity: 'P2', domain: 'support', deeplink: { section: 'feedback', tab: 'inbox', query: { ticket: 'tk-1' } } });
    const aged = out.candidates.find((c) => c.key === 'tickets:aged')!;
    expect(aged).toMatchObject({ severity: 'P3', count: 1, since: ago(28 * H) });
  });

  it('p1 waiting > 1 h is P3, > 4 h is P2; under 1 h is not reported', async () => {
    const p3 = await supportTicketsAdapter(fakeReads({ openSupportTickets: async () => [t({ priority: 'p1', created_at: ago(2 * H) })] }), ctx);
    expect(p3.candidates[0]).toMatchObject({ key: 'tickets:p1', severity: 'P3' });
    const p2 = await supportTicketsAdapter(fakeReads({ openSupportTickets: async () => [t({ priority: 'p1', created_at: ago(5 * H) })] }), ctx);
    expect(p2.candidates[0]).toMatchObject({ severity: 'P2' });
    const fresh = await supportTicketsAdapter(fakeReads({ openSupportTickets: async () => [t({ priority: 'p1', created_at: ago(H / 2) })] }), ctx);
    expect(fresh.candidates).toEqual([]);
  });

  it('several tickets link to the inbox list; closed statuses never count', async () => {
    const out = await supportTicketsAdapter(fakeReads({
      openSupportTickets: async () => [t({ id: 'a', priority: 'p0' }), t({ id: 'b', priority: 'p0' }), t({ id: 'c', priority: 'p0', status: 'resolved' })],
    }), ctx);
    expect(out.candidates).toEqual([expect.objectContaining({ count: 2, deeplink: { section: 'feedback', tab: 'inbox', query: {} } })]);
  });

  it('reads tickets older than 72 h as "aged"; an unreadable table throws', async () => {
    const since: string[] = [];
    await supportTicketsAdapter(fakeReads({ openSupportTickets: async (s) => { since.push(s); return []; } }), ctx);
    expect(since).toEqual([ago(72 * H)]);
    await expect(supportTicketsAdapter(fakeReads({ openSupportTickets: boom }), ctx)).rejects.toThrow('db down');
  });
});

describe('llm_google_fallback adapter', () => {
  it('any fallback that landed on Google in 24 h is P2 (an incident)', async () => {
    const out = await llmGoogleFallbackAdapter(fakeReads({ llmGoogleCalls: phase2Everything(NOW).llmGoogleCalls }), ctx);
    expect(out.candidates).toEqual([expect.objectContaining({
      key: 'google_fallback', severity: 'P2', domain: 'llm', count: 1, since: ago(3 * H),
      deeplink: { section: 'models-evaluations', tab: 'routing', query: {} },
    })]);
  });

  it('a stage routed at Google without a fallback is its own P2; other providers are ignored', async () => {
    const out = await llmGoogleFallbackAdapter(fakeReads({
      llmGoogleCalls: async () => [
        { created_at: ago(H), provider: 'vertex', model: 'gemini-y', stage: 'planner', service: 's', fallback_used: false },
        { created_at: ago(H), provider: 'bedrock', model: 'eu.x', stage: 'worker', service: 's', fallback_used: true },
      ],
    }), ctx);
    expect(out.candidates.map((c) => [c.key, c.severity])).toEqual([['google_routed', 'P2']]);
    expect(isGoogleLlmCall({ provider: 'deepseek', model: 'gemini-pro' })).toBe(true);
    expect(isGoogleLlmCall({ provider: 'bedrock', model: 'eu.anthropic.x' })).toBe(false);
  });

  it('reads a 24 h window; an unreadable read throws (UNKNOWN, never "no fallbacks")', async () => {
    const since: string[] = [];
    await llmGoogleFallbackAdapter(fakeReads({ llmGoogleCalls: async (s) => { since.push(s); return []; } }), ctx);
    expect(since).toEqual([ago(24 * H)]);
    await expect(llmGoogleFallbackAdapter(fakeReads({ llmGoogleCalls: boom }), ctx)).rejects.toThrow('db down');
  });
});

describe('stuck_vtids adapter', () => {
  const row = (o: Partial<LedgerRow>): LedgerRow => ({
    vtid: 'VTID-1', title: 't', metadata: { source: 'claude-code' }, claimed_by: null, claim_started_at: null, claim_expires_at: null, updated_at: ago(100 * H), ...o,
  });

  it('session-plane VTIDs without an update for > 72 h are one P3 item; autonomous tasks are excluded', async () => {
    const out = await stuckVtidsAdapter(fakeReads({
      inProgressLedger: async () => [
        row({ vtid: 'VTID-1' }),
        row({ vtid: 'VTID-2', updated_at: ago(80 * H) }),
        row({ vtid: 'VTID-3', updated_at: ago(10 * H) }),
        row({ vtid: 'VTID-4', metadata: { autonomous_execution: true } }),
        row({ vtid: 'VTID-5', metadata: { source: 'self-healing' } }),
      ],
    }), ctx);
    expect(out.candidates).toEqual([expect.objectContaining({
      key: 'session_vtids_stale', severity: 'P3', domain: 'operator', count: 2, since: ago(28 * H),
      deeplink: { section: 'oasis', tab: 'vtid-ledger', query: {} },
    })]);
    expect(out.candidates[0].evidence.vtids).toEqual(['VTID-1', 'VTID-2']);
  });

  it('one stale VTID deep-links to its task drawer (?vtid=)', async () => {
    const out = await stuckVtidsAdapter(fakeReads({ inProgressLedger: async () => [row({ vtid: 'VTID-7' })] }), ctx);
    expect(out.candidates[0].deeplink).toEqual({ section: 'command-hub', tab: 'tasks', query: { vtid: 'VTID-7' } });
  });

  it('a full 500-row page is truncated (UNKNOWN)', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => row({ vtid: `VTID-${i}`, updated_at: ago(H) }));
    const out = await stuckVtidsAdapter(fakeReads({ inProgressLedger: async () => rows }), ctx);
    expect(out.partial_error).toMatch(/500-row cap/);
  });
});

describe('registry, not-wired sources and domain tiles', () => {
  it('the CloudWatch adapter is not wired (no @aws-sdk/client-cloudwatch dependency) and is listed as such', () => {
    const pkg = require('../package.json');
    expect(pkg.dependencies['@aws-sdk/client-cloudwatch']).toBeUndefined();
    expect(ATTENTION_ADAPTERS.map((a) => a.id)).not.toContain('cloudwatch_alarms');
    expect(NOT_WIRED_SOURCES).toEqual([expect.objectContaining({ id: 'cloudwatch_alarms', domain: 'platform' })]);
  });

  it('the plan\'s 13 domains, every adapter in exactly one tile', () => {
    expect(TILE_DOMAINS.map((d) => d.label)).toEqual([
      'Platform & Services', 'Release Pipeline', 'Voice / ORB', 'AI & LLM Routing', 'Autonomy', 'Operator & VTIDs',
      'Governance', 'Quality', 'Cost & Budgets', 'Community & Support', 'Moderation & Commerce', 'Data & Memory', 'Scheduled Jobs',
    ]);
    const owned = TILE_DOMAINS.flatMap((d) => d.sources);
    expect([...owned].sort()).toEqual(ATTENTION_ADAPTERS.map((a) => a.id).sort());
    expect(TILE_DOMAINS.filter((d) => !d.sources.length).map((d) => d.key)).toEqual(['commerce', 'data']);
  });

  it('buildDomainSummary: worst severity, open count, freshness; unmonitored is never OK', () => {
    const src = (id: string, status: 'ok' | 'unknown' = 'ok', fetched = ago(0)): AttentionSource => ({ id: id as any, status, fetched_at: fetched, ...(status === 'unknown' ? { error: 'x' } : {}) });
    const sources = ATTENTION_ADAPTERS.map((a) => src(a.id, a.id === 'routines' ? 'unknown' : 'ok', a.id === 'stuck_vtids' ? ago(5000) : ago(0)));
    const item = (source: string, severity: 'P1' | 'P2' | 'P3') => ({ source, severity } as any);
    const domains = buildDomainSummary(sources, [item('operator_pipeline', 'P3'), item('decisions_waiting', 'P2'), item('service_health', 'P1')]);
    const by = Object.fromEntries(domains.map((d) => [d.key, d]));
    expect(by.operator).toMatchObject({ status: 'ok', worst_severity: 'P2', open: 2, sources_fresh: 3, sources_total: 3, fetched_at: ago(5000) });
    expect(by.platform).toMatchObject({ worst_severity: 'P1', open: 1, not_wired: [expect.objectContaining({ id: 'cloudwatch_alarms' })] });
    expect(by.jobs).toMatchObject({ status: 'unknown', worst_severity: null, errors: ['routines: x'] });
    expect(by.commerce).toMatchObject({ monitored: false, status: 'not_monitored', open: 0, fetched_at: null });
    expect(by.quality).toMatchObject({ status: 'ok', worst_severity: null, open: 0 });
    // A monitored domain whose adapter did not run is unknown, not OK.
    expect(buildDomainSummary([], []).find((d) => d.key === 'cost')!.status).toBe('unknown');
  });

  it('the full registry over the Phase 2 fakes: every new source reports, the response carries 13 domains', async () => {
    const reads: AttentionReads = fakeReads(phase2Everything(NOW));
    const data = await buildOpsAttention({ env: 'production', now: NOW, reads, state: memStore() });
    for (const id of ['cost_budgets', 'tests_contracts', 'routines', 'support_tickets', 'llm_google_fallback']) {
      expect(data.items.some((i) => i.source === id)).toBe(true);
      expect(data.sources.find((s) => s.id === id)!.status).toBe('ok');
    }
    expect(data.domains).toHaveLength(13);
    expect(data.domains.find((d) => d.key === 'llm')).toMatchObject({ worst_severity: 'P2', open: 1 });
    expect(data.domains.find((d) => d.key === 'data')).toMatchObject({ status: 'not_monitored' });
  });

  it('a throwing Phase 2 read makes only its source and its tile UNKNOWN', async () => {
    const data = await buildOpsAttention({
      env: 'production', now: NOW, reads: fakeReads({ openSupportTickets: boom }), state: memStore(),
      adapters: ATTENTION_ADAPTERS.filter((a) => a.id === 'support_tickets' || a.id === 'routines'),
    });
    expect(data.sources.find((s) => s.id === 'support_tickets')).toMatchObject({ status: 'unknown', error: 'db down' });
    expect(data.domains.find((d) => d.key === 'support')!.status).toBe('unknown');
    expect(data.domains.find((d) => d.key === 'jobs')!.status).toBe('ok');
    expect(data.verdict).toBe('UNKNOWN');
  });
});
