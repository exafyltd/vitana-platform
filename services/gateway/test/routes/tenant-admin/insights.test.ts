/**
 * Tests for src/routes/tenant-admin/insights.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/insights
 *   GET  /             — list (default open+pending_approval, filters, limit clamp)
 *   GET  /:id          — single insight
 *   POST /:id/approve|reject|dismiss — resolve
 *   POST /:id/snooze   — snooze with hour clamp
 *
 * Guarded by requireTenantAdmin; emits OASIS events on resolution (mocked).
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

jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
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
const router = require('../../../src/routes/tenant-admin/insights').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { emitOasisEvent } = require('../../../src/services/oasis-event-service');

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/insights', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INSIGHT_ID = '99999999-9999-4999-8999-999999999999';

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

describe('Tenant Admin Insights Routes', () => {
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
    const res = await request(app).get(`/api/v1/admin/tenants/${TENANT_A}/insights`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('tenant isolation: tenant A admin cannot approve a tenant B insight (403, no mutation)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_B}/insights/${INSIGHT_ID}/approve`)
      .set('Authorization', 'Bearer tenant-a-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(chainFor('admin_insights').update).not.toHaveBeenCalled();
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });

  it('returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/insights`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET / (list) ---

  it('GET / defaults to open+pending_approval, scopes to tenant, and re-sorts by urgency', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    // DB returns alphabetical severity order — route must re-sort urgent-first
    chainFor('admin_insights').mockResolvedValueOnce({
      data: [
        { id: 'i1', severity: 'info', created_at: '2026-07-27T10:00:00Z' },
        { id: 'i2', severity: 'urgent', created_at: '2026-07-27T09:00:00Z' },
        { id: 'i3', severity: 'warning', created_at: '2026-07-27T08:00:00Z' },
      ],
      error: null,
    });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/insights`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.insights.map((i: any) => i.id)).toEqual(['i2', 'i3', 'i1']);

    const chain = chainFor('admin_insights');
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A); // tenant isolation
    expect(chain.in).toHaveBeenCalledWith('status', ['open', 'pending_approval']);
    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it('GET /?status=all applies no status filter; explicit status uses eq; limit clamps to 200', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('admin_insights');

    chain.mockResolvedValueOnce({ data: [], error: null });
    await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/insights?status=all&limit=9999`)
      .set('Authorization', 'Bearer token');
    expect(chain.in).not.toHaveBeenCalled();
    expect(chain.eq).not.toHaveBeenCalledWith('status', expect.anything());
    expect(chain.limit).toHaveBeenCalledWith(200);

    chain.mockReset();
    chain.mockResolvedValueOnce({ data: [], error: null });
    await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/insights?status=snoozed&domain=system_health&severity=urgent`)
      .set('Authorization', 'Bearer token');
    expect(chain.eq).toHaveBeenCalledWith('status', 'snoozed');
    expect(chain.eq).toHaveBeenCalledWith('domain', 'system_health');
    expect(chain.eq).toHaveBeenCalledWith('severity', 'urgent');
  });

  it('GET / returns 500 with the DB error message on failure', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('admin_insights').mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/insights`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });

  // --- GET /:id ---

  it('GET /:id fetches with both id and tenant filters; 404 when not in this tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('admin_insights');

    // Simulates an insight that exists but belongs to another tenant:
    // the tenant-scoped maybeSingle comes back empty → 404, data never leaks
    chain.mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/insights/${INSIGHT_ID}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chain.eq).toHaveBeenCalledWith('id', INSIGHT_ID);
  });

  it('GET /:id returns the insight when found', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const insight = { id: INSIGHT_ID, tenant_id: TENANT_A, severity: 'warning', title: 'Slow queries' };
    chainFor('admin_insights').mockResolvedValueOnce({ data: insight, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/insights/${INSIGHT_ID}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.insight).toEqual(insight);
  });

  // --- POST /:id/approve ---

  it('POST /:id/approve updates status, stamps the actor, scopes to tenant, and emits an event', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const resolved = {
      id: INSIGHT_ID,
      title: 'Slow queries',
      scanner: 'system_health',
      natural_key: 'nk-1',
      severity: 'warning',
      status: 'approved',
    };
    const chain = chainFor('admin_insights');
    chain.mockResolvedValueOnce({ data: resolved, error: null });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/insights/${INSIGHT_ID}/approve`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.insight).toEqual(resolved);

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'approved',
        resolved_by: 'admin-a',
        resolved_via: 'console',
        resolved_at: expect.any(String),
      })
    );
    // Tenant isolation on the mutation itself
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chain.eq).toHaveBeenCalledWith('id', INSIGHT_ID);

    expect(emitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin.insight.approved',
        payload: expect.objectContaining({ insight_id: INSIGHT_ID, tenant_id: TENANT_A }),
      })
    );
  });

  it('POST /:id/reject returns 500 (and no event) when the update fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('admin_insights').mockResolvedValueOnce({ data: null, error: { message: 'row locked' } });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/insights/${INSIGHT_ID}/reject`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('row locked');
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });

  it('POST /:id/dismiss returns 404 when the row is not found in this tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('admin_insights').mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/insights/${INSIGHT_ID}/dismiss`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });

  // --- POST /:id/snooze ---

  it('POST /:id/snooze snoozes for the requested hours and scopes the update to the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const snoozed = { id: INSIGHT_ID, title: 'Slow queries', status: 'snoozed' };
    const chain = chainFor('admin_insights');
    chain.mockResolvedValueOnce({ data: snoozed, error: null });

    const before = Date.now();
    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/insights/${INSIGHT_ID}/snooze`)
      .set('Authorization', 'Bearer token')
      .send({ hours: 5 });

    expect(res.status).toBe(200);
    expect(res.body.insight).toEqual(snoozed);

    const updateArg = (chain.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.status).toBe('snoozed');
    expect(updateArg.resolved_by).toBe('admin-a');
    const until = new Date(updateArg.snoozed_until).getTime();
    // ~5 hours out (2s tolerance)
    expect(Math.abs(until - (before + 5 * 3600_000))).toBeLessThan(2000);
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  it('POST /:id/snooze clamps hours to 30 days max', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('admin_insights');
    chain.mockResolvedValueOnce({ data: { id: INSIGHT_ID, title: 't' }, error: null });

    const before = Date.now();
    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/insights/${INSIGHT_ID}/snooze`)
      .set('Authorization', 'Bearer token')
      .send({ hours: 100000 });

    expect(res.status).toBe(200);
    const updateArg = (chain.update as jest.Mock).mock.calls[0][0];
    const until = new Date(updateArg.snoozed_until).getTime();
    expect(Math.abs(until - (before + 720 * 3600_000))).toBeLessThan(2000); // 24*30 h
  });
});
