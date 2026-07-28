/**
 * Tests for src/routes/tenant-admin/audit-log.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/audit
 *   GET /actions — admin action audit trail (tenant_admin_audit_log)
 *   GET /access  — access log (oasis_events auth topics)
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

// Per-table thenable query-chain mock for the getSupabase() client
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

// requireTenantAdmin's getCallerRole() uses a direct @supabase/supabase-js
// client (not getSupabase) to read user_tenants.active_role.
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

// The middleware module reads SUPABASE_SERVICE_ROLE_KEY at load time —
// set it BEFORE requiring the router (imports above don't pull it in).
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_URL = 'http://localhost:54321';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../../src/routes/tenant-admin/audit-log').default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/audit', router);

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

const EXAFY_ADMIN_CLAIMS = {
  sub: 'super-admin',
  email: 'super@exafy.io',
  app_metadata: { exafy_admin: true },
};

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('bad signature'));
}

const auditUrl = (tenantId: string, tail: string) =>
  `/api/v1/admin/tenants/${tenantId}/audit${tail}`;

describe('Tenant Admin Audit Log routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockInvalidJwt();
    // Default: caller is admin in their own tenant
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
  });

  // --- Auth denial ---

  it('GET /actions returns 401 without an Authorization header', async () => {
    const res = await request(app).get(auditUrl(TENANT_A, '/actions'));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('GET /actions returns 401 for an invalid token', async () => {
    mockInvalidJwt();
    const res = await request(app)
      .get(auditUrl(TENANT_A, '/actions'))
      .set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('GET /actions returns 403 when the caller lacks the admin role in their tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'member' }, error: null });

    const res = await request(app)
      .get(auditUrl(TENANT_A, '/actions'))
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockSupabase.from).not.toHaveBeenCalledWith('tenant_admin_audit_log');
  });

  // --- Tenant isolation ---

  it('rejects a tenant-A admin reading tenant-B audit log (403, no query issued)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(auditUrl(TENANT_B, '/actions'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    // The audit-log table must never be touched on a cross-tenant request
    expect(mockSupabase.from).not.toHaveBeenCalledWith('tenant_admin_audit_log');
  });

  it('GET /actions scopes the query to the caller tenant via eq(tenant_id)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [{ id: '1', tenant_id: TENANT_A, action: 'member.invited' }];
    chainFor('tenant_admin_audit_log').mockResolvedValue({ data: rows, error: null });

    const res = await request(app)
      .get(auditUrl(TENANT_A, '/actions'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, actions: rows });
    const chain = chainFor('tenant_admin_audit_log');
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(chain.limit).toHaveBeenCalledWith(50); // default limit
  });

  it('exafy super-admin can read any tenant audit log; query is scoped to that tenant', async () => {
    mockVerifiedJwt(EXAFY_ADMIN_CLAIMS);
    chainFor('tenant_admin_audit_log').mockResolvedValue({ data: [], error: null });

    const res = await request(app)
      .get(auditUrl(TENANT_B, '/actions'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(chainFor('tenant_admin_audit_log').eq).toHaveBeenCalledWith('tenant_id', TENANT_B);
    // Super-admin bypass must not hit the user_tenants role lookup
    expect(mockUserTenantsSingle).not.toHaveBeenCalled();
  });

  // --- Query params ---

  it('GET /actions caps limit at 200 and applies the action filter', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_admin_audit_log').mockResolvedValue({ data: [], error: null });

    const res = await request(app)
      .get(auditUrl(TENANT_A, '/actions?limit=9999&action=role.granted'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    const chain = chainFor('tenant_admin_audit_log');
    expect(chain.limit).toHaveBeenCalledWith(200);
    expect(chain.eq).toHaveBeenCalledWith('action', 'role.granted');
  });

  // --- Error paths ---

  it('GET /actions returns 500 when the query fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_admin_audit_log').mockResolvedValue({
      data: null,
      error: { message: 'relation missing' },
    });

    const res = await request(app)
      .get(auditUrl(TENANT_A, '/actions'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'relation missing' });
  });

  it('GET /actions returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .get(auditUrl(TENANT_A, '/actions'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET /access ---

  it('GET /access returns auth-topic OASIS events for an authenticated tenant admin', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [{ id: 'e1', topic: 'auth.login' }];
    chainFor('oasis_events').mockResolvedValue({ data: rows, error: null });

    const res = await request(app)
      .get(auditUrl(TENANT_A, '/access'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, access_log: rows });
    const chain = chainFor('oasis_events');
    expect(chain.in).toHaveBeenCalledWith('topic', [
      'auth.login',
      'auth.logout',
      'auth.signup',
      'role.changed',
    ]);
    expect(chain.limit).toHaveBeenCalledWith(50);
    // NOTE (documented current behavior, see suite report): oasis_events is
    // NOT filtered by tenant here — cross-tenant login events are returned to
    // any tenant admin. The middleware gates access, not the data.
  });

  it('GET /access is still denied cross-tenant at the middleware (403)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(auditUrl(TENANT_B, '/access'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(mockSupabase.from).not.toHaveBeenCalledWith('oasis_events');
  });

  it('GET /access returns 500 when the events query fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('oasis_events').mockResolvedValue({ data: null, error: { message: 'boom' } });

    const res = await request(app)
      .get(auditUrl(TENANT_A, '/access'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'boom' });
  });
});
