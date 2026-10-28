/**
 * Tests for src/middleware/require-tenant-admin.ts (Batch 1.B1 tenant-admin RBAC gate).
 *
 * Contract under test:
 *   - 401 UNAUTHENTICATED: missing/malformed Authorization header, invalid token
 *   - exafy_admin bypasses all tenant checks (including cross-tenant)
 *   - 400 TENANT_REQUIRED: no :tenantId param and no tenant_id in JWT
 *   - 403 FORBIDDEN: caller's JWT tenant != target tenant (cross-tenant), even
 *     if the caller is admin of their own tenant
 *   - 403 FORBIDDEN: caller in the right tenant but active_role != 'admin'
 *     (including missing user_tenants membership row)
 *   - allow: attaches req.identity + req.targetTenantId and calls next()
 *   - fail closed: missing service-role config denies (403), never allows
 *   - requirePlatformScope (VTID-05042): after requireTenantAdmin, a tenant
 *     admin gets 403 PLATFORM_SCOPE_ONLY and the handler never runs;
 *     exafy_admin passes
 *   - VTID-05147 (contract changed on purpose): active_role = 'admin' alone no
 *     longer passes — 'admin' must also be a permitted role (user_permitted_roles
 *     or an active memberships admin); a permitted-role read error is 403
 */

import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

jest.mock('jose');

// requireTenantAdmin creates its own service client via createClient().
// Chain: from('user_tenants').select('active_role').eq().eq().single()
// VTID-05147: plus the permitted set — from('user_permitted_roles') and
// from('memberships'), awaited directly; `rows(table)` answers those.
jest.mock('@supabase/supabase-js', () => {
  const single = jest.fn();
  const rows = jest.fn();
  const chain: any = { single };
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  const from = jest.fn((table: string) => {
    if (table === 'user_tenants') return chain;
    const q: any = {};
    q.select = jest.fn(() => q);
    q.eq = jest.fn(() => q);
    q.then = (resolve: any, reject: any) =>
      Promise.resolve(rows(table) ?? { data: [], error: null }).then(resolve, reject);
    return q;
  });
  return {
    createClient: jest.fn(() => ({ from })),
    __mock: { single, chain, from, rows },
  };
});

// Imported (transitively) by auth-supabase-jwt — keep inert. requireTenantAdmin
// only uses verifyAndExtractIdentity, which touches neither of these.
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn(() => null) }));
jest.mock('../../src/services/guide/active-usage', () => ({
  upsertActiveDay: jest.fn().mockResolvedValue(undefined),
}));

// Module-level env capture: the middleware reads these at import time.
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requireTenantAdmin, requirePlatformScope } = require('../../src/middleware/require-tenant-admin');

const supaMock = (jest.requireMock('@supabase/supabase-js') as any).__mock;

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------

const app = express();
app.get('/t/:tenantId/members', requireTenantAdmin, (req: any, res) => {
  res.json({ ok: true, target: req.targetTenantId, user: req.identity?.user_id });
});
app.get('/own', requireTenantAdmin, (req: any, res) => {
  res.json({ ok: true, target: req.targetTenantId });
});
const platformHandler = jest.fn((_req: any, res: any) => res.json({ ok: true }));
app.get('/t/:tenantId/platform', requireTenantAdmin, requirePlatformScope, (req: any, res: any) =>
  platformHandler(req, res),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'user-1',
    email: 'user@example.com',
    app_metadata: { active_tenant_id: 'tenant-a', exafy_admin: false },
    ...overrides,
  };
}

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
}

/** active_role 'admin' AND a permitted admin grant (the legitimate tenant admin). */
function mockAdminRole() {
  supaMock.single.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
  supaMock.rows.mockImplementation((table: string) =>
    table === 'user_permitted_roles' ? { data: [{ role: 'admin' }], error: null } : { data: [], error: null },
  );
}

describe('requireTenantAdmin middleware', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.LOVABLE_JWT_SECRET;
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    // jest.clearAllMocks (setup-tests beforeEach) wiped configured behavior
    mockInvalidJwt();
    supaMock.single.mockResolvedValue({ data: null, error: { message: 'No rows' } });
    supaMock.rows.mockReset();
  });

  // --- Unauthenticated deny paths -----------------------------------------

  it('returns 401 UNAUTHENTICATED when Authorization header is missing', async () => {
    const res = await request(app).get('/t/tenant-a/members');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    expect(jose.jwtVerify).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED for a non-Bearer scheme', async () => {
    const res = await request(app)
      .get('/t/tenant-a/members')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(jose.jwtVerify).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when the token does not verify', async () => {
    mockInvalidJwt();
    const res = await request(app)
      .get('/t/tenant-a/members')
      .set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    // never reaches the DB
    expect(supaMock.single).not.toHaveBeenCalled();
  });

  // --- Allow path -----------------------------------------------------------

  it('allows a tenant admin of the target tenant and attaches targetTenantId', async () => {
    mockVerifiedJwt(claims());
    mockAdminRole();

    const res = await request(app)
      .get('/t/tenant-a/members')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, target: 'tenant-a', user: 'user-1' });
    // verified the exact presented token
    expect(jose.jwtVerify).toHaveBeenCalledWith(
      'good-token',
      expect.anything(),
      expect.objectContaining({ algorithms: ['HS256'] })
    );
    // role looked up for THIS user in THIS tenant
    expect(supaMock.from).toHaveBeenCalledWith('user_tenants');
    expect(supaMock.chain.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(supaMock.chain.eq).toHaveBeenCalledWith('tenant_id', 'tenant-a');
  });

  it('falls back to the JWT tenant when the route has no :tenantId param', async () => {
    mockVerifiedJwt(claims());
    mockAdminRole();

    const res = await request(app).get('/own').set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(200);
    expect(res.body.target).toBe('tenant-a');
    expect(supaMock.chain.eq).toHaveBeenCalledWith('tenant_id', 'tenant-a');
  });

  // --- Cross-tenant denial (the critical case) ------------------------------

  it('denies (403) a user who is admin of tenant A when targeting tenant B', async () => {
    mockVerifiedJwt(claims()); // JWT says tenant-a
    mockAdminRole(); // even a genuine admin role in their own tenant must not help

    const res = await request(app)
      .get('/t/tenant-b/members')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    // rejected on the tenant mismatch BEFORE any role lookup
    expect(supaMock.single).not.toHaveBeenCalled();
  });

  // --- In-tenant role denial ------------------------------------------------

  it('denies (403) a non-admin member of the target tenant', async () => {
    mockVerifiedJwt(claims());
    supaMock.single.mockResolvedValue({ data: { active_role: 'member' }, error: null });

    const res = await request(app)
      .get('/t/tenant-a/members')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('denies (403) a user with no user_tenants membership row', async () => {
    mockVerifiedJwt(claims());
    supaMock.single.mockResolvedValue({ data: null, error: { message: 'No rows found' } });

    const res = await request(app)
      .get('/t/tenant-a/members')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  // --- VTID-05147: active_role is a claim, the permitted set is the grant ----

  it('VTID-05147: denies (403) active_role=admin without a permitted admin role (forged row)', async () => {
    mockVerifiedJwt(claims());
    supaMock.single.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
    supaMock.rows.mockReturnValue({ data: [{ role: 'community' }], error: null });

    const res = await request(app)
      .get('/t/tenant-a/members')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    expect(supaMock.from).toHaveBeenCalledWith('user_permitted_roles');
    expect(supaMock.from).toHaveBeenCalledWith('memberships');
  });

  it('VTID-05147: allows a user_permitted_roles admin', async () => {
    mockVerifiedJwt(claims());
    mockAdminRole();

    const res = await request(app)
      .get('/t/tenant-a/members')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(200);
  });

  it('VTID-05147: allows an active memberships admin', async () => {
    mockVerifiedJwt(claims());
    supaMock.single.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
    supaMock.rows.mockImplementation((table: string) =>
      table === 'memberships' ? { data: [{ role: 'admin' }], error: null } : { data: [], error: null },
    );

    const res = await request(app)
      .get('/t/tenant-a/members')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(200);
  });

  it('VTID-05147: fails closed (403) when the permitted-role read errors', async () => {
    mockVerifiedJwt(claims());
    supaMock.single.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
    supaMock.rows.mockImplementation((table: string) =>
      table === 'user_permitted_roles'
        ? { data: null, error: { message: 'connection reset' } }
        : { data: [{ role: 'admin' }], error: null },
    );

    const res = await request(app)
      .get('/t/tenant-a/members')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  // --- Exafy super-admin bypass ---------------------------------------------

  it('allows an exafy_admin across tenants without any role lookup', async () => {
    mockVerifiedJwt(
      claims({ sub: 'super-1', app_metadata: { active_tenant_id: 'tenant-a', exafy_admin: true } })
    );

    const res = await request(app)
      .get('/t/tenant-b/members')
      .set('Authorization', 'Bearer super-token');

    expect(res.status).toBe(200);
    expect(res.body.user).toBe('super-1');
    expect(supaMock.single).not.toHaveBeenCalled();
  });

  // --- Missing tenant --------------------------------------------------------

  it('returns 400 TENANT_REQUIRED when no :tenantId param and no tenant in JWT', async () => {
    mockVerifiedJwt(claims({ app_metadata: { exafy_admin: false } })); // no active_tenant_id

    const res = await request(app).get('/own').set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'TENANT_REQUIRED' });
  });

  // --- Fail closed on missing config -----------------------------------------

  it('fails closed (403) for a would-be admin when the service-role key is missing', async () => {
    const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    let mw: any;
    let isolatedJose: any;
    jest.isolateModules(() => {
      isolatedJose = require('jose');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mw = require('../../src/middleware/require-tenant-admin').requireTenantAdmin;
    });
    process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;

    (isolatedJose.jwtVerify as jest.Mock).mockResolvedValue({ payload: claims() });

    const isolatedApp = express();
    isolatedApp.get('/t/:tenantId/x', mw, (_req, res) => res.json({ ok: true }));

    const res = await request(isolatedApp)
      .get('/t/tenant-a/x')
      .set('Authorization', 'Bearer good-token');

    // getCallerRole returns null without config → role check fails → deny
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });
});

describe('requirePlatformScope (VTID-05042)', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.LOVABLE_JWT_SECRET;
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    mockInvalidJwt();
    supaMock.single.mockResolvedValue({ data: null, error: { message: 'No rows' } });
    supaMock.rows.mockReset();
  });

  it('403 PLATFORM_SCOPE_ONLY for an admin of their own tenant; handler never runs', async () => {
    mockVerifiedJwt(claims());
    mockAdminRole();

    const res = await request(app)
      .get('/t/tenant-a/platform')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'PLATFORM_SCOPE_ONLY' });
    expect(platformHandler).not.toHaveBeenCalled();
  });

  it('passes exafy_admin through to the handler', async () => {
    mockVerifiedJwt(
      claims({ sub: 'super-1', app_metadata: { active_tenant_id: 'tenant-a', exafy_admin: true } }),
    );

    const res = await request(app)
      .get('/t/tenant-b/platform')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(200);
    expect(platformHandler).toHaveBeenCalledTimes(1);
  });

  it('a non-admin member is still stopped by requireTenantAdmin first (403 FORBIDDEN)', async () => {
    mockVerifiedJwt(claims());
    supaMock.single.mockResolvedValue({ data: { active_role: 'community' }, error: null });

    const res = await request(app)
      .get('/t/tenant-a/platform')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(platformHandler).not.toHaveBeenCalled();
  });
});
