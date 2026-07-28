/**
 * Tests for src/routes/tenant-admin/content-moderation.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/content
 *   GET  /items              — list media_uploads (all statuses)
 *   GET  /items/stats        — counts by status + type
 *   GET  /items/:id          — single item detail
 *   POST /items/:id/approve  — status=approved, is_public=true
 *   POST /items/:id/reject   — status=rejected, is_public=false
 *   POST /items/:id/flag     — status=flagged
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
const router = require('../../../src/routes/tenant-admin/content-moderation').default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/content', router);

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
  `/api/v1/admin/tenants/${tenantId}/content${tail}`;

describe('Content Moderation routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockInvalidJwt();
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
  });

  // --- Auth denial ---

  it('GET /items returns 401 without a token', async () => {
    const res = await request(app).get(url(TENANT_A, '/items'));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('POST /items/:id/approve returns 403 for a non-admin member', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'member' }, error: null });

    const res = await request(app)
      .post(url(TENANT_A, '/items/m-1/approve'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(chainFor('media_uploads').update).not.toHaveBeenCalled();
  });

  // --- Tenant isolation ---

  it('tenant-A admin cannot moderate via tenant-B path (403, no mutation)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .post(url(TENANT_B, '/items/m-1/approve'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(chainFor('media_uploads').update).not.toHaveBeenCalled();
    expect(mockSupabase.from).not.toHaveBeenCalledWith('media_uploads');
  });

  it('tenant-A admin cannot list tenant-B moderation queue (403, no query)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(url(TENANT_B, '/items'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(mockSupabase.from).not.toHaveBeenCalledWith('media_uploads');
  });

  // --- GET /items ---

  it('GET /items lists uploads with default limit 50', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [{ id: 'm-1', status: 'pending' }];
    chainFor('media_uploads').mockResolvedValue({ data: rows, error: null });

    const res = await request(app)
      .get(url(TENANT_A, '/items'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, items: rows, count: 1 });
    const chain = chainFor('media_uploads');
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(chain.limit).toHaveBeenCalledWith(50);
    // No status/type filter unless requested
    expect(chain.eq).not.toHaveBeenCalled();
  });

  it('GET /items applies status + type filters and caps limit at 200', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('media_uploads').mockResolvedValue({ data: [], error: null });

    const res = await request(app)
      .get(url(TENANT_A, '/items?status=flagged&type=video&limit=5000'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    const chain = chainFor('media_uploads');
    expect(chain.eq).toHaveBeenCalledWith('status', 'flagged');
    expect(chain.eq).toHaveBeenCalledWith('media_type', 'video');
    expect(chain.limit).toHaveBeenCalledWith(200);
  });

  it('GET /items degrades to ok:true empty list on query error', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('media_uploads').mockResolvedValue({ data: null, error: { message: 'oops' } });

    const res = await request(app)
      .get(url(TENANT_A, '/items'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, items: [], error: 'oops' });
  });

  it('GET /items returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .get(url(TENANT_A, '/items'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET /items/stats ---

  it('GET /items/stats aggregates counts by status and type', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('media_uploads').mockResolvedValue({
      data: [
        { status: 'approved', media_type: 'music' },
        { status: 'approved', media_type: 'video' },
        { status: 'pending', media_type: 'video' },
        { status: null, media_type: null },
      ],
      error: null,
    });

    const res = await request(app)
      .get(url(TENANT_A, '/items/stats'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      total: 4,
      by_status: { approved: 2, pending: 1, unknown: 1 },
      by_type: { music: 1, video: 2, unknown: 1 },
    });
  });

  // --- GET /items/:id ---

  it('GET /items/:id returns the item with related metadata', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const item = { id: 'm-1', status: 'pending', music_metadata: [] };
    chainFor('media_uploads').mockResolvedValue({ data: item, error: null });

    const res = await request(app)
      .get(url(TENANT_A, '/items/m-1'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, item });
    const chain = chainFor('media_uploads');
    expect(chain.select).toHaveBeenCalledWith(
      '*, music_metadata(*), podcast_metadata(*), video_metadata(*)'
    );
    expect(chain.eq).toHaveBeenCalledWith('id', 'm-1');
  });

  it('GET /items/:id returns 404 when the item does not exist', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('media_uploads').mockResolvedValue({ data: null, error: { message: 'no rows' } });

    const res = await request(app)
      .get(url(TENANT_A, '/items/missing'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  // --- Moderation actions ---

  it('POST /items/:id/approve sets status=approved and is_public=true', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const updated = { id: 'm-1', status: 'approved', is_public: true };
    chainFor('media_uploads').mockResolvedValue({ data: updated, error: null });

    const res = await request(app)
      .post(url(TENANT_A, '/items/m-1/approve'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, item: updated });
    const chain = chainFor('media_uploads');
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', is_public: true })
    );
    expect(chain.eq).toHaveBeenCalledWith('id', 'm-1');
  });

  it('POST /items/:id/reject sets status=rejected and is_public=false', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const updated = { id: 'm-1', status: 'rejected', is_public: false };
    chainFor('media_uploads').mockResolvedValue({ data: updated, error: null });

    const res = await request(app)
      .post(url(TENANT_A, '/items/m-1/reject'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(chainFor('media_uploads').update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', is_public: false })
    );
  });

  it('POST /items/:id/flag sets status=flagged without touching is_public', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const updated = { id: 'm-1', status: 'flagged' };
    chainFor('media_uploads').mockResolvedValue({ data: updated, error: null });

    const res = await request(app)
      .post(url(TENANT_A, '/items/m-1/flag'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    const updateArg = chainFor('media_uploads').update.mock.calls[0][0];
    expect(updateArg.status).toBe('flagged');
    expect(updateArg).not.toHaveProperty('is_public');
  });

  it('POST /items/:id/flag returns 404 when the update matches no row', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('media_uploads').mockResolvedValue({ data: null, error: { message: 'no rows' } });

    const res = await request(app)
      .post(url(TENANT_A, '/items/missing/flag'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
