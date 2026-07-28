/**
 * Tests for src/routes/admin-tenants.ts (Phase 2 — tenancy & RBAC).
 *
 * The router authenticates via a user-context Supabase client
 * (createUserSupabaseClient(token).auth.getUser()) and gates every
 * endpoint on app_metadata.exafy_admin === true. DB access goes through
 * getSupabase() (service-role client).
 */
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Per-table thenable query-chain mock for the service-role client
const createChain = () => {
  const responseQueue: any[] = [];
  let defaultData: any = { data: null, error: null };

  const chain: any = {
    select: jest.fn(() => chain),
    order: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    ilike: jest.fn(() => chain),
    single: jest.fn(() => chain),
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

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

// User-context auth client (verifyExafyAdmin calls .auth.getUser())
const mockGetUser = jest.fn();
jest.mock('../../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn(() => ({ auth: { getUser: mockGetUser } })),
}));

import router from '../../src/routes/admin-tenants';

const app = express();
app.use(express.json());
app.use('/', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockAuthedUser(appMetadata: Record<string, unknown>, userId = 'user-1', email = 'u@x.io') {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email, app_metadata: appMetadata } },
    error: null,
  });
}

function mockInvalidToken() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } });
}

const EXAFY_ADMIN = { exafy_admin: true };
const PLAIN_ADMIN = { exafy_admin: false }; // e.g. a tenant admin, NOT an exafy admin

describe('admin-tenants routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockInvalidToken();
  });

  // --- Authz denial -------------------------------------------------------

  it('GET / without Authorization header → 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    // Nothing touched the DB
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('GET / with a non-Bearer Authorization header → 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/').set('Authorization', 'Basic abc123');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('GET / with an invalid token → 401 INVALID_TOKEN', async () => {
    mockInvalidToken();
    const res = await request(app).get('/').set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'INVALID_TOKEN' });
  });

  it('a non-exafy-admin user cannot list tenants → 403 FORBIDDEN', async () => {
    mockAuthedUser(PLAIN_ADMIN);
    const res = await request(app).get('/').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('a user with no app_metadata at all is refused → 403 FORBIDDEN', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u2', email: 'e@x.io', app_metadata: undefined } },
      error: null,
    });
    const res = await request(app).get('/').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('non-exafy-admin cannot read tenant detail either → 403 FORBIDDEN', async () => {
    mockAuthedUser(PLAIN_ADMIN);
    const res = await request(app).get('/tenant-1').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('auth layer throwing → 500 INTERNAL_ERROR', async () => {
    mockGetUser.mockRejectedValue(new Error('network down'));
    const res = await request(app).get('/').set('Authorization', 'Bearer t');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

  // --- DB availability ----------------------------------------------------

  it('GET / when the service-role client is unavailable → 503 DB_UNAVAILABLE', async () => {
    mockAuthedUser(EXAFY_ADMIN);
    mockGetSupabase.mockReturnValue(null as any);
    const res = await request(app).get('/').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET / (list) -------------------------------------------------------

  it('GET / as exafy admin lists tenants with per-tenant user counts and status', async () => {
    mockAuthedUser(EXAFY_ADMIN);
    chainFor('tenants').mockResolvedValue({
      data: [
        { id: 't1', name: 'Acme', slug: 'acme', created_at: 'c1', updated_at: 'u1' },
        { id: 't2', name: 'Beta', slug: 'beta', created_at: 'c2', updated_at: 'u2' },
      ],
      error: null,
    });
    chainFor('user_tenants').mockResolvedValue({
      data: [{ tenant_id: 't1' }, { tenant_id: 't1' }, { tenant_id: 'other' }],
      error: null,
    });

    const res = await request(app).get('/').set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenants).toEqual([
      { id: 't1', name: 'Acme', slug: 'acme', user_count: 2, status: 'Active', created_at: 'c1', updated_at: 'u1' },
      { id: 't2', name: 'Beta', slug: 'beta', user_count: 0, status: 'Empty', created_at: 'c2', updated_at: 'u2' },
    ]);
  });

  it('GET /?query= filters by name via ilike', async () => {
    mockAuthedUser(EXAFY_ADMIN);
    chainFor('tenants').mockResolvedValue({ data: [], error: null });
    chainFor('user_tenants').mockResolvedValue({ data: [], error: null });

    const res = await request(app).get('/?query=acme').set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(200);
    expect(chainFor('tenants').ilike).toHaveBeenCalledWith('name', '%acme%');
  });

  it('GET / surfaces a tenants query error as 500', async () => {
    mockAuthedUser(EXAFY_ADMIN);
    chainFor('tenants').mockResolvedValue({ data: null, error: { message: 'boom' } });
    chainFor('user_tenants').mockResolvedValue({ data: [], error: null });

    const res = await request(app).get('/').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'boom' });
  });

  // --- GET /:id (detail) --------------------------------------------------

  it('GET /:id returns tenant detail with resolved member emails', async () => {
    mockAuthedUser(EXAFY_ADMIN);
    chainFor('tenants').mockResolvedValueOnce({
      data: { id: 't1', name: 'Acme', slug: 'acme', created_at: 'c1', updated_at: 'u1' },
      error: null,
    });
    chainFor('user_tenants').mockResolvedValue({
      data: [{ user_id: 'u1', active_role: 'admin', is_primary: true }],
      error: null,
    });
    chainFor('app_users').mockResolvedValue({
      data: [{ user_id: 'u1', email: 'member@acme.io', display_name: 'Member One' }],
      error: null,
    });

    const res = await request(app).get('/t1').set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenant).toEqual({
      id: 't1',
      name: 'Acme',
      slug: 'acme',
      user_count: 1,
      status: 'Active',
      created_at: 'c1',
      updated_at: 'u1',
      members: [
        {
          user_id: 'u1',
          email: 'member@acme.io',
          display_name: 'Member One',
          active_role: 'admin',
          is_primary: true,
        },
      ],
    });
  });

  it('GET /:id falls back to slug lookup when id lookup fails', async () => {
    mockAuthedUser(EXAFY_ADMIN);
    // First .single() (by id) fails; second (by slug) succeeds
    chainFor('tenants').mockResolvedValueOnce({ data: null, error: { message: 'not a uuid' } });
    chainFor('tenants').mockResolvedValueOnce({
      data: { id: 't9', name: 'Slugged', slug: 'slugged', created_at: 'c', updated_at: 'u' },
      error: null,
    });
    chainFor('user_tenants').mockResolvedValue({ data: [], error: null });

    const res = await request(app).get('/slugged').set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toBe('t9');
    expect(res.body.tenant.status).toBe('Empty');
    expect(res.body.tenant.members).toEqual([]);
    expect(chainFor('tenants').eq).toHaveBeenCalledWith('id', 'slugged');
    expect(chainFor('tenants').eq).toHaveBeenCalledWith('slug', 'slugged');
  });

  it('GET /:id → 404 TENANT_NOT_FOUND when neither id nor slug matches', async () => {
    mockAuthedUser(EXAFY_ADMIN);
    chainFor('tenants').mockResolvedValueOnce({ data: null, error: { message: 'no rows' } });
    chainFor('tenants').mockResolvedValueOnce({ data: null, error: { message: 'no rows' } });

    const res = await request(app).get('/missing').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'TENANT_NOT_FOUND' });
  });
});
