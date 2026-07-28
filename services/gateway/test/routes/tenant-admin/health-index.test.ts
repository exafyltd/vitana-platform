/**
 * Tests for src/routes/tenant-admin/health-index.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/health-index
 *   GET  /         — current score + history trend (tenant_health_index_daily)
 *   GET  /current  — latest score only
 *   POST /refresh  — recompute on demand (storeTenantHealthIndex)
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
    delete: jest.fn(() => chain),
    order: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    lte: jest.fn(() => chain),
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

const mockStoreTenantHealthIndex = jest.fn();
jest.mock('../../../src/services/admin-health-index', () => ({
  storeTenantHealthIndex: (...args: any[]) => mockStoreTenantHealthIndex(...args),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_URL = 'http://localhost:54321';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../../src/routes/tenant-admin/health-index').default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/health-index', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-aaaa-1111';
const TENANT_B = 'tenant-bbbb-2222';

const tenantAdminClaims = (tenantId: string) => ({
  sub: 'user-a',
  email: 'admin-a@example.com',
  app_metadata: { active_tenant_id: tenantId, exafy_admin: false },
});

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('bad signature'));
}

const url = (tenantId: string, tail = '') =>
  `/api/v1/admin/tenants/${tenantId}/health-index${tail}`;

describe('Tenant Health Index routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockInvalidJwt();
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
    mockStoreTenantHealthIndex.mockReset();
  });

  // --- Auth denial ---

  it('GET / returns 401 without an Authorization header', async () => {
    const res = await request(app).get(url(TENANT_A));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('POST /refresh returns 403 for a non-admin member of the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'member' }, error: null });

    const res = await request(app)
      .post(url(TENANT_A, '/refresh'))
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(403);
    expect(mockStoreTenantHealthIndex).not.toHaveBeenCalled();
  });

  // --- Tenant isolation ---

  it('tenant-A admin cannot read tenant-B health index (403, no query issued)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(url(TENANT_B))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockSupabase.from).not.toHaveBeenCalledWith('tenant_health_index_daily');
  });

  it('tenant-A admin cannot trigger a refresh for tenant B (403, no recompute)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .post(url(TENANT_B, '/refresh'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(mockStoreTenantHealthIndex).not.toHaveBeenCalled();
  });

  // --- GET / (history + trend) ---

  it('GET / returns history scoped to the tenant with weekly trend summary', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    // 14 rows: last 7 all score 80, prior 7 all score 70 → weekly_delta = 10
    const rows = Array.from({ length: 14 }, (_, i) => ({
      snapshot_date: `2026-07-${String(27 - i).padStart(2, '0')}`,
      score: i < 7 ? 80 : 70,
      components: {},
      computed_at: '2026-07-27T00:00:00Z',
      source_version: 'v1',
    }));
    chainFor('tenant_health_index_daily').mockResolvedValue({ data: rows, error: null });

    const res = await request(app).get(url(TENANT_A)).set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenant_id).toBe(TENANT_A);
    expect(res.body.current).toEqual(rows[0]);
    expect(res.body.history).toHaveLength(14);
    expect(res.body.summary).toEqual({
      last7_mean: 80,
      prior7_mean: 70,
      weekly_delta: 10,
      days_of_data: 14,
    });
    const chain = chainFor('tenant_health_index_daily');
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chain.order).toHaveBeenCalledWith('snapshot_date', { ascending: false });
  });

  it('GET / clamps the days param into [7, 90]', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_health_index_daily').mockResolvedValue({ data: [], error: null });

    const res = await request(app)
      .get(url(TENANT_A, '?days=1000'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    const expectedStart = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    expect(chainFor('tenant_health_index_daily').gte).toHaveBeenCalledWith(
      'snapshot_date',
      expectedStart
    );
  });

  it('GET / returns null summary values when there is no data', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_health_index_daily').mockResolvedValue({ data: [], error: null });

    const res = await request(app).get(url(TENANT_A)).set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.current).toBeNull();
    expect(res.body.summary).toEqual({
      last7_mean: null,
      prior7_mean: null,
      weekly_delta: null,
      days_of_data: 0,
    });
  });

  it('GET / returns 500 when the history query fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_health_index_daily').mockResolvedValue({
      data: null,
      error: { message: 'query blew up' },
    });

    const res = await request(app).get(url(TENANT_A)).set('Authorization', 'Bearer t');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'query blew up' });
  });

  it('GET / returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app).get(url(TENANT_A)).set('Authorization', 'Bearer t');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET /current ---

  it('GET /current returns the latest snapshot scoped to the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const row = { snapshot_date: '2026-07-27', score: 88 };
    chainFor('tenant_health_index_daily').mockResolvedValue({ data: row, error: null });

    const res = await request(app)
      .get(url(TENANT_A, '/current'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, tenant_id: TENANT_A, current: row });
    const chain = chainFor('tenant_health_index_daily');
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chain.limit).toHaveBeenCalledWith(1);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  it('GET /current returns current: null when no snapshot exists', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_health_index_daily').mockResolvedValue({ data: null, error: null });

    const res = await request(app)
      .get(url(TENANT_A, '/current'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.current).toBeNull();
  });

  // --- POST /refresh ---

  it('POST /refresh recomputes for the caller tenant only', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockStoreTenantHealthIndex.mockResolvedValue({ score: 91, snapshot_date: '2026-07-28' });

    const res = await request(app)
      .post(url(TENANT_A, '/refresh'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      tenant_id: TENANT_A,
      score: 91,
      snapshot_date: '2026-07-28',
    });
    expect(mockStoreTenantHealthIndex).toHaveBeenCalledTimes(1);
    expect(mockStoreTenantHealthIndex).toHaveBeenCalledWith(TENANT_A);
  });

  it('POST /refresh returns 500 when the compute fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockStoreTenantHealthIndex.mockResolvedValue(null);

    const res = await request(app)
      .post(url(TENANT_A, '/refresh'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('HEALTH_INDEX_COMPUTE_FAILED');
  });
});
