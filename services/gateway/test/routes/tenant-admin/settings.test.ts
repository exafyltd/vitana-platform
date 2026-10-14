/**
 * Tests for src/routes/tenant-admin/settings.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/settings
 *   GET / — full settings object (defaults when no row)
 *   PUT / — partial-merge update (billing is read-only); VTID-05150:
 *           feature_flags merged per key in SQL, `jev` governed (exafy_admin only)
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

const mockRpc = jest.fn();
const mockSupabase = { from: jest.fn((table: string) => chainFor(table)), rpc: mockRpc };
const mockGetSupabase = jest.fn(() => mockSupabase as any);

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

jest.mock('jose');

const mockUserTenantsSingle = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: mockUserTenantsSingle,
            // VTID-05147: requireTenantAdmin also reads the permitted roles
            // (user_permitted_roles awaited here, memberships one .eq() deeper);
            // the test caller holds a granted admin role.
            eq: jest.fn(() => Promise.resolve({ data: [], error: null })),
            then: (resolve: any, reject: any) =>
              Promise.resolve({ data: [{ role: 'admin' }], error: null }).then(resolve, reject),
          })),
        })),
      })),
    })),
  })),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_URL = 'http://localhost:54321';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../../src/routes/tenant-admin/settings').default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/settings', router);
// Prod also supports a no-:tenantId mount, where the middleware falls back to
// the caller's JWT tenant. Mirror that to test the fallback + TENANT_REQUIRED.
app.use('/api/v1/admin/settings', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const tenantAdminClaims = (tenantId: string | null) => ({
  sub: 'admin-a',
  email: 'admin-a@example.com',
  app_metadata: { active_tenant_id: tenantId, exafy_admin: false },
});

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
}

describe('Tenant Admin Settings Routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
    mockInvalidJwt();
    mockRpc.mockReset();
  });

  // --- Auth / RBAC ---

  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).get(`/api/v1/admin/tenants/${TENANT_A}/settings`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('tenant isolation: tenant A admin cannot update tenant B settings (403, no write)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_B}/settings`)
      .set('Authorization', 'Bearer tenant-a-token')
      .send({ branding: { color: '#f00' } });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(chainFor('tenant_settings').upsert).not.toHaveBeenCalled();
  });

  it('returns 403 when caller lacks the admin role in their own tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'professional' }, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(chainFor('tenant_settings').select).not.toHaveBeenCalled();
  });

  it('returns 400 TENANT_REQUIRED when neither route param nor JWT carry a tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(null));

    const res = await request(app)
      .get('/api/v1/admin/settings')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TENANT_REQUIRED');
  });

  it('falls back to the JWT tenant on the no-param mount and scopes the query to it', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_settings').mockResolvedValueOnce({
      data: { tenant_id: TENANT_A, profile: { name: 'A' } },
      error: null,
    });

    const res = await request(app)
      .get('/api/v1/admin/settings')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.settings.tenant_id).toBe(TENANT_A);
    expect(chainFor('tenant_settings').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  it('returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET / ---

  it('GET / returns the stored settings row scoped to the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const row = { tenant_id: TENANT_A, profile: { name: 'Acme' }, branding: { color: '#0f0' } };
    chainFor('tenant_settings').mockResolvedValueOnce({ data: row, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, settings: row });
    expect(chainFor('tenant_settings').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  it('GET / returns default empty sections when no row exists (PGRST116)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_settings').mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST116', message: 'No rows found' },
    });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      tenant_id: TENANT_A,
      profile: {},
      branding: {},
      feature_flags: {},
      integrations: {},
      domains: {},
      billing: {},
    });
  });

  it('GET / returns 500 for non-PGRST116 query errors', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_settings').mockResolvedValueOnce({
      data: null,
      error: { code: '42P01', message: 'relation does not exist' },
    });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('relation does not exist');
  });

  // --- PUT / ---

  it('PUT / upserts only the provided sections, stamps the actor, never accepts billing, and merges feature_flags via the SQL merge', async () => {
    // VTID-05150 contract change: feature_flags no longer rides the wholesale
    // upsert; it goes through tenant_settings_merge_feature_flags (per-key merge).
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const saved = { tenant_id: TENANT_A, profile: { name: 'New' }, branding: {} };
    chainFor('tenant_settings').mockResolvedValueOnce({ data: saved, error: null });
    const merged = { ...saved, feature_flags: { orb: true, jev: { monthly_budget_usd: 10 } } };
    mockRpc.mockResolvedValueOnce({ data: merged, error: null });

    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token')
      .send({
        profile: { name: 'New' },
        feature_flags: { orb: true },
        billing: { plan: 'enterprise-free-hack' }, // must be ignored
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, settings: merged });

    const upsertMock = chainFor('tenant_settings').upsert as jest.Mock;
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [payload, options] = upsertMock.mock.calls[0];
    expect(payload).toMatchObject({
      tenant_id: TENANT_A, // row is keyed to the caller's tenant
      profile: { name: 'New' },
      updated_by: 'admin-a',
    });
    expect(payload.billing).toBeUndefined(); // billing is read-only
    expect(payload.branding).toBeUndefined(); // omitted section not touched
    expect(payload.feature_flags).toBeUndefined(); // merged in SQL, never replaced wholesale
    expect(options).toEqual({ onConflict: 'tenant_id' });
    expect(mockRpc).toHaveBeenCalledWith('tenant_settings_merge_feature_flags', {
      p_tenant_id: TENANT_A,
      p_flags: { orb: true },
      p_allow_governed: false,
      p_updated_by: 'admin-a',
    });
  });

  it('VTID-05150: a tenant admin cannot change the governed jev key (merge keeps it; response lists it as ignored)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockRpc.mockResolvedValueOnce({ data: { tenant_id: TENANT_A, feature_flags: { jev: { monthly_budget_usd: 10 } } }, error: null });

    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token')
      .send({ feature_flags: { jev: { enabled: true, monthly_budget_usd: 9999 } } });

    expect(res.status).toBe(200);
    expect(res.body.ignored_keys).toEqual(['jev']);
    expect(mockRpc.mock.calls[0][1].p_allow_governed).toBe(false);
    // flags-only PUT: no wholesale upsert at all
    expect(chainFor('tenant_settings').upsert).not.toHaveBeenCalled();
  });

  it('VTID-05150: an exafy_admin may change jev', async () => {
    mockVerifiedJwt({ sub: 'exafy-1', email: 'ops@exafy.io', app_metadata: { active_tenant_id: TENANT_A, exafy_admin: true } });
    mockRpc.mockResolvedValueOnce({ data: { tenant_id: TENANT_A, feature_flags: { jev: { monthly_budget_usd: 20 } } }, error: null });

    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token')
      .send({ feature_flags: { jev: { enabled: true, planes: ['internal', 'system_autopilot', 'member'], monthly_budget_usd: 20 } } });

    expect(res.status).toBe(200);
    expect(res.body.ignored_keys).toBeUndefined();
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_allow_governed: true, p_updated_by: 'exafy-1' });
  });

  it.each([
    ['a budget above the provisioning bound', { enabled: true, planes: ['member'], monthly_budget_usd: 999999 }],
    ['a negative budget', { enabled: true, planes: ['member'], monthly_budget_usd: -1 }],
    ['an unknown plane', { enabled: true, planes: ['everyone'], monthly_budget_usd: 20 }],
    ['a partial flag (planes missing)', { enabled: true, monthly_budget_usd: 20 }],
    ['an extra key', { enabled: true, planes: ['member'], monthly_budget_usd: 20, cap_override: true }],
    ['a non-object', 'on'],
  ])('VTID-05150: an exafy_admin jev update with %s → 400 INVALID_JEV_FLAG, nothing written', async (_label, jev) => {
    mockVerifiedJwt({ sub: 'exafy-1', email: 'ops@exafy.io', app_metadata: { active_tenant_id: TENANT_A, exafy_admin: true } });

    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token')
      .send({ profile: { name: 'x' }, feature_flags: { jev } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_JEV_FLAG');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(chainFor('tenant_settings').upsert).not.toHaveBeenCalled();
  });

  it('VTID-05150: before the migration (merge function missing) the gateway merges with the same jev guard', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    chainFor('tenant_settings').mockResolvedValueOnce({
      data: { tenant_id: TENANT_A, feature_flags: { jev: { monthly_budget_usd: 10 }, enable_autopilot: true } },
      error: null,
    });
    chainFor('tenant_settings').mockResolvedValueOnce({ data: { tenant_id: TENANT_A }, error: null });

    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token')
      .send({ feature_flags: { jev: { monthly_budget_usd: 9999 }, orb: true } });

    expect(res.status).toBe(200);
    const [payload] = (chainFor('tenant_settings').upsert as jest.Mock).mock.calls[0];
    expect(payload.feature_flags).toEqual({ jev: { monthly_budget_usd: 10 }, enable_autopilot: true, orb: true });
  });

  it('VTID-05150: feature_flags must be an object → 400', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token')
      .send({ feature_flags: ['jev'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_FEATURE_FLAGS');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('VTID-05150: a merge error → 500', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'merge failed' } });
    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token')
      .send({ feature_flags: { orb: true } });
    expect(res.status).toBe(500);
  });

  it('PUT / returns 500 when the upsert fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_settings').mockResolvedValueOnce({ data: null, error: { message: 'upsert failed' } });

    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_A}/settings`)
      .set('Authorization', 'Bearer token')
      .send({ profile: { name: 'X' } });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('upsert failed');
  });
});
