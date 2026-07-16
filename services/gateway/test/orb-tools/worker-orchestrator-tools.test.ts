/**
 * Developer Worker Orchestrator voice tools (Wave 5, plan section C5) —
 * unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  WORKER_ORCHESTRATOR_TOOL_HANDLERS,
  WORKER_ORCHESTRATOR_TOOL_DECLARATIONS,
  dev_list_workers,
  dev_release_claim,
  dev_cleanup_stale_claims,
  dev_route_to_subagent,
} from '../../src/services/orb-tools/worker-orchestrator-tools';

const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'developer' };

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('catalogue', () => {
  const names = Object.keys(WORKER_ORCHESTRATOR_TOOL_HANDLERS);

  it('exposes 9 tools with matching declarations (dev_get_task_progress intentionally skipped)', () => {
    expect(names).toHaveLength(9);
    const declNames = WORKER_ORCHESTRATOR_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await WORKER_ORCHESTRATOR_TOOL_HANDLERS[name](
      { vtid: 'VTID-0001', worker_id: 'w1', title: 'x' },
      COMMUNITY_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await WORKER_ORCHESTRATOR_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('dev_list_workers', () => {
  it('reports active workers', async () => {
    mockFetch(200, { workers: [{ id: 'w1' }] });
    const r = await dev_list_workers({}, DEV_ID, {} as SupabaseClient);
    expect(r.text).toContain('1 active workers');
  });
});

describe('dev_release_claim', () => {
  it('requires vtid and worker_id', async () => {
    const r = await dev_release_claim({}, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await dev_release_claim({ vtid: 'VTID-0001', worker_id: 'w1' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('dev_cleanup_stale_claims', () => {
  it('requires confirmation first', async () => {
    const r = await dev_cleanup_stale_claims({}, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('reports the expired count on confirm', async () => {
    mockFetch(200, { expired_count: 3 });
    const r = await dev_cleanup_stale_claims({ confirm: true }, DEV_ID, {} as SupabaseClient);
    expect(r.text).toContain('3 stale claims');
  });
});

describe('dev_route_to_subagent', () => {
  it('validates vtid format and title', async () => {
    const r = await dev_route_to_subagent({ vtid: 'bad', title: 'x' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await dev_route_to_subagent({ vtid: 'VTID-0001', title: 'Fix bug' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('surfaces EXECUTION_DISARMED honestly', async () => {
    mockFetch(403, { error: 'EXECUTION_DISARMED' });
    const r = await dev_route_to_subagent({ vtid: 'VTID-0001', title: 'Fix bug', confirm: true }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('execution_disarmed');
  });
});
