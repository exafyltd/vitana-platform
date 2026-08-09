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
 */

import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

jest.mock('jose');

// requireTenantAdmin creates its own service client via createClient().
// Chain: from('user_tenants').select('active_role').eq().eq().single()
jest.mock('@supabase/supabase-js', () => {
  const single = jest.fn();
  const chain: any = { single };
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  const from = jest.fn(() => chain);
  return {
    createClient: jest.fn(() => ({ from })),
    __mock: { single, chain, from },
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
const { requireTenantAdmin } = require('../../src/middleware/require-tenant-admin');

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

function mockAdminRole() {
  supaMock.single.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
}

describe('requireTenantAdmin middleware', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.LOVABLE_JWT_SECRET;
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    // jest.clearAllMocks (setup-tests beforeEach) wiped configured behavior
    mockInvalidJwt();
    supaMock.single.mockResolvedValue({ data: null, error: { message: 'No rows' } });
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
