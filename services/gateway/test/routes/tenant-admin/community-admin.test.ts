/**
 * Tests for src/routes/tenant-admin/community-admin.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/community
 *   GET    /meetups        — global_community_events + organizer + tickets
 *   DELETE /meetups/:id    — delete an event
 *   GET    /groups         — global_community_groups
 *   GET    /live-rooms     — live_rooms
 *   GET    /creators       — creator_profiles
 *   GET    /memberships    — community_memberships
 *   GET    /stats          — head counts across community tables
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

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_URL = 'http://localhost:54321';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../../src/routes/tenant-admin/community-admin').default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/community', router);

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

const url = (tenantId: string, tail: string) =>
  `/api/v1/admin/tenants/${tenantId}/community${tail}`;

describe('Community Admin routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockInvalidJwt();
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
  });

  // --- Auth denial ---

  it('GET /meetups returns 401 without a token', async () => {
    const res = await request(app).get(url(TENANT_A, '/meetups'));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('GET /meetups returns 403 for a non-admin tenant member', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'community' }, error: null });

    const res = await request(app)
      .get(url(TENANT_A, '/meetups'))
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  // --- Tenant isolation ---

  it('tenant-A admin cannot list tenant-B community data (403, no query)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(url(TENANT_B, '/meetups'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('tenant-A admin cannot delete an event via tenant-B path (403, no delete)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .delete(url(TENANT_B, '/meetups/evt-1'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(chainFor('global_community_events').delete).not.toHaveBeenCalled();
  });

  // --- GET /meetups ---

  it('GET /meetups enriches events with organizer profiles and tickets', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const events = [
      { id: 'evt-1', title: 'Yoga', created_by: 'org-1', start_time: '2026-08-01T10:00:00Z' },
      { id: 'evt-2', title: 'Run', created_by: 'org-2', start_time: '2026-08-02T10:00:00Z' },
    ];
    chainFor('global_community_events').mockResolvedValue({ data: events, error: null });
    chainFor('app_users').mockResolvedValue({
      data: [{ user_id: 'org-1', email: 'o1@x.io', display_name: 'Org One', avatar_url: null }],
      error: null,
    });
    chainFor('event_ticket_types').mockResolvedValue({
      data: [
        { event_id: 'evt-1', name: 'GA', price: 25, currency: 'USD', quantity_available: 10, quantity_sold: 2 },
      ],
      error: null,
    });

    const res = await request(app)
      .get(url(TENANT_A, '/meetups'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(2);

    const [m1, m2] = res.body.meetups;
    expect(m1.organizer.display_name).toBe('Org One');
    expect(m1.tickets).toHaveLength(1);
    expect(m1.price).toBe(25);
    expect(m1.currency).toBe('USD');
    // evt-2: no profile → Unknown organizer; no tickets → null price, EUR default
    expect(m2.organizer).toEqual({ display_name: 'Unknown', email: null });
    expect(m2.tickets).toEqual([]);
    expect(m2.price).toBeNull();
    expect(m2.currency).toBe('EUR');

    // organizer + ticket lookups are scoped to the listed events
    expect(chainFor('app_users').in).toHaveBeenCalledWith('user_id', ['org-1', 'org-2']);
    expect(chainFor('event_ticket_types').in).toHaveBeenCalledWith('event_id', ['evt-1', 'evt-2']);
    expect(chainFor('global_community_events').order).toHaveBeenCalledWith('start_time', {
      ascending: true,
    });
  });

  it('GET /meetups returns empty list with count 0 when there are no events', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('global_community_events').mockResolvedValue({ data: [], error: null });

    const res = await request(app)
      .get(url(TENANT_A, '/meetups'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, meetups: [], count: 0 });
    // No secondary lookups when there is nothing to enrich
    expect(mockSupabase.from).not.toHaveBeenCalledWith('app_users');
    expect(mockSupabase.from).not.toHaveBeenCalledWith('event_ticket_types');
  });

  it('GET /meetups degrades to ok:true with empty list on a query error', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('global_community_events').mockResolvedValue({
      data: null,
      error: { message: 'table missing' },
    });

    const res = await request(app)
      .get(url(TENANT_A, '/meetups'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, meetups: [], error: 'table missing' });
  });

  it('GET /meetups caps limit at 500', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('global_community_events').mockResolvedValue({ data: [], error: null });

    await request(app)
      .get(url(TENANT_A, '/meetups?limit=99999'))
      .set('Authorization', 'Bearer t');

    expect(chainFor('global_community_events').limit).toHaveBeenCalledWith(500);
  });

  // --- DELETE /meetups/:id ---

  it('DELETE /meetups/:id deletes the event by id for an authorized admin', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('global_community_events').mockResolvedValue({ error: null });

    const res = await request(app)
      .delete(url(TENANT_A, '/meetups/evt-9'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const chain = chainFor('global_community_events');
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('id', 'evt-9');
  });

  it('DELETE /meetups/:id returns 500 when the delete fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('global_community_events').mockResolvedValue({ error: { message: 'fk violation' } });

    const res = await request(app)
      .delete(url(TENANT_A, '/meetups/evt-9'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'fk violation' });
  });

  // --- GET /groups / /live-rooms / /creators / /memberships ---

  it('GET /groups lists groups with count', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [{ id: 'g1' }, { id: 'g2' }];
    chainFor('global_community_groups').mockResolvedValue({ data: rows, error: null });

    const res = await request(app)
      .get(url(TENANT_A, '/groups'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, groups: rows, count: 2 });
    expect(chainFor('global_community_groups').limit).toHaveBeenCalledWith(50);
  });

  it('GET /live-rooms lists rooms and caps limit at 200', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('live_rooms').mockResolvedValue({ data: [{ id: 'r1' }], error: null });

    const res = await request(app)
      .get(url(TENANT_A, '/live-rooms?limit=1000'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.rooms).toHaveLength(1);
    expect(chainFor('live_rooms').limit).toHaveBeenCalledWith(200);
  });

  it('GET /creators lists creator profiles', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('creator_profiles').mockResolvedValue({ data: [{ id: 'c1' }], error: null });

    const res = await request(app)
      .get(url(TENANT_A, '/creators'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, creators: [{ id: 'c1' }], count: 1 });
  });

  it('GET /memberships degrades to empty list on error', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('community_memberships').mockResolvedValue({
      data: null,
      error: { message: 'nope' },
    });

    const res = await request(app)
      .get(url(TENANT_A, '/memberships'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, memberships: [], error: 'nope' });
  });

  // --- GET /stats ---

  it('GET /stats aggregates head counts across the four community tables', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('global_community_events').mockResolvedValue({ count: 3 });
    chainFor('global_community_groups').mockResolvedValue({ count: 2 });
    chainFor('live_rooms').mockResolvedValue({ count: 5 });
    chainFor('global_community_group_members').mockResolvedValue({ count: 40 });

    const res = await request(app)
      .get(url(TENANT_A, '/stats'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      stats: { meetups: 3, groups: 2, live_rooms: 5, memberships: 40 },
    });
  });

  it('GET /stats returns zeros when counts are missing', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    for (const t of [
      'global_community_events',
      'global_community_groups',
      'live_rooms',
      'global_community_group_members',
    ]) {
      chainFor(t).mockResolvedValue({ count: null });
    }

    const res = await request(app)
      .get(url(TENANT_A, '/stats'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({ meetups: 0, groups: 0, live_rooms: 0, memberships: 0 });
  });

  it('GET /groups returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .get(url(TENANT_A, '/groups'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });
});
