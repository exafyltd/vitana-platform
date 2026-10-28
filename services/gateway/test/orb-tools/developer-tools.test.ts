/**
 * Developer voice tools (VTID-02782) — unit tests.
 *
 * Mocked SupabaseClient (chainable stub, no network) + mocked global fetch
 * for the approvals-route self-calls. Covers per tool: happy path with
 * speakable text containing the actual content, plus the server-side role
 * gate (community role denied with developer_role_required, unauthenticated
 * denied).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  DEVELOPER_TOOL_HANDLERS,
  DEVELOPER_TOOL_DECLARATIONS,
  developerGate,
  normalizeVtidCandidates,
  approvalIdForVtid,
  deriveAgentStatus,
  dev_list_vtids,
  dev_get_vtid_status,
  dev_list_pending_approvals,
  dev_count_approvals,
  dev_approve_pr,
  dev_reject_pr,
  dev_list_voice_sessions,
  dev_list_routines,
  dev_get_routine_detail,
  dev_list_active_healing,
  dev_get_autonomy_pulse,
  dev_list_agents,
} from '../../src/services/orb-tools/developer-tools';

const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer' };
const ADMIN_ID: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'exafy_admin' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'developer' };

// ---------------------------------------------------------------------------
// Chainable Supabase stub. Per-table queue: each .from(table) call consumes
// the next queued response (last one repeats).
// ---------------------------------------------------------------------------

interface StubResp {
  data: unknown;
  error: { message: string } | null;
}

function makeSb(tables: Record<string, StubResp[]> = {}): SupabaseClient {
  const used: Record<string, number> = {};
  const sb = {
    from(table: string) {
      const queue = tables[table] ?? [];
      const i = used[table] ?? 0;
      used[table] = i + 1;
      const resp: StubResp = queue[Math.min(i, queue.length - 1)] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit', 'filter', 'or', 'ilike']) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = () =>
        Promise.resolve({
          data: Array.isArray(resp.data) ? ((resp.data as unknown[])[0] ?? null) : resp.data,
          error: resp.error,
        });
      chain.then = (onOk: (v: StubResp) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve(resp).then(onOk, onErr);
      return chain;
    },
  };
  return sb as unknown as SupabaseClient;
}

const ok = (data: unknown): StubResp => ({ data, error: null });

// ---------------------------------------------------------------------------
// fetch mock for the approvals self-calls
// ---------------------------------------------------------------------------

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

// ---------------------------------------------------------------------------
// Role gate — every tool must deny non-developer roles server-side
// ---------------------------------------------------------------------------

describe('developer role gate', () => {
  const names = Object.keys(DEVELOPER_TOOL_HANDLERS);

  it('exposes all 12 tools', () => {
    expect(names).toHaveLength(12);
  });

  it.each(names)('%s denies community role with developer_role_required', async (name) => {
    const r = await DEVELOPER_TOOL_HANDLERS[name]({ vtid: '1', name: 'x', reason: 'r' }, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('developer_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await DEVELOPER_TOOL_HANDLERS[name]({ vtid: '1', name: 'x', reason: 'r' }, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('authenticated');
  });

  it('allows developer, admin and exafy_admin', () => {
    expect(developerGate(DEV_ID)).toBeNull();
    expect(developerGate(ADMIN_ID)).toBeNull();
    expect(developerGate({ ...DEV_ID, role: 'admin' })).toBeNull();
    expect(developerGate({ ...DEV_ID, role: 'patient' })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// VTID helpers
// ---------------------------------------------------------------------------

describe('normalizeVtidCandidates', () => {
  it('accepts loose spoken forms', () => {
    expect(normalizeVtidCandidates('VTID-01234')).toContain('VTID-01234');
    expect(normalizeVtidCandidates('vtid 1234')).toContain('VTID-01234');
    expect(normalizeVtidCandidates('1234')).toContain('VTID-1234');
    expect(normalizeVtidCandidates('1234')).toContain('VTID-01234');
    expect(normalizeVtidCandidates('0542')).toContain('VTID-0542');
    expect(normalizeVtidCandidates('nope')).toEqual([]);
  });
});

describe('approvalIdForVtid', () => {
  it('matches the routes/approvals.ts deterministic format', () => {
    expect(approvalIdForVtid('VTID-01234')).toMatch(/^appr_VTID-01234_[0-9a-f]{6}$/);
  });
});

// ---------------------------------------------------------------------------
// dev_list_vtids / dev_get_vtid_status
// ---------------------------------------------------------------------------

describe('dev_list_vtids', () => {
  it('speaks id + title + status for recent ledger rows', async () => {
    const sb = makeSb({
      vtid_ledger: [ok([
        { vtid: 'VTID-02782', title: 'Developer voice tools', status: 'in_progress', spec_status: 'approved', is_terminal: false, created_at: '2026-07-06T08:00:00Z', updated_at: null },
        { vtid: 'VTID-02781', title: null, description: 'Health tools', status: 'completed', spec_status: 'approved', is_terminal: true, created_at: '2026-07-05T08:00:00Z', updated_at: null },
      ])],
    });
    const r = await dev_list_vtids({ limit: 5 }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain('VTID-02782');
    expect(text).toContain('Developer voice tools');
    expect(text).toContain('in_progress');
    expect(text).toContain('Health tools');
  });

  it('speaks a plain empty state', async () => {
    const r = await dev_list_vtids({ status: 'blocked' }, DEV_ID, makeSb({ vtid_ledger: [ok([])] }));
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('blocked');
  });
});

describe('dev_get_vtid_status', () => {
  it('normalizes loose ids and speaks the full status', async () => {
    const sb = makeSb({
      vtid_ledger: [ok([{
        vtid: 'VTID-01200', title: 'Worker-Runner Execution Plane', status: 'completed',
        spec_status: 'approved', is_terminal: true, terminal_outcome: 'success',
        claimed_by: 'worker-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
      }])],
    });
    const r = await dev_get_vtid_status({ vtid: 'vtid 1200' }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain('VTID-01200');
    expect(text).toContain('Worker-Runner Execution Plane');
    expect(text).toContain('completed');
    expect(text).toContain('success');
  });

  it('answers plainly when the VTID is unknown', async () => {
    const r = await dev_get_vtid_status({ vtid: '99999' }, DEV_ID, makeSb({ vtid_ledger: [ok([])] }));
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('could not find');
  });

  it('rejects input without digits', async () => {
    const r = await dev_get_vtid_status({ vtid: 'the latest one' }, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Approvals queue (read)
// ---------------------------------------------------------------------------

describe('dev_list_pending_approvals', () => {
  it('speaks vtid, title, PR and checks per queue item', async () => {
    mockFetch(200, {
      ok: true,
      items: [{
        approval_id: 'appr_VTID-02700_abc123', vtid: 'VTID-02700', title: 'Fix voice quota guard',
        pr_number: 2311, head_branch: 'claude/fix-quota', checks_status: 'pass', governance_status: 'pending',
      }],
    });
    const r = await dev_list_pending_approvals({}, DEV_ID, makeSb());
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain('VTID-02700');
    expect(text).toContain('Fix voice quota guard');
    expect(text).toContain('PR #2311');
    expect(text).toContain('checks pass');
  });

  it('speaks an empty queue plainly', async () => {
    mockFetch(200, { ok: true, items: [] });
    const r = await dev_list_pending_approvals({}, DEV_ID, makeSb());
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('empty');
  });

  it('fails loudly when the approvals API errors', async () => {
    mockFetch(500, { ok: false, error: 'boom' });
    const r = await dev_list_pending_approvals({}, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('dev_count_approvals', () => {
  it('speaks the pending count', async () => {
    mockFetch(200, { ok: true, pending_count: 3 });
    const r = await dev_count_approvals({}, DEV_ID, makeSb());
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('3 items');
  });
});

// ---------------------------------------------------------------------------
// Approve / reject (confirm-gated mutations)
// ---------------------------------------------------------------------------

describe('dev_approve_pr', () => {
  it('asks for confirmation before mutating', async () => {
    const fetchFn = mockFetch(200, { ok: true });
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-02700' }])] });
    const r = await dev_approve_pr({ vtid: '2700' }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
    expect((r as { text: string }).text.toLowerCase()).toContain('confirm');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('calls the Command Hub approve route after confirm', async () => {
    const fetchFn = mockFetch(200, { ok: true, result: { merged: true } });
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-02700' }])] });
    const r = await dev_approve_pr({ vtid: 'VTID-02700', confirm: true }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('merged');
    const url = String(fetchFn.mock.calls[0][0]);
    expect(url).toContain(`/api/v1/approvals/${approvalIdForVtid('VTID-02700')}/approve`);
  });

  it('reports a failed merge without throwing', async () => {
    mockFetch(400, { ok: false, error: 'Cannot approve: CI is fail' });
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-02700' }])] });
    const r = await dev_approve_pr({ vtid: '2700', confirm: true }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('did not go through');
    expect((r as { text: string }).text).toContain('CI is fail');
  });

  it('errors when the VTID is not in the ledger', async () => {
    const r = await dev_approve_pr({ vtid: '2700' }, DEV_ID, makeSb({ vtid_ledger: [ok([])] }));
    expect(r.ok).toBe(false);
  });
});

describe('dev_reject_pr', () => {
  it('requires a reason', async () => {
    const r = await dev_reject_pr({ vtid: '2700', confirm: true }, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('reason');
  });

  it('asks for confirmation before mutating', async () => {
    const fetchFn = mockFetch(200, { ok: true });
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-02700' }])] });
    const r = await dev_reject_pr({ vtid: '2700', reason: 'wrong approach' }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('wrong approach');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('posts the rejection with reason after confirm', async () => {
    const fetchFn = mockFetch(200, { ok: true });
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-02700' }])] });
    const r = await dev_reject_pr({ vtid: '2700', reason: 'stale spec', confirm: true }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('rejected');
    const url = String(fetchFn.mock.calls[0][0]);
    expect(url).toContain(`/api/v1/approvals/${approvalIdForVtid('VTID-02700')}/reject`);
    expect(String(fetchFn.mock.calls[0][1].body)).toContain('stale spec');
  });
});

// ---------------------------------------------------------------------------
// dev_list_voice_sessions
// ---------------------------------------------------------------------------

describe('dev_list_voice_sessions', () => {
  const starts = ok([
    { created_at: '2026-07-06T09:00:00Z', vitana_id: null, metadata: { session_id: 's-active', email: 'live@vitana.dev', active_role: 'community', lang: 'de' } },
    { created_at: '2026-07-06T08:00:00Z', vitana_id: null, metadata: { session_id: 's-done', email: 'dev@vitana.dev', active_role: 'developer', lang: 'de' } },
  ]);
  const ends = ok([
    { created_at: '2026-07-06T08:10:00Z', vitana_id: null, metadata: { session_id: 's-done', duration_ms: 600000, turn_count: 12 } },
  ]);

  it('speaks user, status and turns per session', async () => {
    const sb = makeSb({ oasis_events: [starts, ends] });
    const r = await dev_list_voice_sessions({}, DEV_ID, sb);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain('live@vitana.dev');
    expect(text).toContain('active');
    expect(text).toContain('dev@vitana.dev');
    expect(text).toContain('ended');
    expect(text).toContain('12 turns');
  });

  it('filters to active sessions', async () => {
    const sb = makeSb({ oasis_events: [starts, ends] });
    const r = await dev_list_voice_sessions({ status: 'active' }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain('live@vitana.dev');
    expect(text).not.toContain('dev@vitana.dev');
  });

  it('speaks an empty state plainly', async () => {
    const sb = makeSb({ oasis_events: [ok([]), ok([])] });
    const r = await dev_list_voice_sessions({ status: 'active' }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('No ORB voice sessions');
  });
});

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

describe('dev_list_routines', () => {
  it('speaks failing routines first with counts', async () => {
    const sb = makeSb({
      routines: [ok([
        { name: 'a-ok', display_name: 'Morning Report', cron_schedule: '0 6 * * *', enabled: true, last_run_at: '2026-07-06T06:00:00Z', last_run_status: 'success', last_run_summary: null, consecutive_failures: 0 },
        { name: 'z-bad', display_name: 'Nightly Audit', cron_schedule: '0 2 * * *', enabled: true, last_run_at: '2026-07-06T02:00:00Z', last_run_status: 'failure', last_run_summary: null, consecutive_failures: 3 },
      ])],
    });
    const r = await dev_list_routines({}, DEV_ID, sb);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain('2 routines');
    expect(text).toContain('1 failing');
    expect(text.indexOf('Nightly Audit')).toBeLessThan(text.indexOf('Morning Report'));
    expect(text).toContain('3 consecutive failures');
  });
});

describe('dev_get_routine_detail', () => {
  it('speaks the routine plus its recent runs', async () => {
    const sb = makeSb({
      routines: [ok([{ name: 'morning-report', display_name: 'Morning Report', cron_schedule: '0 6 * * *', enabled: true, last_run_at: '2026-07-06T06:00:00Z', last_run_status: 'success', last_run_summary: 'All green', consecutive_failures: 0 }])],
      routine_runs: [ok([
        { id: 'r1', started_at: '2026-07-06T06:00:00Z', finished_at: '2026-07-06T06:04:00Z', status: 'success', trigger: 'cron', summary: 'All green', error: null, duration_ms: 240000 },
        { id: 'r2', started_at: '2026-07-05T06:00:00Z', finished_at: '2026-07-05T06:05:00Z', status: 'failure', trigger: 'cron', summary: null, error: 'timeout on gateway', duration_ms: 300000 },
      ])],
    });
    const r = await dev_get_routine_detail({ name: 'morning-report' }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain('Morning Report');
    expect(text).toContain('0 6 * * *');
    expect(text).toContain('All green');
    expect(text).toContain('timeout on gateway');
  });

  it('falls back to fuzzy match and reports unknown routines plainly', async () => {
    const sb = makeSb({ routines: [ok([]), ok([])] });
    const r = await dev_get_routine_detail({ name: 'does not exist' }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('could not find');
  });

  it('requires a name', async () => {
    const r = await dev_get_routine_detail({}, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Self-healing + autonomy pulse
// ---------------------------------------------------------------------------

describe('dev_list_active_healing', () => {
  it('speaks in-flight healing VTIDs and pending diagnoses', async () => {
    const sb = makeSb({
      vtid_ledger: [ok([{ vtid: 'VTID-02900', title: 'Heal /api/v1/diary', status: 'in_progress', spec_status: 'approved', created_at: '2026-07-06T07:00:00Z' }])],
      self_healing_log: [ok([{ id: 'h1', vtid: 'VTID-02901', endpoint: '/api/v1/events', failure_class: '5xx', created_at: '2026-07-06T07:30:00Z' }])],
    });
    const r = await dev_list_active_healing({}, DEV_ID, sb);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain('1 healing task');
    expect(text).toContain('VTID-02900');
    expect(text).toContain('Heal /api/v1/diary');
    expect(text).toContain('1 pending diagnosis');
    expect(text).toContain('/api/v1/events');
  });

  it('speaks a quiet state plainly', async () => {
    const sb = makeSb({ vtid_ledger: [ok([])], self_healing_log: [ok([])] });
    const r = await dev_list_active_healing({}, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('quiet');
  });
});

describe('dev_get_autonomy_pulse', () => {
  it('composes counts across the four pulse sources plus terminalized VTIDs', async () => {
    const sb = makeSb({
      autopilot_recommendations: [ok([{ id: 'f1', title: 'Slow query on feed', summary: 's', risk_class: 'high', impact_score: 9, effort_score: 2, auto_exec_eligible: true, domain: 'gateway', first_seen_at: '2026-07-06T05:00:00Z', seen_count: 2, spec_snapshot: null }])],
      self_healing_log: [ok([{ id: 'h1', vtid: 'VTID-02901', endpoint: '/api/v1/events', failure_class: 'timeout', created_at: '2026-07-06T07:30:00Z', diagnosis: { confidence: 0.9, summary: 'pool exhausted' }, attempt_number: 1 }])],
      dev_autopilot_executions: [ok([{ id: 'e1e2e3e4-0000', finding_id: 'f1', status: 'ci', pr_url: null, pr_number: null, branch: 'claude/fix', execute_after: null, auto_fix_depth: 0, self_healing_vtid: null, created_at: '2026-07-06T06:00:00Z', updated_at: null }])],
      test_contracts: [ok([])],
      vtid_ledger: [ok([{ vtid: 'VTID-02890', title: 'Done thing', terminal_outcome: 'success', updated_at: '2026-07-06T04:00:00Z' }])],
    });
    const r = await dev_get_autonomy_pulse({}, DEV_ID, sb);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain('1 pending findings');
    expect(text).toContain('1 pending heals');
    expect(text).toContain('1 executions in flight');
    expect(text).toContain('0 failing contracts');
    expect(text).toContain('1 VTIDs terminalized in the last 24 hours (1 succeeded)');
  });
});

// ---------------------------------------------------------------------------
// Agents registry
// ---------------------------------------------------------------------------

describe('deriveAgentStatus', () => {
  it('decays stale service heartbeats like routes/agents-registry.ts', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(deriveAgentStatus({ agent_id: 'a', display_name: null, tier: 'service', status: 'healthy', last_heartbeat_at: now, llm_provider: null })).toBe('healthy');
    expect(deriveAgentStatus({ agent_id: 'a', display_name: null, tier: 'service', status: 'healthy', last_heartbeat_at: old, llm_provider: null })).toBe('down');
    expect(deriveAgentStatus({ agent_id: 'a', display_name: null, tier: 'embedded', status: 'healthy', last_heartbeat_at: old, llm_provider: null })).toBe('healthy');
  });
});

describe('dev_list_agents', () => {
  it('speaks health counts with problem agents first', async () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    const sb = makeSb({
      agents_registry: [ok([
        { agent_id: 'gateway-conductor', display_name: 'Conductor', tier: 'embedded', status: 'healthy', last_heartbeat_at: fresh, llm_provider: 'gemini' },
        { agent_id: 'worker-runner', display_name: 'Worker Runner', tier: 'service', status: 'healthy', last_heartbeat_at: stale, llm_provider: 'claude' },
      ])],
    });
    const r = await dev_list_agents({}, DEV_ID, sb);
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain('2 agents');
    expect(text).toContain('1 healthy');
    expect(text).toContain('1 down');
    expect(text.indexOf('Worker Runner')).toBeLessThan(text.indexOf('Conductor'));
  });

  it('speaks an empty registry plainly', async () => {
    const r = await dev_list_agents({}, DEV_ID, makeSb({ agents_registry: [ok([])] }));
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text).toContain('empty');
  });
});

// ---------------------------------------------------------------------------
// Declarations — Vertex/Gemini Live safety
// ---------------------------------------------------------------------------

describe('DEVELOPER_TOOL_DECLARATIONS', () => {
  it('declares every handler and nothing else', () => {
    const declared = DEVELOPER_TOOL_DECLARATIONS.map((d) => d.name).sort();
    expect(declared).toEqual(Object.keys(DEVELOPER_TOOL_HANDLERS).sort());
  });

  it('uses only the OpenAPI-3.0 subset Vertex accepts (no default/minimum/maximum/format/examples)', () => {
    for (const decl of DEVELOPER_TOOL_DECLARATIONS) {
      const json = JSON.stringify(decl.parameters);
      for (const banned of ['"default"', '"minimum"', '"maximum"', '"format"', '"examples"']) {
        expect(json).not.toContain(banned);
      }
    }
  });

  it('reject declares reason as required; confirm flow documented on both mutations', () => {
    const reject = DEVELOPER_TOOL_DECLARATIONS.find((d) => d.name === 'dev_reject_pr') as { parameters: { required: string[] }; description: string };
    expect(reject.parameters.required).toContain('reason');
    const approve = DEVELOPER_TOOL_DECLARATIONS.find((d) => d.name === 'dev_approve_pr') as { description: string };
    expect(approve.description).toContain('confirm=true');
    expect(reject.description).toContain('confirm=true');
  });
});
