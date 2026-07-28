/**
 * Tests for src/routes/tenant-admin/invitations.ts
 *
 * Admin router (requireTenantAdmin), mounted in prod at
 * /api/v1/admin/tenants/:tenantId/invitations:
 *   POST /            — create invitation
 *   GET  /            — list (with ?status= filters)
 *   POST /:id/revoke  — revoke pending invitation
 *
 * Accept router (requireAuth only), mounted at /api/v1/admin/invitations:
 *   POST /accept/:token — accept an invitation as the logged-in user
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
    not: jest.fn(() => chain),
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

// requireAuth (accept route) fires this in the background — keep it inert
jest.mock('../../../src/services/guide/active-usage', () => ({
  upsertActiveDay: jest.fn().mockResolvedValue(undefined),
  countActiveUsageDays: jest.fn().mockResolvedValue(0),
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
const invitationsModule = require('../../../src/routes/tenant-admin/invitations');
const router = invitationsModule.default;
const acceptRouter = invitationsModule.acceptRouter;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/invitations', router);
app.use('/api/v1/admin/invitations', acceptRouter);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVITE_ID = '55555555-5555-4555-8555-555555555555';

const tenantAdminClaims = (tenantId: string) => ({
  sub: 'admin-a',
  email: 'admin-a@example.com',
  app_metadata: { active_tenant_id: tenantId, exafy_admin: false },
});

const MEMBER_CLAIMS = {
  sub: 'member-1',
  email: 'member@example.com',
  app_metadata: { active_tenant_id: TENANT_A, exafy_admin: false },
};

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
}

describe('Tenant Admin Invitations Routes', () => {
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
    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
      .send({ email: 'x@y.io' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('tenant isolation: tenant A admin cannot invite into tenant B (403, no insert)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_B}/invitations`)
      .set('Authorization', 'Bearer tenant-a-token')
      .send({ email: 'victim@example.com', roles: ['admin'] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(chainFor('tenant_invitations').insert).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin member of the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'community' }, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(403);
    expect(chainFor('tenant_invitations').select).not.toHaveBeenCalled();
  });

  // --- POST / (create) ---

  it('POST / rejects an invalid email with 400', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
      .set('Authorization', 'Bearer token')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_EMAIL');
    expect(chainFor('tenant_invitations').insert).not.toHaveBeenCalled();
  });

  it('POST / creates an invitation with normalized email, default role, and the tenant id', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('tenant_invitations');
    // 1) pending-duplicate check → none
    chain.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'No rows' } });
    // 2) insert result
    const created = {
      id: INVITE_ID,
      email: 'new@example.com',
      roles: ['community'],
      token: 'tok-123',
      expires_at: '2026-08-28T00:00:00Z',
      created_at: '2026-07-28T00:00:00Z',
    };
    chain.mockResolvedValueOnce({ data: created, error: null });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
      .set('Authorization', 'Bearer token')
      .send({ email: '  NEW@Example.com ' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.invitation).toEqual({
      id: INVITE_ID,
      email: 'new@example.com',
      roles: ['community'],
      token: 'tok-123',
      expires_at: '2026-08-28T00:00:00Z',
      created_at: '2026-07-28T00:00:00Z',
      accept_url: '/admin/invitations/accept/tok-123',
    });

    // Row is created inside the caller's tenant with normalized email
    expect(chain.insert).toHaveBeenCalledWith({
      tenant_id: TENANT_A,
      email: 'new@example.com',
      roles: ['community'],
      invited_by: 'admin-a',
      message: null,
    });
    // Duplicate check was also tenant-scoped
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  it('POST / passes through explicit roles', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('tenant_invitations');
    chain.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'No rows' } });
    chain.mockResolvedValueOnce({
      data: { id: INVITE_ID, email: 'pro@example.com', roles: ['professional', 'community'], token: 't' },
      error: null,
    });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
      .set('Authorization', 'Bearer token')
      .send({ email: 'pro@example.com', roles: ['professional', 'community'], message: 'welcome' });

    expect(res.status).toBe(201);
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ['professional', 'community'], message: 'welcome' })
    );
  });

  it('POST / returns 409 when a pending invitation already exists', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('tenant_invitations');
    chain.mockResolvedValueOnce({ data: { id: 'existing-1' }, error: null });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
      .set('Authorization', 'Bearer token')
      .send({ email: 'dupe@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_INVITED');
    expect(chain.insert).not.toHaveBeenCalled();
  });

  it('POST / returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
      .set('Authorization', 'Bearer token')
      .send({ email: 'x@y.io' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET / (list) ---

  it('GET / lists invitations scoped to the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [{ id: 'i1', email: 'a@x.io' }, { id: 'i2', email: 'b@x.io' }];
    const chain = chainFor('tenant_invitations');
    chain.mockResolvedValueOnce({ data: rows, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.invitations).toEqual(rows);
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A); // isolation
  });

  it('GET /?status=pending adds the null accepted_at/revoked_at filters', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('tenant_invitations');
    chain.mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/invitations?status=pending`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(chain.is).toHaveBeenCalledWith('accepted_at', null);
    expect(chain.is).toHaveBeenCalledWith('revoked_at', null);
  });

  // --- POST /:id/revoke ---

  it('POST /:id/revoke revokes only within the tenant and stamps the actor', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('tenant_invitations');
    const revoked = { id: INVITE_ID, revoked_at: '2026-07-28T00:00:00Z' };
    chain.mockResolvedValueOnce({ data: revoked, error: null });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/invitations/${INVITE_ID}/revoke`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.invitation).toEqual(revoked);
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ revoked_by: 'admin-a', revoked_at: expect.any(String) })
    );
    // Tenant isolation on the mutation: id AND tenant filters both applied
    expect(chain.eq).toHaveBeenCalledWith('id', INVITE_ID);
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    // Only pending invitations are revocable
    expect(chain.is).toHaveBeenCalledWith('accepted_at', null);
    expect(chain.is).toHaveBeenCalledWith('revoked_at', null);
  });

  it('POST /:id/revoke returns 404 when the invitation is not found in this tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_invitations').mockResolvedValueOnce({ data: null, error: { message: 'No rows' } });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/invitations/${INVITE_ID}/revoke`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  // --- POST /accept/:token (public accept router, requireAuth) ---

  it('accept: returns 401 without a token', async () => {
    const res = await request(app).post('/api/v1/admin/invitations/accept/tok-123');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('accept: returns 404 for an unknown/used token', async () => {
    mockVerifiedJwt(MEMBER_CLAIMS);
    chainFor('tenant_invitations').mockResolvedValueOnce({ data: null, error: { message: 'No rows' } });

    const res = await request(app)
      .post('/api/v1/admin/invitations/accept/tok-unknown')
      .set('Authorization', 'Bearer member-token');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  it('accept: returns 410 for an expired invitation', async () => {
    mockVerifiedJwt(MEMBER_CLAIMS);
    chainFor('tenant_invitations').mockResolvedValueOnce({
      data: {
        id: INVITE_ID,
        tenant_id: TENANT_A,
        roles: ['community'],
        invited_by: 'admin-a',
        expires_at: '2020-01-01T00:00:00Z',
      },
      error: null,
    });

    const res = await request(app)
      .post('/api/v1/admin/invitations/accept/tok-old')
      .set('Authorization', 'Bearer member-token');

    expect(res.status).toBe(410);
    expect(res.body.error).toBe('EXPIRED');
    expect(chainFor('user_tenants').insert).not.toHaveBeenCalled();
  });

  it('accept: creates membership + grants roles for the invitation\'s tenant only', async () => {
    mockVerifiedJwt(MEMBER_CLAIMS);
    const futureExpiry = new Date(Date.now() + 7 * 86400_000).toISOString();
    chainFor('tenant_invitations').mockResolvedValueOnce({
      data: {
        id: INVITE_ID,
        tenant_id: TENANT_A,
        roles: ['community', 'professional'],
        invited_by: 'admin-a',
        expires_at: futureExpiry,
      },
      error: null,
    });
    // No existing membership
    chainFor('user_tenants').mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'No rows' } });

    const res = await request(app)
      .post('/api/v1/admin/invitations/accept/tok-123')
      .set('Authorization', 'Bearer member-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenant_id).toBe(TENANT_A);
    expect(res.body.roles).toEqual(['community', 'professional']);

    // Membership created in the invitation's tenant, first role active
    expect(chainFor('user_tenants').insert).toHaveBeenCalledWith({
      user_id: 'member-1',
      tenant_id: TENANT_A,
      active_role: 'community',
      is_primary: false,
    });
    // Every offered role granted, scoped to the invitation's tenant
    const upsertCalls = (chainFor('user_permitted_roles').upsert as jest.Mock).mock.calls;
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0][0]).toEqual({
      user_id: 'member-1',
      tenant_id: TENANT_A,
      role: 'community',
      granted_by: 'admin-a',
    });
    expect(upsertCalls[1][0]).toMatchObject({ role: 'professional', tenant_id: TENANT_A });
    // Invitation marked accepted by this user
    expect(chainFor('tenant_invitations').update).toHaveBeenCalledWith(
      expect.objectContaining({ accepted_by: 'member-1', accepted_at: expect.any(String) })
    );
  });
});
