/**
 * Admin Users & RBAC voice tools (Wave 3, plan section B1) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_USERS_RBAC_TOOL_HANDLERS,
  ADMIN_USERS_RBAC_TOOL_DECLARATIONS,
  adminGate,
  admin_grant_role,
  admin_revoke_role,
  admin_set_trust_tier,
  admin_lookup_user,
} from '../../src/services/orb-tools/admin-users-rbac-tools';

const ADMIN_ID: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'admin', user_jwt: 'jwt-abc' };
const EXAFY_ID: OrbToolIdentity = { user_id: 'u-exafy', tenant_id: 't-1', role: 'exafy_admin', user_jwt: 'jwt-xyz' };
const ADMIN_ID_NO_JWT: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'admin' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'admin' };
const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer', user_jwt: 'jwt' };

function makeSb(): SupabaseClient {
  return {} as unknown as SupabaseClient;
}

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

describe('admin role gate', () => {
  it('allows admin and exafy_admin, denies developer', () => {
    expect(adminGate(ADMIN_ID)).toBeNull();
    expect(adminGate(EXAFY_ID)).toBeNull();
    expect(adminGate(DEV_ID)).not.toBeNull();
  });

  const names = Object.keys(ADMIN_USERS_RBAC_TOOL_HANDLERS);

  it('exposes all 8 tools with matching declarations', () => {
    expect(names).toHaveLength(8);
    const declNames = ADMIN_USERS_RBAC_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const args = { user_id: 'u1', role: 'community', vitana_id: 'v1', tier: 'unverified', query: 'x' };
    const r = await ADMIN_USERS_RBAC_TOOL_HANDLERS[name](args, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('admin_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_USERS_RBAC_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('admin_lookup_user', () => {
  it('requires a session JWT', async () => {
    const r = await admin_lookup_user({ query: 'x' }, ADMIN_ID_NO_JWT, makeSb());
    expect((r.result as { reason: string }).reason).toBe('no_admin_session');
  });

  it('reports no matches honestly', async () => {
    mockFetch(200, { ok: true, candidates: [] });
    const r = await admin_lookup_user({ query: 'nobody' }, ADMIN_ID, makeSb());
    expect(r.text).toContain('No users matched');
  });
});

describe('admin_grant_role / admin_revoke_role', () => {
  it('grant requires confirmation', async () => {
    const r = await admin_grant_role({ user_id: 'u1', role: 'staff' }, ADMIN_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('revoke refuses to revoke community', async () => {
    const r = await admin_revoke_role({ user_id: 'u1', role: 'community' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('grants after confirm=true', async () => {
    mockFetch(200, { ok: true });
    const r = await admin_grant_role({ user_id: 'u1', role: 'staff', confirm: true }, ADMIN_ID, makeSb());
    expect(r.text).toContain('Granted');
  });
});

describe('admin_set_trust_tier', () => {
  it('requires exafy_admin, not just admin', async () => {
    const r = await admin_set_trust_tier({ vitana_id: 'v1', tier: 'id_verified' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation for exafy_admin', async () => {
    const r = await admin_set_trust_tier({ vitana_id: 'v1', tier: 'id_verified' }, EXAFY_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });
});
