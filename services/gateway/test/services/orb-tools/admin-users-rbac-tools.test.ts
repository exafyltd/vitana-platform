/**
 * Tests for src/services/orb-tools/admin-users-rbac-tools.ts (Phase 2 —
 * tenancy & RBAC).
 *
 * The handlers are a thin dispatch layer over the gateway's admin HTTP
 * routes, reached through gatewayApiCall() from developer-tools. What we
 * verify here is the RBAC contract of the layer itself:
 *   - adminGate refuses unauthenticated / non-admin identities
 *   - no gateway call is ever made on a refusal path
 *   - the caller's own JWT (never a fabricated credential) is forwarded
 *   - two-step confirm for mutations (grant/revoke/trust-tier)
 *   - operator-only escalation for admin_set_trust_tier (exafy_admin)
 *   - the community floor role cannot be revoked
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const mockGatewayApiCall = jest.fn();

jest.mock('../../../src/services/orb-tools/developer-tools', () => ({
  gatewayApiCall: (...args: unknown[]) => mockGatewayApiCall(...args),
  // Real-shaped helpers so limit clamping / age formatting stay deterministic
  clampLimit: (raw: unknown, def: number, max: number) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return def;
    return Math.max(1, Math.min(max, Math.round(n)));
  },
  relAge: (iso: string | null | undefined) => (iso ? `${iso} (rel)` : 'unknown time'),
}));

import {
  adminGate,
  authHeaders,
  NO_ADMIN_SESSION,
  admin_lookup_user,
  admin_list_users,
  admin_get_user_detail,
  admin_roles_summary,
  admin_grant_role,
  admin_revoke_role,
  admin_set_trust_tier,
  admin_get_at_risk_members,
  ADMIN_USERS_RBAC_TOOL_HANDLERS,
  ADMIN_USERS_RBAC_TOOL_DECLARATIONS,
} from '../../../src/services/orb-tools/admin-users-rbac-tools';
import type { OrbToolIdentity } from '../../../src/services/orb-tools-shared';

const sb = {} as SupabaseClient;

function identity(overrides: Partial<OrbToolIdentity> = {}): OrbToolIdentity {
  return {
    user_id: 'admin-1',
    tenant_id: 'tenant-1',
    role: 'admin',
    user_jwt: 'jwt-abc',
    ...overrides,
  };
}

function apiOk(body: Record<string, unknown>, status = 200) {
  mockGatewayApiCall.mockResolvedValueOnce({ ok: true, status, body });
}

function apiFail(status: number, body: Record<string, unknown> = {}) {
  mockGatewayApiCall.mockResolvedValueOnce({ ok: false, status, body });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// adminGate + authHeaders
// ---------------------------------------------------------------------------

describe('adminGate', () => {
  it('refuses an unauthenticated identity', () => {
    const denied = adminGate(identity({ user_id: '' as unknown as string }));
    expect(denied).toEqual({ ok: false, error: 'admin tools require an authenticated user.' });
  });

  it('refuses non-admin roles', () => {
    for (const role of ['community', 'developer', 'professional', 'staff', null]) {
      const denied = adminGate(identity({ role }));
      expect(denied).toEqual({ ok: false, error: 'admin_role_required' });
    }
  });

  it('admits admin and exafy_admin (case-insensitively)', () => {
    expect(adminGate(identity({ role: 'admin' }))).toBeNull();
    expect(adminGate(identity({ role: 'Admin' }))).toBeNull();
    expect(adminGate(identity({ role: 'exafy_admin' }))).toBeNull();
  });
});

describe('authHeaders', () => {
  it('forwards the caller JWT as Bearer, and nothing when absent', () => {
    expect(authHeaders(identity())).toEqual({ Authorization: 'Bearer jwt-abc' });
    expect(authHeaders(identity({ user_jwt: null }))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Refusal paths shared by all handlers
// ---------------------------------------------------------------------------

describe('all handlers refuse without hitting the gateway', () => {
  const handlerNames = Object.keys(ADMIN_USERS_RBAC_TOOL_HANDLERS);

  it('exports the full Wave 3 B1 surface with matching declarations', () => {
    expect(handlerNames.sort()).toEqual([
      'admin_get_at_risk_members',
      'admin_get_user_detail',
      'admin_grant_role',
      'admin_list_users',
      'admin_lookup_user',
      'admin_revoke_role',
      'admin_roles_summary',
      'admin_set_trust_tier',
    ]);
    expect(ADMIN_USERS_RBAC_TOOL_DECLARATIONS.map((d) => d.name).sort()).toEqual(handlerNames.sort());
  });

  it.each(handlerNames)('%s denies a community-role caller', async (name) => {
    const result = await ADMIN_USERS_RBAC_TOOL_HANDLERS[name](
      { query: 'x', user_id: 'u', role: 'staff', vitana_id: 'v', tier: 'id_verified', confirm: true },
      identity({ role: 'community' }),
      sb,
    );
    expect(result).toEqual({ ok: false, error: 'admin_role_required' });
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });

  it.each(handlerNames)('%s denies an unauthenticated caller', async (name) => {
    const result = await ADMIN_USERS_RBAC_TOOL_HANDLERS[name](
      {},
      identity({ user_id: '' as unknown as string, role: 'admin' }),
      sb,
    );
    expect(result).toEqual({ ok: false, error: 'admin tools require an authenticated user.' });
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });

  it('an admin without a session JWT gets NO_ADMIN_SESSION instead of a fabricated credential', async () => {
    const result = await admin_lookup_user({ query: 'ana' }, identity({ user_jwt: null }), sb);
    expect(result).toBe(NO_ADMIN_SESSION);
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

describe('admin_lookup_user', () => {
  it('requires a query', async () => {
    const result = await admin_lookup_user({}, identity(), sb);
    expect(result).toEqual({ ok: false, error: 'admin_lookup_user requires a query (name, email, or vitana_id).' });
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });

  it('calls the lookup route with the caller JWT and encodes the token', async () => {
    apiOk({ ok: true, candidates: [{ email: 'a@x.io' }] });
    const result = await admin_lookup_user({ query: 'ana m', limit: 5 }, identity(), sb);
    expect(mockGatewayApiCall).toHaveBeenCalledWith(
      '/api/v1/admin/users/lookup?token=ana%20m&limit=5',
      { headers: { Authorization: 'Bearer jwt-abc' } },
    );
    expect(result).toMatchObject({ ok: true, result: { candidates: [{ email: 'a@x.io' }] } });
  });

  it('reports zero matches as ok with an empty list', async () => {
    apiOk({ ok: true, candidates: [] });
    const result = await admin_lookup_user({ query: 'ghost' }, identity(), sb);
    expect(result).toMatchObject({ ok: true, result: { candidates: [] }, text: 'No users matched "ghost".' });
  });

  it('propagates gateway failure as an error result', async () => {
    apiFail(403, { error: 'FORBIDDEN' });
    const result = await admin_lookup_user({ query: 'ana' }, identity(), sb);
    expect(result).toEqual({ ok: false, error: 'admin_lookup_user failed (403): FORBIDDEN' });
  });
});

describe('admin_list_users', () => {
  it('builds the querystring from query/role/limit', async () => {
    apiOk({ ok: true, users: [{ email: 'a@x.io', active_role: 'staff' }] });
    const result = await admin_list_users({ query: 'smith', role: 'staff', limit: 3 }, identity(), sb);
    expect(mockGatewayApiCall).toHaveBeenCalledWith(
      '/api/v1/admin/users?limit=3&query=smith&role=staff',
      { headers: { Authorization: 'Bearer jwt-abc' } },
    );
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('a@x.io (staff)') });
  });
});

describe('admin_get_user_detail', () => {
  it('requires user_id', async () => {
    const result = await admin_get_user_detail({}, identity(), sb);
    expect(result).toEqual({ ok: false, error: 'admin_get_user_detail requires user_id.' });
  });

  it('treats 404 as a clean not-found (ok:true, found:false)', async () => {
    apiFail(404, { error: 'NOT_FOUND' });
    const result = await admin_get_user_detail({ user_id: 'u-404' }, identity(), sb);
    expect(result).toMatchObject({ ok: true, result: { found: false }, text: 'No user found with id u-404.' });
  });

  it('non-404 failures are errors', async () => {
    apiFail(500, { error: 'DB_DOWN' });
    const result = await admin_get_user_detail({ user_id: 'u-1' }, identity(), sb);
    expect(result).toEqual({ ok: false, error: 'admin_get_user_detail failed (500): DB_DOWN' });
  });
});

describe('admin_roles_summary', () => {
  it('summarizes role distribution', async () => {
    apiOk({ ok: true, roles: [{ role: 'admin', user_count: 2 }, { role: 'community', user_count: 40 }] });
    const result = await admin_roles_summary({}, identity(), sb);
    expect(result).toMatchObject({ ok: true, text: 'Role distribution: admin: 2, community: 40.' });
  });
});

// ---------------------------------------------------------------------------
// Grants / revocations — two-step confirm
// ---------------------------------------------------------------------------

describe('admin_grant_role', () => {
  it('requires user_id and role', async () => {
    const result = await admin_grant_role({ user_id: 'u-1' }, identity(), sb);
    expect(result).toEqual({ ok: false, error: 'admin_grant_role requires user_id and role.' });
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });

  it('without confirm=true it only ASKS — no mutation is dispatched', async () => {
    const result = await admin_grant_role({ user_id: 'u-1', role: 'staff' }, identity(), sb);
    expect(result).toMatchObject({
      ok: true,
      result: { requires_confirmation: true, user_id: 'u-1', role: 'staff' },
    });
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });

  it('with confirm=true it POSTs the grant with the identity tenant as default', async () => {
    apiOk({ ok: true });
    const result = await admin_grant_role({ user_id: 'u-1', role: 'staff', confirm: true }, identity(), sb);
    expect(mockGatewayApiCall).toHaveBeenCalledWith('/api/v1/roles/grant', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: { user_id: 'u-1', role: 'staff', tenant_id: 'tenant-1' },
    });
    expect(result).toMatchObject({ ok: true, result: { granted: true } });
  });

  it('an explicit args.tenant_id overrides the identity tenant', async () => {
    apiOk({ ok: true });
    await admin_grant_role({ user_id: 'u-1', role: 'staff', tenant_id: 'tenant-9', confirm: true }, identity(), sb);
    expect(mockGatewayApiCall).toHaveBeenCalledWith('/api/v1/roles/grant', expect.objectContaining({
      body: expect.objectContaining({ tenant_id: 'tenant-9' }),
    }));
  });

  it('a backend refusal surfaces as granted:false, not a silent success', async () => {
    apiFail(403, { error: 'CANNOT_MANAGE_ROLE' });
    const result = await admin_grant_role({ user_id: 'u-1', role: 'admin', confirm: true }, identity(), sb);
    expect(result).toMatchObject({
      ok: true,
      result: { granted: false, status: 403 },
      text: expect.stringContaining('CANNOT_MANAGE_ROLE'),
    });
  });
});

describe('admin_revoke_role', () => {
  it('refuses to revoke the community floor role, even with confirm', async () => {
    const result = await admin_revoke_role(
      { user_id: 'u-1', role: 'community', confirm: true },
      identity(),
      sb,
    );
    expect(result).toEqual({ ok: false, error: 'The community role cannot be revoked — it is the floor role.' });
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });

  it('without confirm=true it only ASKS', async () => {
    const result = await admin_revoke_role({ user_id: 'u-1', role: 'staff' }, identity(), sb);
    expect(result).toMatchObject({ ok: true, result: { requires_confirmation: true } });
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });

  it('with confirm=true it POSTs the revoke', async () => {
    apiOk({ ok: true });
    const result = await admin_revoke_role({ user_id: 'u-1', role: 'staff', confirm: true }, identity(), sb);
    expect(mockGatewayApiCall).toHaveBeenCalledWith('/api/v1/roles/revoke', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: { user_id: 'u-1', role: 'staff', tenant_id: 'tenant-1' },
    });
    expect(result).toMatchObject({ ok: true, result: { revoked: true } });
  });
});

// ---------------------------------------------------------------------------
// Trust tier — exafy_admin (operator) only
// ---------------------------------------------------------------------------

describe('admin_set_trust_tier', () => {
  it('a plain admin is refused — this tool is operator-only', async () => {
    const result = await admin_set_trust_tier(
      { vitana_id: 'VIT-1', tier: 'id_verified', confirm: true },
      identity({ role: 'admin' }),
      sb,
    );
    expect(result).toEqual({ ok: false, error: 'admin_set_trust_tier requires an exafy_admin session (operator-only).' });
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });

  it('rejects an invalid tier', async () => {
    const result = await admin_set_trust_tier(
      { vitana_id: 'VIT-1', tier: 'super_verified' },
      identity({ role: 'exafy_admin' }),
      sb,
    );
    expect(result).toEqual({
      ok: false,
      error: 'admin_set_trust_tier requires vitana_id and tier (one of unverified, community_verified, pro_verified, id_verified).',
    });
  });

  it('two-step confirm before mutating', async () => {
    const result = await admin_set_trust_tier(
      { vitana_id: 'VIT-1', tier: 'pro_verified' },
      identity({ role: 'exafy_admin' }),
      sb,
    );
    expect(result).toMatchObject({ ok: true, result: { requires_confirmation: true, vitana_id: 'VIT-1', tier: 'pro_verified' } });
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });

  it('confirmed exafy_admin call POSTs the trust-tier change', async () => {
    apiOk({ ok: true });
    const result = await admin_set_trust_tier(
      { vitana_id: 'VIT-1', tier: 'pro_verified', reason: 'verified docs', confirm: true },
      identity({ role: 'exafy_admin' }),
      sb,
    );
    expect(mockGatewayApiCall).toHaveBeenCalledWith('/api/v1/admin/users/VIT-1/trust-tier', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: { tier: 'pro_verified', reason: 'verified docs' },
    });
    expect(result).toMatchObject({ ok: true, result: { updated: true } });
  });
});

// ---------------------------------------------------------------------------
// At-risk members — tenant context required
// ---------------------------------------------------------------------------

describe('admin_get_at_risk_members', () => {
  it('requires a tenant context', async () => {
    const result = await admin_get_at_risk_members({}, identity({ tenant_id: null }), sb);
    expect(result).toEqual({ ok: false, error: 'admin_get_at_risk_members requires a tenant context.' });
    expect(mockGatewayApiCall).not.toHaveBeenCalled();
  });

  it("queries the caller's OWN tenant overview endpoint", async () => {
    apiOk({ ok: true, at_risk: [{ email: 'quiet@x.io', last_seen: '2026-07-01' }] });
    const result = await admin_get_at_risk_members({}, identity({ tenant_id: 'tenant-1' }), sb);
    expect(mockGatewayApiCall).toHaveBeenCalledWith(
      '/api/v1/admin/tenants/tenant-1/overview/at-risk',
      { headers: { Authorization: 'Bearer jwt-abc' } },
    );
    expect(result).toMatchObject({ ok: true, result: { at_risk: [{ email: 'quiet@x.io', last_seen: '2026-07-01' }] } });
  });
});
