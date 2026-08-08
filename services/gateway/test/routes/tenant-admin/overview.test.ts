/**
 * Tests for src/routes/tenant-admin/overview.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/overview
 *   GET /summary  — dashboard KPI blob (60s in-memory cache per tenant)
 *   GET /at-risk  — at-risk member cohort
 *   GET /activity — recent OASIS events, client-side tenant filter
 *   GET /alerts   — error/critical OASIS events (24h)
 *
 * Guarded by requireTenantAdmin: jose-verified JWT, cross-tenant 403,
 * role lookup against user_tenants via a direct @supabase/supabase-js client.
 */
import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const createChain = () => {
  const responseQueue: any[] = [];
  let defaultData: any = { data: null, error: null };

  const chain: any = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    upsert: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    order: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    lt: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: (v: any) => any) => {
      const value = responseQueue.length > 0 ? responseQueue.shift() : defaultData;
      return Promise.resolve(value).then(resolve);
    }),
    mockResolvedValue(v: any) {
      defaultData = v;
      return chain;
    },
    mockResolvedValueOnce(v: any) {
      responseQueue.push(v);
      return chain;
    },
    mockReset() {
      responseQueue.length = 0;
      defaultData = { data: null, error: null };
    },
  };

  return chain;
};

const tableChains: Record<string, ReturnType<typeof createChain>> = {};
const chainFor = (table: string) => (tableChains[table] ??= createChain());

const mockSupabase = { from: jest.fn((table: string) => chainFor(table)) };
const mockGetSupabase = jest.fn(() => mockSupabase as any);

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

jest.mock('jose');

// requireTenantAdmin's getCallerRole() uses its own @supabase/supabase-js client
const mockUserTenantsSingle = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: mockUserTenantsSingle,
          })),
        })),
      })),
    })),
  })),
}));

// require-tenant-admin reads these at module load — set BEFORE requiring the router
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_URL = 'http://localhost:54321';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../../src/routes/tenant-admin/overview').default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/overview', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const tenantAdminClaims = (tenantId: string) => ({
  sub: 'admin-a',
  email: 'admin-a@example.com',
  app_metadata: { active_tenant_id: tenantId, exafy_admin: false },
});

const EXAFY_ADMIN_CLAIMS = {
  sub: 'super-admin',
  email: 'super@exafy.io',
  app_metadata: { exafy_admin: true },
};

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
}

describe('Tenant Admin Overview Routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
    mockInvalidJwt();
  });

  // --- Auth / RBAC ---

  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).get(`/api/v1/admin/tenants/${TENANT_A}/overview/summary`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 401 for an invalid token', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/summary`)
      .set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('tenant isolation: tenant A admin cannot read tenant B overview (403, no queries)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_B}/overview/summary`)
      .set('Authorization', 'Bearer tenant-a-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    // Rejected before role lookup and before any data query
    expect(mockUserTenantsSingle).not.toHaveBeenCalled();
    expect(chainFor('user_tenants').select).not.toHaveBeenCalled();
    expect(chainFor('kb_documents').select).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is a member but not admin of the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'community' }, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/at-risk`)
      .set('Authorization', 'Bearer member-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(chainFor('user_tenants').select).not.toHaveBeenCalled();
  });

  it('exafy super-admin bypasses tenant + role checks for another tenant', async () => {
    mockVerifiedJwt(EXAFY_ADMIN_CLAIMS);
    chainFor('oasis_events').mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_B}/overview/activity`)
      .set('Authorization', 'Bearer exafy-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockUserTenantsSingle).not.toHaveBeenCalled();
  });

  it('returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/summary`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET /summary ---

  it('GET /summary aggregates KPIs and scopes every query to the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    // Promise.all order: total, signups7d, signupsPrior7d, roles
    chainFor('user_tenants')
      .mockResolvedValueOnce({ count: 42, data: null, error: null })
      .mockResolvedValueOnce({ count: 6, data: null, error: null })
      .mockResolvedValueOnce({ count: 3, data: null, error: null })
      .mockResolvedValueOnce({
        data: [{ active_role: 'admin' }, { active_role: 'community' }, { active_role: 'community' }],
        error: null,
      });
    chainFor('tenant_invitations').mockResolvedValueOnce({ count: 2, data: null, error: null });
    chainFor('kb_documents').mockResolvedValueOnce({ count: 7, data: null, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/summary`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cached).toBe(false);
    expect(res.body.kpi).toEqual({
      total_members: 42,
      new_signups_7d: 6,
      new_signups_delta_pct: 100, // (6-3)/3
      pending_invitations: 2,
      kb_documents: 7,
    });
    expect(res.body.role_distribution).toEqual({ admin: 1, community: 2 });

    // Tenant isolation: every table filtered by this tenant's id
    expect(chainFor('user_tenants').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chainFor('tenant_invitations').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chainFor('kb_documents').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    // Pending invitations excludes accepted/revoked
    expect(chainFor('tenant_invitations').is).toHaveBeenCalledWith('accepted_at', null);
    expect(chainFor('tenant_invitations').is).toHaveBeenCalledWith('revoked_at', null);
  });

  it('GET /summary serves from cache on a repeat call without re-querying', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    // Warm the cache (may already be warm from the previous test — either way ok)
    await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/summary`)
      .set('Authorization', 'Bearer token');

    chainFor('user_tenants').select.mockClear();
    chainFor('tenant_invitations').select.mockClear();
    chainFor('kb_documents').select.mockClear();

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/summary`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(chainFor('user_tenants').select).not.toHaveBeenCalled();
    expect(chainFor('tenant_invitations').select).not.toHaveBeenCalled();
    expect(chainFor('kb_documents').select).not.toHaveBeenCalled();
  });

  // --- GET /at-risk ---

  it('GET /at-risk flags stale members and only looks up this tenant\'s users', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const staleDate = new Date(Date.now() - 30 * 86400_000).toISOString();
    const freshDate = new Date().toISOString();

    chainFor('user_tenants').mockResolvedValueOnce({
      data: [
        { user_id: 'u1', active_role: 'community', created_at: staleDate },
        { user_id: 'u2', active_role: 'community', created_at: freshDate },
      ],
      error: null,
    });
    chainFor('app_users').mockResolvedValueOnce({
      data: [
        { user_id: 'u1', email: 'u1@x.io', display_name: 'U One', avatar_url: null, updated_at: staleDate },
        { user_id: 'u2', email: 'u2@x.io', display_name: 'U Two', avatar_url: null, updated_at: freshDate },
      ],
      error: null,
    });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/at-risk`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.at_risk).toHaveLength(1);
    expect(res.body.at_risk[0]).toMatchObject({ user_id: 'u1', email: 'u1@x.io', last_seen: staleDate });

    // Tenant isolation: members read for tenant A only; app_users lookup
    // restricted to exactly tenant A's member ids
    expect(chainFor('user_tenants').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chainFor('app_users').in).toHaveBeenCalledWith('user_id', ['u1', 'u2']);
  });

  it('GET /at-risk returns an empty cohort when the tenant has no members', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('user_tenants').mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/at-risk`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, at_risk: [], count: 0 });
    // Never touched app_users
    expect(chainFor('app_users').select).not.toHaveBeenCalled();
  });

  // --- GET /activity ---

  it('GET /activity filters out events tagged with another tenant\'s id', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('oasis_events').mockResolvedValueOnce({
      data: [
        { id: 'e1', metadata: { tenant_id: TENANT_A }, created_at: '2026-07-27T10:00:00Z' },
        { id: 'e2', metadata: { tenant_id: TENANT_B }, created_at: '2026-07-27T09:00:00Z' },
        { id: 'e3', metadata: {}, created_at: '2026-07-27T08:00:00Z' }, // global event
      ],
      error: null,
    });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/activity`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    const ids = res.body.events.map((e: any) => e.id);
    expect(ids).toEqual(['e1', 'e3']); // tenant B's event never leaks
    expect(chainFor('oasis_events').limit).toHaveBeenCalledWith(50); // default limit
  });

  it('GET /activity caps limit at 200', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('oasis_events').mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/activity?limit=9999`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(chainFor('oasis_events').limit).toHaveBeenCalledWith(200);
  });

  // --- GET /alerts ---

  it('GET /alerts returns error/critical events from the last 24h', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const alerts = [{ id: 'a1', status: 'error' }, { id: 'a2', status: 'critical' }];
    chainFor('oasis_events').mockResolvedValueOnce({ data: alerts, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/alerts`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.alerts).toEqual(alerts);
    expect(chainFor('oasis_events').in).toHaveBeenCalledWith('status', ['error', 'critical']);
    expect(chainFor('oasis_events').gte).toHaveBeenCalledWith('created_at', expect.any(String));
  });

  it('GET /alerts returns 500 when the query fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('oasis_events').mockResolvedValueOnce({ data: null, error: { message: 'oasis query failed' } });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/overview/alerts`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('oasis query failed');
  });
});
