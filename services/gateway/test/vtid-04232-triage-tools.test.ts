/**
 * VTID-04232: the self-healing triage agent gets a tool set scoped to a
 * root-cause investigator — query_oasis_events, dev_cloudwatch_logs,
 * dev_ecs_tasks, dev_run_sql_readonly, get_architecture_reports — through
 * the bounded stage loop on the `triage` stage.
 */
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

jest.mock('../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));
jest.mock('../src/services/aws-cloudwatch-logs-readonly', () => ({ filterVitanaLogs: jest.fn() }));
jest.mock('../src/services/aws-ecs-readonly', () => ({ listEcsTasks: jest.fn(), ALLOWED_ECS_TASK_FAMILIES: ['vitana-autopilot-executor'] }));
jest.mock('../src/services/operator-sql-readonly', () => {
  const actual = jest.requireActual('../src/services/operator-sql-readonly');
  return { ...actual, runReadonlySql: jest.fn() };
});

import { callViaRouter } from '../src/services/llm-router';
import { filterVitanaLogs } from '../src/services/aws-cloudwatch-logs-readonly';
import { listEcsTasks } from '../src/services/aws-ecs-readonly';
import { runReadonlySql } from '../src/services/operator-sql-readonly';
import { createTriageToolExecutor, triageRouterTools, fetchArchitectureReports, TRIAGE_TOOL_NAMES } from '../src/services/self-healing-triage-tools';
import { spawnTriageAgent, queryOasisEvents, isTriageToolsEnabled, TRIAGE_MAX_TOOL_CALLS, TRIAGE_MAX_TURNS, TRIAGE_SYSTEM_PROMPT } from '../src/services/self-healing-triage-service';

const mockRouter = callViaRouter as jest.Mock;
const mockLogs = filterVitanaLogs as jest.Mock;
const mockTasks = listEcsTasks as jest.Mock;
const mockSql = runReadonlySql as jest.Mock;

const REPORT = ['## Severity', 'warning', '', '- **Severity**: warning', '- **Root Cause Hypothesis**: the watcher ran twice', '- **Affected Component**: services/gateway/src/services/dev-autopilot-watcher.ts ciWatcherTick', '- **Evidence**:', '  - two claims 3 s apart', '- **Recommended Fix**: single-flight the tick', '- **Confidence**: high'].join('\n');

function supabaseFetch(rows: unknown[] = []): jest.Mock {
  return jest.fn(async (url: string) => ({ ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows), url }));
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SELF_HEALING_TRIAGE_TOOLS_ENABLED;
  delete process.env.OPERATOR_AWS_READONLY_ENABLED;
  delete process.env.OPERATOR_SQL_READONLY_ENABLED;
});

describe('triageRouterTools', () => {
  it('declares exactly the five read-only investigator tools', () => {
    expect(triageRouterTools().map((t) => t.name)).toEqual([...TRIAGE_TOOL_NAMES]);
    expect(TRIAGE_TOOL_NAMES).toEqual(['query_oasis_events', 'dev_cloudwatch_logs', 'dev_ecs_tasks', 'dev_run_sql_readonly', 'get_architecture_reports']);
  });
  it('the flag is on by default and off only for the exact string false', () => {
    expect(isTriageToolsEnabled({})).toBe(true);
    expect(isTriageToolsEnabled({ SELF_HEALING_TRIAGE_TOOLS_ENABLED: 'false' })).toBe(false);
    expect(isTriageToolsEnabled({ SELF_HEALING_TRIAGE_TOOLS_ENABLED: '0' })).toBe(true);
  });
});

describe('queryOasisEvents', () => {
  it('reads by session id (both metadata spellings) or by vtid, and refuses neither', async () => {
    const f = supabaseFetch([{ topic: 'x' }]);
    global.fetch = f as any;
    await queryOasisEvents('live-abc', 10);
    expect(f.mock.calls[0][0]).toContain('metadata->>session_id.eq.live-abc');
    expect(f.mock.calls[0][0]).toContain('limit=10');
    await queryOasisEvents({ vtid: 'VTID-04232' }, 5);
    expect(f.mock.calls[1][0]).toContain('vtid=eq.VTID-04232');
    expect(await queryOasisEvents({}, 5)).toMatch(/^Error: session_id or vtid is required/);
  });
});

describe('createTriageToolExecutor', () => {
  const ctx = () => ({ vtid: 'VTID-1', queryOasisEvents: jest.fn(async (f: any, limit: number) => `events ${JSON.stringify(f)} limit=${limit}`) });

  it('query_oasis_events forwards session_id / vtid with a clamped limit and refuses neither', async () => {
    const c = ctx();
    const e = createTriageToolExecutor(c);
    expect((await e('query_oasis_events', { session_id: 'live-1', limit: 999 })).result).toBe('events {"sessionId":"live-1"} limit=100');
    expect((await e('query_oasis_events', { vtid: 'VTID-9' })).result).toBe('events {"vtid":"VTID-9"} limit=50');
    expect((await e('query_oasis_events', {})).isError).toBe(true);
    c.queryOasisEvents.mockResolvedValueOnce('Error: Supabase 500');
    expect((await e('query_oasis_events', { vtid: 'VTID-9' })).isError).toBe(true);
  });

  it('the AWS reads are refused honestly when OPERATOR_AWS_READONLY_ENABLED is not true, and forwarded when it is', async () => {
    const e = createTriageToolExecutor(ctx());
    expect((await e('dev_cloudwatch_logs', { log_group: '/ecs/vitana-gateway' })).result).toMatch(/disabled on this stack/);
    expect((await e('dev_ecs_tasks', { target: 'vitana-gateway' })).result).toMatch(/disabled on this stack/);
    expect(mockLogs).not.toHaveBeenCalled();
    process.env.OPERATOR_AWS_READONLY_ENABLED = 'true';
    mockLogs.mockResolvedValue({ log_group: '/ecs/vitana-gateway', events: [{ message: 'boom' }], truncated: false });
    mockTasks.mockResolvedValue({ target: 'vitana-gateway', tasks: [{ status: 'RUNNING' }] });
    const logs = await e('dev_cloudwatch_logs', { log_group: '/ecs/vitana-gateway', filter_pattern: 'ERROR', minutes: 15 });
    expect(mockLogs).toHaveBeenCalledWith({ logGroup: '/ecs/vitana-gateway', filterPattern: 'ERROR', minutes: 15, limit: undefined });
    expect(logs.result).toContain('boom');
    const tasks = await e('dev_ecs_tasks', { target: 'vitana-gateway', desired_status: 'STOPPED' });
    expect(mockTasks).toHaveBeenCalledWith({ target: 'vitana-gateway', desiredStatus: 'STOPPED', limit: undefined });
    expect(tasks.result).toContain('RUNNING');
    mockLogs.mockRejectedValueOnce(new Error('AccessDenied: logs:FilterLogEvents'));
    const denied = await e('dev_cloudwatch_logs', { log_group: '/ecs/vitana-gateway' });
    expect(denied.isError).toBe(true);
    expect(denied.result).toContain('AccessDenied');
  });

  it('dev_run_sql_readonly is refused when the switch is off and runs the read-only path when on', async () => {
    const e = createTriageToolExecutor(ctx());
    expect((await e('dev_run_sql_readonly', { sql: 'select 1' })).result).toMatch(/disabled on this stack/);
    process.env.OPERATOR_SQL_READONLY_ENABLED = 'true';
    mockSql.mockResolvedValue({ rows: [{ n: 2 }], row_count: 1, kind: 'select', read_only_transaction: true });
    const out = await e('dev_run_sql_readonly', { sql: 'select count(*) as n from dev_autopilot_executions', max_rows: 5 });
    expect(mockSql).toHaveBeenCalledWith({ sql: 'select count(*) as n from dev_autopilot_executions', max_rows: 5, timeout_ms: undefined }, expect.objectContaining({ threadId: 'triage:VTID-1' }));
    expect(out.result).toContain('"n": 2');
    expect((await e('dev_run_sql_readonly', {})).isError).toBe(true);
  });

  it('get_architecture_reports reads newest-first by vtid or topic substring and says so when empty', async () => {
    const f = supabaseFetch([{ vtid: 'VTID-1', root_cause: 'watcher raced', confidence: 0.8, llm_provider: 'bedrock' }]);
    const e = createTriageToolExecutor({ ...ctx(), fetchImpl: f as any });
    const out = await e('get_architecture_reports', { vtid: 'VTID-1', limit: 3 });
    expect(f.mock.calls[0][0]).toContain('vtid=eq.VTID-1');
    expect(f.mock.calls[0][0]).toContain('order=created_at.desc');
    expect(f.mock.calls[0][0]).toContain('limit=3');
    expect(out.result).toContain('watcher raced');
    const empty = supabaseFetch([]);
    expect(await fetchArchitectureReports({ topic: 'orb.live' }, process.env, empty as any)).toMatch(/no architecture_reports rows match topic~orb.live/);
    expect(empty.mock.calls[0][0]).toContain('incident_topic=ilike.*orb.live*');
  });

  it('an unknown tool names the allowed set; a throwing dependency becomes an error result', async () => {
    const e = createTriageToolExecutor(ctx());
    const u = await e('write_file', {});
    expect(u.isError).toBe(true);
    expect(u.result).toContain('query_oasis_events, dev_cloudwatch_logs, dev_ecs_tasks, dev_run_sql_readonly, get_architecture_reports');
    const bad = createTriageToolExecutor({ vtid: 'V', queryOasisEvents: async () => { throw new Error('kaput'); } });
    expect((await bad('query_oasis_events', { vtid: 'V' })).result).toContain('kaput');
  });
});

describe('spawnTriageAgent with tools (VTID-04232)', () => {
  it('runs the triage stage with the five tools, executes a tool round, and parses the final report with telemetry', async () => {
    global.fetch = supabaseFetch([{ topic: 'dev_autopilot.execution.claimed', created_at: 't1' }]) as any;
    mockRouter
      .mockResolvedValueOnce({ ok: true, toolCalls: [{ id: 'c1', name: 'query_oasis_events', arguments: { vtid: 'VTID-7' } }], provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' })
      .mockResolvedValueOnce({ ok: true, text: REPORT, provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' });
    const r = await spawnTriageAgent({ mode: 'pre_fix', vtid: 'VTID-7', diagnosis: { failure_class: 'x' }, failure: { endpoint: '/api/v1/x' } });
    expect(r.ok).toBe(true);
    expect(r.report).toMatchObject({ severity: 'warning', confidence: 'high', llm_provider: 'bedrock', tool_calls: 1, tools_used: ['query_oasis_events'], llm_fallback_used: false });
    expect(r.report?.root_cause_hypothesis).toContain('watcher ran twice');
    const [stage, prompt, opts] = mockRouter.mock.calls[0];
    expect(stage).toBe('triage');
    expect(prompt).toMatch(/PRE-FIX DEEP TRIAGE/);
    expect(prompt).toMatch(/get_architecture_reports/);
    expect(prompt).not.toMatch(/\/workspace\/repo/);
    expect(opts).toMatchObject({ vtid: 'VTID-7', service: 'self-healing-triage', systemPrompt: TRIAGE_SYSTEM_PROMPT, allowFallback: true, maxTokens: 4000 });
    expect((opts.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([...TRIAGE_TOOL_NAMES]);
    const second = mockRouter.mock.calls[1][2];
    expect(second.history[2].toolResults[0]).toMatchObject({ id: 'c1', name: 'query_oasis_events' });
    expect(second.history[2].toolResults[0].result).toContain('dev_autopilot.execution.claimed');
  });

  it('still pre-fetches the diagnosis session events into the prompt', async () => {
    const f = supabaseFetch([{ topic: 'orb.live.diag', created_at: 't1' }]);
    global.fetch = f as any;
    mockRouter.mockResolvedValue({ ok: true, text: REPORT });
    await spawnTriageAgent({ mode: 'pre_fix', vtid: 'VTID-7', diagnosis: { session_id: 'live-xyz' } });
    expect(f.mock.calls[0][0]).toContain('metadata->>session_id.eq.live-xyz');
    expect(mockRouter.mock.calls[0][1]).toContain('OASIS events for session live-xyz');
  });

  it('bounds the loop at TRIAGE_MAX_TOOL_CALLS and then asks for the report without tools', async () => {
    global.fetch = supabaseFetch([]) as any;
    mockRouter.mockImplementation(async (_s: string, _p: string, opts: { tools?: unknown[] }) =>
      opts.tools ? { ok: true, toolCalls: Array.from({ length: 4 }, () => ({ name: 'query_oasis_events', arguments: { vtid: 'VTID-7' } })) } : { ok: true, text: REPORT });
    const r = await spawnTriageAgent({ mode: 'post_failure', vtid: 'VTID-7', endpoint: '/x', failure_class: 'c', all_attempts: 2 });
    expect(r.ok).toBe(true);
    expect(r.report?.tool_calls).toBe(TRIAGE_MAX_TOOL_CALLS);
    expect(mockRouter.mock.calls.length).toBeLessThanOrEqual(TRIAGE_MAX_TURNS + 1);
    expect(mockRouter.mock.calls[mockRouter.mock.calls.length - 1][2].tools).toBeUndefined();
  });

  it('a router failure or empty text is ok:false with the error, never a throw', async () => {
    global.fetch = supabaseFetch([]) as any;
    mockRouter.mockResolvedValueOnce({ ok: false, error: 'no provider' });
    const r = await spawnTriageAgent({ mode: 'verification_failure', vtid: 'VTID-7', applied_spec: 's' });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain('no provider');
    mockRouter.mockResolvedValueOnce({ ok: true, text: '' });
    const r2 = await spawnTriageAgent({ mode: 'verification_failure', vtid: 'VTID-7' });
    expect(r2.ok).toBe(false);
  });

  it('SELF_HEALING_TRIAGE_TOOLS_ENABLED=false restores the single-shot call with no tools', async () => {
    process.env.SELF_HEALING_TRIAGE_TOOLS_ENABLED = 'false';
    global.fetch = supabaseFetch([]) as any;
    mockRouter.mockResolvedValue({ ok: true, text: REPORT });
    const r = await spawnTriageAgent({ mode: 'pre_fix', vtid: 'VTID-7', diagnosis: {} });
    expect(r.ok).toBe(true);
    expect(mockRouter).toHaveBeenCalledTimes(1);
    expect(mockRouter.mock.calls[0][2].tools).toBeUndefined();
    expect(r.report?.tool_calls).toBe(0);
  });
});
