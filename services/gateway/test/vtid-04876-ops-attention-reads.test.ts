/**
 * VTID-04876 — the production AttentionReads are wired to the in-process
 * builders/services (plan F3: never an HTTP self-call), bounded supabase
 * reads throw on error (→ UNKNOWN, never "nothing found"), and the
 * ops_attention_state store writes (env, fingerprint) upserts.
 * Every dependency is mocked; no network, no database.
 */

const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
let tableResult: Record<string, { data: unknown; error: unknown }> = {};

function chain(table: string) {
  const rec = { table, ops: [] as Array<[string, unknown[]]> };
  calls.push(rec);
  const c: any = {};
  for (const m of ['select', 'in', 'gte', 'lt', 'eq', 'neq', 'like', 'or', 'order', 'limit', 'upsert']) {
    c[m] = (...args: unknown[]) => { rec.ops.push([m, args]); return c; };
  }
  c.then = (res: any, rej: any) => Promise.resolve(tableResult[table] ?? { data: [], error: null }).then(res, rej);
  return c;
}

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({ from: (t: string) => chain(t) }) }));
jest.mock('../src/services/health-summary-builder', () => ({
  buildHealthSummary: jest.fn(async () => ({ checked_at: 'T', items: [{ name: 'Gateway', golden_path: true }] })),
}));
jest.mock('../src/services/pipeline-summary-builder', () => ({
  buildPipelineSummary: jest.fn(async () => ({ status: 200, body: { attention_queue: [{ vtid: 'VTID-1', severity: 'BROKEN' }, { vtid: 'VTID-2', severity: 'STUCK' }] } })),
}));
jest.mock('../src/services/voice-supervisor-overview', () => ({
  buildVoiceOverview: jest.fn(async () => ({ verdict_summary: 'healthy', verdicts: [], window: '1h', generated_at: 'T' })),
}));
jest.mock('../src/services/dev-autopilot-supervisor', () => ({
  buildSupervisorSnapshot: jest.fn(async () => ({ ok: true, alerts: [{ severity: 'warning', text: 'x', tab: 'runs' }] })),
}));
jest.mock('../src/services/system-controls-service', () => ({ getAllSystemControls: jest.fn(async () => []) }));
jest.mock('../src/routes/worker-orchestrator', () => ({
  isAutonomousExecutionTask: jest.fn((t: any) => t?.metadata?.autonomous_execution === true),
}));
jest.mock('../src/routes/approvals', () => ({
  fetchApprovalEligibleVtids: jest.fn(async () => [{ vtid: 'VTID-9', title: 'T9', updated_at: 'U' }, { vtid: 'VTID-8', updated_at: 'U' }]),
  fetchPrInfoForVtids: jest.fn(async () => new Map([['VTID-9', { pr_number: 12, head_branch: null }]])),
}));
jest.mock('../src/routes/ops-runtime-health', () => ({
  runRuntimeCheckCached: jest.fn(async (k: string) => ({ status: 'ok', commit: k })),
}));

import { createAttentionReads, supabaseAttentionStateStore } from '../src/services/ops-attention-reads';
import { buildHealthSummary } from '../src/services/health-summary-builder';
import { buildVoiceOverview } from '../src/services/voice-supervisor-overview';
import { getAllSystemControls } from '../src/services/system-controls-service';
import { runRuntimeCheckCached } from '../src/routes/ops-runtime-health';

beforeEach(() => {
  calls.length = 0;
  tableResult = {};
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc';
  delete process.env.VTID_ALLOCATOR_ENABLED;
});

describe('in-process wiring (no HTTP self-calls)', () => {
  const fetchSpy = jest.fn();
  beforeAll(() => { (global as any).fetch = fetchSpy; });

  it('service health → buildHealthSummary with the caller auth header', async () => {
    const r = createAttentionReads({ authHeader: 'Bearer admin' });
    await r.healthSummary();
    expect(buildHealthSummary).toHaveBeenCalledWith({ authHeader: 'Bearer admin' });
  });

  it('voice → buildVoiceOverview({window:"1h", scope:{is_platform_admin:true}})', async () => {
    await createAttentionReads().voiceOverview();
    expect(buildVoiceOverview).toHaveBeenCalledWith({ window: '1h', scope: { is_platform_admin: true } });
  });

  it('release build-info → the cached ops-runtime checks', async () => {
    const r = createAttentionReads();
    expect((await r.buildInfo('prod')).commit).toBe('deploy/prod-gateway');
    expect((await r.buildInfo('staging')).commit).toBe('deploy/staging-gateway');
    expect(runRuntimeCheckCached).toHaveBeenCalledTimes(2);
  });

  it('operator → buildPipelineSummary BROKEN vtids + isAutonomousExecutionTask', async () => {
    const r = createAttentionReads();
    expect(await r.pipelineBrokenVtids()).toEqual(['VTID-1']);
    expect(r.isAutonomous({ metadata: { autonomous_execution: true } } as any)).toBe(true);
    expect(r.isAutonomous({ metadata: { source: 'claude-code' } } as any)).toBe(false);
  });

  it('autonomy → buildSupervisorSnapshot alerts', async () => {
    expect(await createAttentionReads().supervisorAlerts()).toEqual([{ severity: 'warning', text: 'x', tab: 'runs' }]);
  });

  it('PR approvals → the /approvals/pending helpers, only rows with a PR or branch', async () => {
    expect(await createAttentionReads().prApprovalsPending()).toEqual([{ id: 'VTID-9', vtid: 'VTID-9', title: 'T9', waiting_since: 'U' }]);
  });

  it('nothing above used fetch', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('bounded supabase reads', () => {
  it('oasis_events latestEvent: topic IN + created_at >= + newest first + LIMIT 1', async () => {
    tableResult.oasis_events = { data: [{ topic: 'prod.deploy.failed', created_at: 'X' }], error: null };
    const ev = await createAttentionReads().latestEvent(['prod.deploy.failed'], 'S');
    expect(ev).toEqual({ topic: 'prod.deploy.failed', created_at: 'X' });
    expect(calls[0].ops).toEqual([
      ['select', ['topic,created_at,metadata']],
      ['in', ['topic', ['prod.deploy.failed']]],
      ['gte', ['created_at', 'S']],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [1]],
    ]);
  });

  it('a read error throws instead of returning an empty list', async () => {
    tableResult.self_healing_log = { data: null, error: { message: 'boom' } };
    await expect(createAttentionReads().selfHealOutcomes('S')).rejects.toThrow('self_healing_log: boom');
  });

  it('in-progress ledger: VTID-% in_progress non-terminal, LIMIT 500', async () => {
    await createAttentionReads().inProgressLedger();
    const ops = calls[0].ops.map((o) => o[0]);
    expect(calls[0].table).toBe('vtid_ledger');
    expect(ops).toEqual(['select', 'like', 'eq', 'or', 'limit']);
  });

  it('self-heal pending approval drops human-decided rows', async () => {
    tableResult.self_healing_log = {
      data: [{ id: 1, vtid: 'VTID-5', endpoint: '/e', created_at: 'C', diagnosis: {} }, { id: 2, vtid: 'VTID-6', endpoint: '/f', created_at: 'C', diagnosis: { human_decision: 'approved' } }],
      error: null,
    };
    expect(await createAttentionReads().selfHealPendingApproval()).toEqual([{ id: '1', vtid: 'VTID-5', title: '/e', waiting_since: 'C' }]);
  });

  it('system controls: an empty list is unreadable; a missing allocator row is disabled unless the env var is set', async () => {
    await expect(createAttentionReads().systemControls()).rejects.toThrow(/unreadable/);
    (getAllSystemControls as jest.Mock).mockResolvedValue([{ key: 'autopilot_execution_enabled', enabled: true, reason: '', updated_by: null, updated_at: 'U' }]);
    const rows = await createAttentionReads().systemControls();
    expect(rows.find((r) => r.key === 'vtid_allocator_enabled')).toMatchObject({ enabled: false });
    process.env.VTID_ALLOCATOR_ENABLED = 'true';
    (getAllSystemControls as jest.Mock).mockResolvedValue([{ key: 'vtid_allocator_enabled', enabled: false, reason: '', updated_by: null, updated_at: 'U' }]);
    expect((await createAttentionReads().systemControls()).find((r) => r.key === 'vtid_allocator_enabled')!.enabled).toBe(true);
  });

  it('kill switch: row → engaged flag; no row → null', async () => {
    tableResult.dev_autopilot_config = { data: [{ kill_switch: true }], error: null };
    expect(await createAttentionReads().devAutopilotKillSwitch()).toEqual({ engaged: true });
    tableResult.dev_autopilot_config = { data: [], error: null };
    expect(await createAttentionReads().devAutopilotKillSwitch()).toBeNull();
  });
});

describe('ops_attention_state store', () => {
  it('loads by env + fingerprints and upserts (env, fingerprint)', async () => {
    const store = supabaseAttentionStateStore();
    await store.load('staging', ['staging:a:b']);
    expect(calls[0].table).toBe('ops_attention_state');
    expect(calls[0].ops).toEqual([
      ['select', ['fingerprint,first_seen,last_seen']],
      ['eq', ['env', 'staging']],
      ['in', ['fingerprint', ['staging:a:b']]],
    ]);
    await store.save('staging', [{ fingerprint: 'staging:a:b', first_seen: 'F', last_seen: 'L' }]);
    expect(calls[1].ops).toEqual([
      ['upsert', [[{ env: 'staging', fingerprint: 'staging:a:b', first_seen: 'F', last_seen: 'L' }], { onConflict: 'env,fingerprint' }]],
    ]);
  });

  it('a write error throws (the aggregator logs it and carries on)', async () => {
    tableResult.ops_attention_state = { data: null, error: { message: 'denied' } };
    await expect(supabaseAttentionStateStore().save('production', [{ fingerprint: 'f', first_seen: 'a', last_seen: 'b' }])).rejects.toThrow('denied');
  });
});
