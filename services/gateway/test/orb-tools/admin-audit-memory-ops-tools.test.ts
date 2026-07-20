/**
 * Admin Audit, i18n & Memory Ops voice tools (Wave 6, plan section B16) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_AUDIT_MEMORY_OPS_TOOL_HANDLERS,
  ADMIN_AUDIT_MEMORY_OPS_TOOL_DECLARATIONS,
  admin_audit_actions_log,
  admin_audit_access_log,
  admin_run_memory_consolidator,
  admin_run_embeddings_backfill,
} from '../../src/services/orb-tools/admin-audit-memory-ops-tools';

const EXAFY_ID: OrbToolIdentity = { user_id: 'u-exafy', tenant_id: 't-1', role: 'exafy_admin', user_jwt: 'jwt-xyz' };
const ADMIN_ID: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'admin', user_jwt: 'jwt-abc' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'admin' };

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
  const names = Object.keys(ADMIN_AUDIT_MEMORY_OPS_TOOL_HANDLERS);

  it('exposes all 4 tools with matching declarations', () => {
    expect(names).toHaveLength(4);
    const declNames = ADMIN_AUDIT_MEMORY_OPS_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await ADMIN_AUDIT_MEMORY_OPS_TOOL_HANDLERS[name]({}, COMMUNITY_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_AUDIT_MEMORY_OPS_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('admin_audit_actions_log / admin_audit_access_log', () => {
  it('reports actions', async () => {
    mockFetch(200, { actions: [{ action: 'grant_role' }] });
    const r = await admin_audit_actions_log({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.text).toContain('1 admin actions');
  });

  it('handles empty access log', async () => {
    mockFetch(200, { access_log: [] });
    const r = await admin_audit_access_log({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.text).toBe('No access events logged.');
  });
});

describe('admin_run_memory_consolidator', () => {
  it('rejects a plain admin (exafy_admin only)', async () => {
    const r = await admin_run_memory_consolidator({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first, scoped', async () => {
    const r = await admin_run_memory_consolidator({ user_id: 'u1', tenant_id: 't1' }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean; scope: unknown }).requires_confirmation).toBe(true);
    expect((r.result as { scope: unknown }).scope).toEqual({ user_id: 'u1', tenant_id: 't1' });
  });

  it('warns about all-users sweep when unscoped', async () => {
    const r = await admin_run_memory_consolidator({}, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('ALL users');
  });

  it('runs on confirm', async () => {
    mockFetch(200, { run_id: 'run-1', status: 'started' });
    const r = await admin_run_memory_consolidator({ confirm: true }, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('run-1');
  });
});

describe('admin_run_embeddings_backfill', () => {
  it('requires confirmation unless dry_run', async () => {
    const r = await admin_run_embeddings_backfill({}, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('skips confirmation on dry_run', async () => {
    mockFetch(200, { would_process: 42 });
    const r = await admin_run_embeddings_backfill({ dry_run: true }, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('42');
  });

  it('reports backfill results on confirm', async () => {
    mockFetch(200, { processed_count: 10, errors_count: 0 });
    const r = await admin_run_embeddings_backfill({ confirm: true }, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('Backfilled 10 items');
  });
});
