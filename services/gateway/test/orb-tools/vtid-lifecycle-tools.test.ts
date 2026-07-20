/**
 * VTID / OASIS Lifecycle voice tools (Wave 2, plan section C1) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  VTID_LIFECYCLE_TOOL_HANDLERS,
  VTID_LIFECYCLE_TOOL_DECLARATIONS,
  dev_allocate_vtid,
  dev_create_task,
  dev_update_task,
  dev_cancel_task,
  dev_complete_task,
  dev_terminalize_vtid,
  dev_discover_tasks,
  dev_get_allocator_status,
  dev_execute_vtid,
} from '../../src/services/orb-tools/vtid-lifecycle-tools';

const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'developer' };

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
      chain.then = (onOk: (v: StubResp) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve(resp).then(onOk, onErr);
      return chain;
    },
  };
  return sb as unknown as SupabaseClient;
}

const ok = (data: unknown): StubResp => ({ data, error: null });

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

describe('vtid-lifecycle role gate', () => {
  const names = Object.keys(VTID_LIFECYCLE_TOOL_HANDLERS);

  it('exposes all 15 tools with matching declarations', () => {
    expect(names).toHaveLength(15);
    const declNames = VTID_LIFECYCLE_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await VTID_LIFECYCLE_TOOL_HANDLERS[name](
      { vtid: 'VTID-0001', title: 'x', outcome: 'success', domain: 'backend', run_id: 'r1' },
      COMMUNITY_ID,
      makeSb(),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('developer_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await VTID_LIFECYCLE_TOOL_HANDLERS[name](
      { vtid: 'VTID-0001', title: 'x', outcome: 'success', domain: 'backend', run_id: 'r1' },
      ANON_ID,
      makeSb(),
    );
    expect(r.ok).toBe(false);
  });
});

describe('dev_allocate_vtid', () => {
  it('requires confirmation before allocating', async () => {
    const r = await dev_allocate_vtid({ title: 'New feature' }, DEV_ID, makeSb());
    expect(r.ok).toBe(true);
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('allocates after confirm=true', async () => {
    mockFetch(201, { ok: true, vtid: 'VTID-09999' });
    const r = await dev_allocate_vtid({ title: 'New feature', confirm: true }, DEV_ID, makeSb());
    expect(r.ok).toBe(true);
    expect(r.text).toContain('VTID-09999');
  });
});

describe('dev_create_task', () => {
  it('requires a title', async () => {
    const r = await dev_create_task({}, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await dev_create_task({ title: 'Do the thing' }, DEV_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('creates after confirm=true', async () => {
    mockFetch(201, { ok: true, vtid: 'VTID-08888' });
    const r = await dev_create_task({ title: 'Do the thing', confirm: true }, DEV_ID, makeSb());
    expect(r.text).toContain('VTID-08888');
  });
});

describe('dev_update_task', () => {
  it('refuses to modify a terminal task', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'completed', is_terminal: true }])] });
    const r = await dev_update_task({ vtid: '0001', title: 'renamed' }, DEV_ID, sb);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('terminal');
  });

  it('requires confirmation for a non-terminal task', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'in_progress', is_terminal: false }])] });
    const r = await dev_update_task({ vtid: '0001', title: 'renamed' }, DEV_ID, sb);
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });
});

describe('dev_cancel_task', () => {
  it('reports already-terminal tasks without calling the API', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'completed', is_terminal: true }])] });
    const r = await dev_cancel_task({ vtid: '0001' }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r as { result: { already_terminal: boolean } }).result.already_terminal).toBe(true);
  });

  it('deletes a pre-start task after confirm', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'scheduled', is_terminal: false }])] });
    mockFetch(200, { ok: true });
    const r = await dev_cancel_task({ vtid: '0001', confirm: true }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((global.fetch as jest.Mock).mock.calls[0][1].method).toBe('DELETE');
  });

  it('completes-as-cancelled an in-flight task after confirm', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'in_progress', is_terminal: false }])] });
    mockFetch(200, { ok: true });
    await dev_cancel_task({ vtid: '0001', confirm: true }, DEV_ID, sb);
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(call[0])).toContain('/complete');
  });
});

describe('dev_complete_task', () => {
  it('requires confirmation', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'in_progress', is_terminal: false }])] });
    const r = await dev_complete_task({ vtid: '0001' }, DEV_ID, sb);
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('reports a retry-reset on failed outcome', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'in_progress', is_terminal: false }])] });
    mockFetch(200, { status: 'scheduled', failure_count: 1 });
    const r = await dev_complete_task({ vtid: '0001', terminal_outcome: 'failed', confirm: true }, DEV_ID, sb);
    expect(r.text).toContain('reset for retry');
  });
});

describe('dev_terminalize_vtid', () => {
  it('rejects an invalid outcome', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'in_progress', is_terminal: false }])] });
    const r = await dev_terminalize_vtid({ vtid: '0001', outcome: 'bogus' }, DEV_ID, sb);
    expect(r.ok).toBe(false);
  });

  it('reports already_terminal idempotently', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'completed', is_terminal: false }])] });
    mockFetch(200, { ok: true, already_terminal: true });
    const r = await dev_terminalize_vtid({ vtid: '0001', outcome: 'success', confirm: true }, DEV_ID, sb);
    expect(r.text).toContain('already terminal');
  });
});

describe('dev_discover_tasks', () => {
  it('speaks eligible tasks', async () => {
    mockFetch(200, { ok: true, pending: [{ vtid: 'VTID-0001', title: 'Fix bug', status: 'scheduled' }] });
    const r = await dev_discover_tasks({}, DEV_ID, makeSb());
    expect(r.ok).toBe(true);
    expect(r.text).toContain('VTID-0001');
  });

  it('handles zero results honestly', async () => {
    mockFetch(200, { ok: true, pending: [] });
    const r = await dev_discover_tasks({}, DEV_ID, makeSb());
    expect(r.text).toContain('No eligible tasks');
  });
});

describe('dev_get_allocator_status', () => {
  it('speaks enabled/disabled state', async () => {
    mockFetch(200, { ok: true, enabled: true, message: 'all clear' });
    const r = await dev_get_allocator_status({}, DEV_ID, makeSb());
    expect(r.text).toContain('enabled');
  });
});

describe('dev_execute_vtid', () => {
  it('requires a title', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'scheduled', is_terminal: false }])] });
    const r = await dev_execute_vtid({ vtid: '0001' }, DEV_ID, sb);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation before routing to the orchestrator', async () => {
    const sb = makeSb({ vtid_ledger: [ok([{ vtid: 'VTID-0001', status: 'scheduled', is_terminal: false }])] });
    const r = await dev_execute_vtid({ vtid: '0001', title: 'Ship it' }, DEV_ID, sb);
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });
});
