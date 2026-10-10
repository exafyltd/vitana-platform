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
    gt: jest.fn(() => chain),
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

// VTID-05044: accept looks the caller (and, for developer/infra, the inviter)
// up in auth.users via the service client.
const mockGetUserById = jest.fn();
const mockSupabase = {
  from: jest.fn((table: string) => chainFor(table)),
  auth: { admin: { getUserById: (id: string) => mockGetUserById(id) } },
};
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

/** auth.users rows by id; unknown ids resolve to { user: null }. */
function mockAuthUsers(users: Record<string, object>) {
  mockGetUserById.mockImplementation(async (id: string) => ({ data: { user: users[id] ?? null }, error: null }));
}

const CONFIRMED_MEMBER = { id: 'member-1', email: 'member@example.com', email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: {} };
const TENANT_ADMIN_INVITER = { id: 'admin-a', email: 'admin-a@example.com', email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: { exafy_admin: false } };
const EXAFY_INVITER = { id: 'exafy-1', email: 'ops@exafy.io', email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: { exafy_admin: true } };

const futureExpiry = () => new Date(Date.now() + 7 * 86400_000).toISOString();
const pendingInvitation = (overrides: object = {}) => ({
  id: INVITE_ID,
  tenant_id: TENANT_A,
  email: 'member@example.com',
  roles: ['community'],
  invited_by: 'admin-a',
  expires_at: futureExpiry(),
  ...overrides,
});

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
    mockGetUserById.mockReset();
    mockAuthUsers({ 'member-1': CONFIRMED_MEMBER, 'admin-a': TENANT_ADMIN_INVITER, 'exafy-1': EXAFY_INVITER });
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

  it('POST / allows re-inviting once the previous invitation has expired (VTID-03938)', async () => {
    // Regression test: fetchExistingPendingInvitation() used to check only
    // accepted_at/revoked_at, so an expired-but-unrevoked invitation blocked
    // re-inviting the same email forever (409 ALREADY_INVITED with no way
    // out short of an admin manually calling /revoke first). The fix adds an
    // expires_at filter to the duplicate-check query itself — asserting the
    // filter was applied is what actually pins the fix, since a mocked
    // resolved value alone can't distinguish "filtered correctly" from
    // "filter never added".
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('tenant_invitations');
    // Simulates: with the expires_at filter applied, the expired row no
    // longer matches, so Supabase's .single() reports "no rows".
    chain.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'No rows' } });
    chain.mockResolvedValueOnce({
      data: { id: INVITE_ID, email: 'expired-invite@example.com', roles: ['community'], token: 'tok-456' },
      error: null,
    });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
      .set('Authorization', 'Bearer token')
      .send({ email: 'expired-invite@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    // The duplicate-check query must filter on expires_at, not just
    // accepted_at/revoked_at — this is the line that actually pins the fix.
    expect(chain.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'expired-invite@example.com' })
    );
  });

  it('POST / returns 500 (not a silent duplicate-invite risk) when the existing-invitation check errors', async () => {
    // Previously: an unchecked `{data}`-only destructure meant a failed
    // existing-invitation lookup resolved `existing` to undefined, so the
    // handler proceeded as if no pending invitation existed — risking a
    // duplicate invitation record/email for someone already invited.
    // Uses a non-PGRST116 code: PGRST116 ("no rows") is .single()'s normal,
    // expected shape for "not yet invited" and must NOT be treated as an error
    // (see the two POST / success tests above, which rely on exactly that).
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('tenant_invitations');
    chain.mockResolvedValueOnce({ data: null, error: { code: '500', message: 'lookup failed' } });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
      .set('Authorization', 'Bearer token')
      .send({ email: 'dupe@example.com' });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
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
    const invite = pendingInvitation({ roles: ['community', 'professional'] });
    chainFor('tenant_invitations').mockResolvedValueOnce({ data: invite, error: null });
    // VTID-05044: the atomic claim wins
    chainFor('tenant_invitations').mockResolvedValueOnce({ data: invite, error: null });
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
    // Invitation claimed by this user, conditionally on still being pending
    const inv = chainFor('tenant_invitations');
    expect(inv.update).toHaveBeenCalledWith(
      expect.objectContaining({ accepted_by: 'member-1', accepted_at: expect.any(String) })
    );
    expect(inv.is).toHaveBeenCalledWith('accepted_at', null);
    expect(inv.is).toHaveBeenCalledWith('revoked_at', null);
    expect(inv.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
    // VTID-05044: the claim happens before anything is granted
    const claimOrder = (inv.update as jest.Mock).mock.invocationCallOrder[0];
    expect((chainFor('user_tenants').insert as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(claimOrder);
    expect((chainFor('user_permitted_roles').upsert as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(claimOrder);
  });

  it('accept: returns 500 (not a silent membership reset) when the existing-membership check errors', async () => {
    // Previously: an unchecked `{data}`-only destructure meant a failed
    // existing-membership lookup resolved `existingMembership` to undefined,
    // so the handler proceeded as if the user had no membership yet —
    // inserting a fresh user_tenants row and resetting active_role even for
    // a user who already had a membership. Uses a non-PGRST116 code:
    // PGRST116 ("no rows") is .single()'s normal "not yet a member" shape
    // and must NOT be treated as an error (see the success test above).
    mockVerifiedJwt(MEMBER_CLAIMS);
    chainFor('tenant_invitations').mockResolvedValueOnce({ data: pendingInvitation(), error: null });
    chainFor('user_tenants').mockResolvedValueOnce({ data: null, error: { code: '500', message: 'lookup failed' } });

    const res = await request(app)
      .post('/api/v1/admin/invitations/accept/tok-123')
      .set('Authorization', 'Bearer member-token');

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(chainFor('user_tenants').insert).not.toHaveBeenCalled();
    expect(chainFor('user_permitted_roles').upsert).not.toHaveBeenCalled();
    // ...and the invitation is not consumed either
    expect(chainFor('tenant_invitations').update).not.toHaveBeenCalled();
  });

  // --- VTID-05044 (Track S / S4): invitation role allowlist ---

  describe('VTID-05044 create: role allowlist', () => {
    const EXAFY_CLAIMS = {
      sub: 'exafy-1',
      email: 'ops@exafy.io',
      app_metadata: { active_tenant_id: TENANT_A, exafy_admin: true },
    };

    function mockCreateSucceeds(roles: string[]) {
      const chain = chainFor('tenant_invitations');
      chain.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'No rows' } });
      chain.mockResolvedValueOnce({ data: { id: INVITE_ID, email: 'x@example.com', roles, token: 't' }, error: null });
      return chain;
    }

    it.each(['developer', 'infra'])('a tenant admin cannot invite as %s (403, no insert)', async (role) => {
      mockVerifiedJwt(tenantAdminClaims(TENANT_A));

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
        .set('Authorization', 'Bearer token')
        .send({ email: 'x@example.com', roles: ['community', role] });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ROLE_NOT_GRANTABLE');
      expect(chainFor('tenant_invitations').insert).not.toHaveBeenCalled();
    });

    it('an exafy_admin can invite as developer (201)', async () => {
      mockVerifiedJwt(EXAFY_CLAIMS);
      const chain = mockCreateSucceeds(['developer']);

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
        .set('Authorization', 'Bearer token')
        .send({ email: 'x@example.com', roles: ['developer'] });

      expect(res.status).toBe(201);
      expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ roles: ['developer'], invited_by: 'exafy-1' }));
    });

    it.each([['bogus'], ['commerce'], [42]])('an unknown role (%p) is refused with 400 INVALID_ROLE', async (role) => {
      mockVerifiedJwt(tenantAdminClaims(TENANT_A));

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
        .set('Authorization', 'Bearer token')
        .send({ email: 'x@example.com', roles: ['community', role] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_ROLE');
      expect(res.body.valid_roles).toEqual(expect.arrayContaining(['community', 'admin', 'backoffice']));
      expect(chainFor('tenant_invitations').insert).not.toHaveBeenCalled();
    });

    it.each(['backoffice', 'admin'])('a tenant admin can invite as %s (201)', async (role) => {
      mockVerifiedJwt(tenantAdminClaims(TENANT_A));
      const chain = mockCreateSucceeds([role]);

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
        .set('Authorization', 'Bearer token')
        .send({ email: 'x@example.com', roles: [role] });

      expect(res.status).toBe(201);
      expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ roles: [role] }));
    });

    it('duplicate roles are stored once', async () => {
      mockVerifiedJwt(tenantAdminClaims(TENANT_A));
      const chain = mockCreateSucceeds(['community', 'staff']);

      const res = await request(app)
        .post(`/api/v1/admin/tenants/${TENANT_A}/invitations`)
        .set('Authorization', 'Bearer token')
        .send({ email: 'x@example.com', roles: ['community', 'staff', 'community'] });

      expect(res.status).toBe(201);
      expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ roles: ['community', 'staff'] }));
    });
  });

  // --- VTID-05044 (Track S / S4): accept requires the invited, confirmed email ---

  describe('VTID-05044 accept: email binding, legacy roles, atomic claim', () => {
    function expectNothingGranted() {
      expect(chainFor('tenant_invitations').update).not.toHaveBeenCalled();
      expect(chainFor('user_tenants').insert).not.toHaveBeenCalled();
      expect(chainFor('user_permitted_roles').upsert).not.toHaveBeenCalled();
    }

    it('a caller whose email differs from the invitation gets 403 EMAIL_MISMATCH and the invite stays pending', async () => {
      mockVerifiedJwt(MEMBER_CLAIMS);
      chainFor('tenant_invitations').mockResolvedValueOnce({
        data: pendingInvitation({ email: 'someone-else@example.com' }),
        error: null,
      });

      const res = await request(app)
        .post('/api/v1/admin/invitations/accept/tok-123')
        .set('Authorization', 'Bearer member-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('EMAIL_MISMATCH');
      expect(mockGetUserById).toHaveBeenCalledWith('member-1');
      expectNothingGranted();
    });

    it('a case-only difference in the email is accepted (200)', async () => {
      mockVerifiedJwt(MEMBER_CLAIMS);
      mockAuthUsers({ 'member-1': { ...CONFIRMED_MEMBER, email: 'Member@Example.COM' } });
      const invite = pendingInvitation();
      chainFor('tenant_invitations').mockResolvedValueOnce({ data: invite, error: null });
      chainFor('tenant_invitations').mockResolvedValueOnce({ data: invite, error: null });
      chainFor('user_tenants').mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'No rows' } });

      const res = await request(app)
        .post('/api/v1/admin/invitations/accept/tok-123')
        .set('Authorization', 'Bearer member-token');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(chainFor('user_permitted_roles').upsert).toHaveBeenCalledTimes(1);
    });

    it('an unconfirmed email gets 403 EMAIL_UNVERIFIED', async () => {
      mockVerifiedJwt(MEMBER_CLAIMS);
      mockAuthUsers({ 'member-1': { ...CONFIRMED_MEMBER, email_confirmed_at: null } });
      chainFor('tenant_invitations').mockResolvedValueOnce({ data: pendingInvitation(), error: null });

      const res = await request(app)
        .post('/api/v1/admin/invitations/accept/tok-123')
        .set('Authorization', 'Bearer member-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('EMAIL_UNVERIFIED');
      expectNothingGranted();
    });

    it('a legacy invite carrying infra from a non-exafy inviter gets 409 INVITATION_ROLES_INVALID', async () => {
      mockVerifiedJwt(MEMBER_CLAIMS);
      chainFor('tenant_invitations').mockResolvedValueOnce({
        data: pendingInvitation({ roles: ['community', 'infra'], invited_by: 'admin-a' }),
        error: null,
      });

      const res = await request(app)
        .post('/api/v1/admin/invitations/accept/tok-123')
        .set('Authorization', 'Bearer member-token');

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('INVITATION_ROLES_INVALID');
      expect(mockGetUserById).toHaveBeenCalledWith('admin-a');
      expectNothingGranted();
    });

    it('a legacy invite carrying an unknown role gets 409 INVITATION_ROLES_INVALID', async () => {
      mockVerifiedJwt(MEMBER_CLAIMS);
      chainFor('tenant_invitations').mockResolvedValueOnce({
        data: pendingInvitation({ roles: ['bogus'] }),
        error: null,
      });

      const res = await request(app)
        .post('/api/v1/admin/invitations/accept/tok-123')
        .set('Authorization', 'Bearer member-token');

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('INVITATION_ROLES_INVALID');
      expectNothingGranted();
    });

    it('an infra invite from an exafy_admin inviter is honoured (200)', async () => {
      mockVerifiedJwt(MEMBER_CLAIMS);
      const invite = pendingInvitation({ roles: ['infra'], invited_by: 'exafy-1' });
      chainFor('tenant_invitations').mockResolvedValueOnce({ data: invite, error: null });
      chainFor('tenant_invitations').mockResolvedValueOnce({ data: invite, error: null });
      chainFor('user_tenants').mockResolvedValueOnce({ data: { id: 'm1' }, error: null });

      const res = await request(app)
        .post('/api/v1/admin/invitations/accept/tok-123')
        .set('Authorization', 'Bearer member-token');

      expect(res.status).toBe(200);
      expect(chainFor('user_permitted_roles').upsert).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'infra', granted_by: 'exafy-1' }),
        expect.anything(),
      );
    });

    it('double accept: the second request loses the claim with 409 ALREADY_USED and grants nothing', async () => {
      mockVerifiedJwt(MEMBER_CLAIMS);
      const invite = pendingInvitation({ roles: ['community'] });
      const inv = chainFor('tenant_invitations');
      // request 1: fetch, claim wins
      inv.mockResolvedValueOnce({ data: invite, error: null });
      inv.mockResolvedValueOnce({ data: invite, error: null });
      chainFor('user_tenants').mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'No rows' } });
      // request 2: fetch still saw it pending (race), conditional claim matches no row
      inv.mockResolvedValueOnce({ data: invite, error: null });
      inv.mockResolvedValueOnce({ data: null, error: null });
      chainFor('user_tenants').mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'No rows' } });

      const first = await request(app)
        .post('/api/v1/admin/invitations/accept/tok-123')
        .set('Authorization', 'Bearer member-token');
      expect(first.status).toBe(200);

      const insertsAfterFirst = (chainFor('user_tenants').insert as jest.Mock).mock.calls.length;
      const upsertsAfterFirst = (chainFor('user_permitted_roles').upsert as jest.Mock).mock.calls.length;

      const second = await request(app)
        .post('/api/v1/admin/invitations/accept/tok-123')
        .set('Authorization', 'Bearer member-token');

      expect(second.status).toBe(409);
      expect(second.body.error).toBe('ALREADY_USED');
      expect((chainFor('user_tenants').insert as jest.Mock).mock.calls.length).toBe(insertsAfterFirst);
      expect((chainFor('user_permitted_roles').upsert as jest.Mock).mock.calls.length).toBe(upsertsAfterFirst);
    });

    it('a failed caller lookup is a 500, never a grant', async () => {
      mockVerifiedJwt(MEMBER_CLAIMS);
      mockGetUserById.mockResolvedValue({ data: { user: null }, error: { message: 'auth down' } });
      chainFor('tenant_invitations').mockResolvedValueOnce({ data: pendingInvitation(), error: null });

      const res = await request(app)
        .post('/api/v1/admin/invitations/accept/tok-123')
        .set('Authorization', 'Bearer member-token');

      expect(res.status).toBe(500);
      expectNothingGranted();
    });
  });
});
