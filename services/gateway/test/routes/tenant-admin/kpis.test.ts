/**
 * Tests for src/routes/tenant-admin/kpis.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/kpis
 *   GET  /         — current snapshot + 7-day history
 *   GET  /current  — current snapshot only
 *   GET  /history  — ?days=N (clamped 1..90, default 7)
 *   POST /refresh  — force recompute via admin-awareness-worker (mocked)
 *
 * Guarded by requireTenantAdmin.
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

const mockSupabase = { from: jest.fn((table: string) => chainFor(table)) };
const mockGetSupabase = jest.fn(() => mockSupabase as any);

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

jest.mock('jose');

jest.mock('../../../src/services/admin-awareness-worker', () => ({
  computeAndStoreForTenant: jest.fn().mockResolvedValue(undefined),
}));

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

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_URL = 'http://localhost:54321';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../../src/routes/tenant-admin/kpis').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeAndStoreForTenant } = require('../../../src/services/admin-awareness-worker');

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/kpis', router);

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

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
}

describe('Tenant Admin KPIs Routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
    (computeAndStoreForTenant as jest.Mock).mockResolvedValue(undefined);
    mockInvalidJwt();
  });

  // --- Auth / RBAC ---

  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).get(`/api/v1/admin/tenants/${TENANT_A}/kpis`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('tenant isolation: tenant A admin cannot trigger a refresh for tenant B', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_B}/kpis/refresh`)
      .set('Authorization', 'Bearer tenant-a-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(computeAndStoreForTenant).not.toHaveBeenCalled();
  });

  it('tenant isolation: tenant A admin cannot read tenant B KPIs', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_B}/kpis/current`)
      .set('Authorization', 'Bearer tenant-a-token');

    expect(res.status).toBe(403);
    expect(chainFor('tenant_kpi_current').select).not.toHaveBeenCalled();
  });

  it('returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kpis`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET / ---

  it('GET / returns current + history, both scoped to the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const current = {
      tenant_id: TENANT_A,
      generated_at: '2026-07-28T00:00:00Z',
      kpi: { members: 10 },
      computation_duration_ms: 12,
      source_version: 'v1',
    };
    const history = [
      { snapshot_date: '2026-07-27', kpi: { members: 9 }, computed_at: '2026-07-27T00:05:00Z' },
    ];
    chainFor('tenant_kpi_current').mockResolvedValueOnce({ data: current, error: null });
    chainFor('tenant_kpi_daily').mockResolvedValueOnce({ data: history, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kpis`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenant_id).toBe(TENANT_A);
    expect(res.body.current).toEqual(current);
    expect(res.body.history).toEqual(history);

    // Tenant isolation on both reads
    expect(chainFor('tenant_kpi_current').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chainFor('tenant_kpi_daily').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  it('GET / returns 500 when the current-snapshot query fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_kpi_current').mockResolvedValueOnce({ data: null, error: { message: 'kpi read failed' } });
    chainFor('tenant_kpi_daily').mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kpis`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('kpi read failed');
  });

  it('GET / tolerates a history failure and still returns current with empty history', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const current = { tenant_id: TENANT_A, kpi: { members: 3 } };
    chainFor('tenant_kpi_current').mockResolvedValueOnce({ data: current, error: null });
    chainFor('tenant_kpi_daily').mockResolvedValueOnce({ data: null, error: { message: 'history down' } });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kpis`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.current).toEqual(current);
    expect(res.body.history).toEqual([]);
  });

  // --- GET /current ---

  it('GET /current returns null when no snapshot exists yet', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_kpi_current').mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kpis/current`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, current: null });
    expect(chainFor('tenant_kpi_current').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  // --- GET /history ---

  it('GET /history clamps days to 90 and filters by tenant + snapshot window', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('tenant_kpi_daily');
    chain.mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kpis/history?days=500`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(90);
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chain.gte).toHaveBeenCalledWith('snapshot_date', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('GET /history falls back to 7 days for a non-numeric days param', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_kpi_daily').mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kpis/history?days=abc`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
  });

  it('GET /history returns 500 on query failure', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_kpi_daily').mockResolvedValueOnce({ data: null, error: { message: 'daily read failed' } });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kpis/history`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('daily read failed');
  });

  // --- POST /refresh ---

  it('POST /refresh recomputes exactly this tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/kpis/refresh`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenant_id).toBe(TENANT_A);
    expect(typeof res.body.duration_ms).toBe('number');
    expect(computeAndStoreForTenant).toHaveBeenCalledTimes(1);
    expect(computeAndStoreForTenant).toHaveBeenCalledWith(TENANT_A);
  });

  it('POST /refresh returns 500 with the worker error message on failure', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    (computeAndStoreForTenant as jest.Mock).mockRejectedValueOnce(new Error('compute exploded'));

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/kpis/refresh`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('compute exploded');
  });
});
