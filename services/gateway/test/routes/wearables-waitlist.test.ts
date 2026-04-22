import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

// ---------------------------------------------------------------------------
// Supabase chain mock — must be declared before jest.mock() calls
// ---------------------------------------------------------------------------

const createChain = () => {
  const responseQueue: any[] = [];
  let defaultData: any = { data: null, error: null };

  const chain: any = {
    from: jest.fn(() => chain),
    select: jest.fn(() => chain),
    upsert: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
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
    mockClear() {
      responseQueue.length = 0;
      defaultData = { data: null, error: null };
    },
  };

  return chain;
};

const mockChain = createChain();
const mockGetSupabase = jest.fn(() => mockChain as any);

jest.mock('../src/lib/supabase', () => ({
  getSupabase: mockGetSupabase,
}));

jest.mock('jose');

// ---------------------------------------------------------------------------
// App setup — mount the router under the same prefix used in production
// ---------------------------------------------------------------------------

import router from '../src/routes/wearables-waitlist';

const app = express();
app.use(express.json());
app.use('/api/v1/wearables/waitlist', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'Bearer valid.jwt.token';
const INVALID_TOKEN = 'Bearer bad.jwt';

const VALID_CLAIMS_WITH_TENANT = {
  sub: 'user-uuid-001',
  app_metadata: { active_tenant_id: 'tenant-uuid-001' },
};

const VALID_CLAIMS_NO_TENANT = {
  sub: 'user-uuid-002',
  // no app_metadata
};

function mockValidToken(claims: object = VALID_CLAIMS_WITH_TENANT) {
  (jose.decodeJwt as jest.Mock).mockReturnValue(claims);
}

function mockInvalidToken() {
  (jose.decodeJwt as jest.Mock).mockImplementation(() => {
    throw new Error('Invalid JWT');
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wearables Waitlist Routes (VTID-02000)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChain.mockClear();
    mockGetSupabase.mockReturnValue(mockChain);
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/wearables/waitlist
  // -------------------------------------------------------------------------

  describe('POST /api/v1/wearables/waitlist', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const res = await request(app)
        .post('/api/v1/wearables/waitlist')
        .send({ provider: 'fitbit' });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    });

    it('returns 401 when JWT is invalid', async () => {
      mockInvalidToken();

      const res = await request(app)
        .post('/api/v1/wearables/waitlist')
        .set('Authorization', INVALID_TOKEN)
        .send({ provider: 'fitbit' });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    });

    it('returns 503 when DB is unavailable', async () => {
      mockValidToken();
      mockGetSupabase.mockReturnValue(null);

      const res = await request(app)
        .post('/api/v1/wearables/waitlist')
        .set('Authorization', VALID_TOKEN)
        .send({ provider: 'fitbit' });

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ ok: false, error: 'DB_UNAVAILABLE' });
    });

    it('returns 400 when provider is not in the allowed enum', async () => {
      mockValidToken();

      const res = await request(app)
        .post('/api/v1/wearables/waitlist')
        .set('Authorization', VALID_TOKEN)
        .send({ provider: 'invalid_device' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: 'Validation failed' });
      expect(res.body.details).toBeDefined();
    });

    it('returns 200 using tenant_id from JWT claims', async () => {
      mockValidToken(VALID_CLAIMS_WITH_TENANT);

      const fakeEntry = {
        user_id: 'user-uuid-001',
        tenant_id: 'tenant-uuid-001',
        provider: 'fitbit',
        notify_via: 'email',
        created_at: '2026-04-22T00:00:00Z',
      };
      mockChain.mockResolvedValue({ data: fakeEntry, error: null });

      const res = await request(app)
        .post('/api/v1/wearables/waitlist')
        .set('Authorization', VALID_TOKEN)
        .send({ provider: 'fitbit' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, waitlist_entry: fakeEntry });
    });

    it('returns 200 after resolving tenant_id from user_tenants (fallback)', async () => {
      mockValidToken(VALID_CLAIMS_NO_TENANT);

      const tenantRow = { tenant_id: 'tenant-uuid-fallback' };
      const fakeEntry = {
        user_id: 'user-uuid-002',
        tenant_id: 'tenant-uuid-fallback',
        provider: 'oura',
        notify_via: 'email',
        created_at: '2026-04-22T00:00:00Z',
      };

      // First await: user_tenants maybeSingle
      mockChain.mockResolvedValueOnce({ data: tenantRow, error: null });
      // Second await: wearable_waitlist upsert single
      mockChain.mockResolvedValueOnce({ data: fakeEntry, error: null });

      const res = await request(app)
        .post('/api/v1/wearables/waitlist')
        .set('Authorization', VALID_TOKEN)
        .send({ provider: 'oura' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, waitlist_entry: fakeEntry });
    });

    it('returns 400 when tenant not found in JWT or user_tenants', async () => {
      mockValidToken(VALID_CLAIMS_NO_TENANT);

      // user_tenants returns no row
      mockChain.mockResolvedValueOnce({ data: null, error: null });

      const res = await request(app)
        .post('/api/v1/wearables/waitlist')
        .set('Authorization', VALID_TOKEN)
        .send({ provider: 'garmin' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: 'Tenant not found for user' });
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/wearables/waitlist
  // -------------------------------------------------------------------------

  describe('GET /api/v1/wearables/waitlist', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const res = await request(app).get('/api/v1/wearables/waitlist');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    });

    it('returns 503 when DB is unavailable', async () => {
      mockValidToken();
      mockGetSupabase.mockReturnValue(null);

      const res = await request(app)
        .get('/api/v1/wearables/waitlist')
        .set('Authorization', VALID_TOKEN);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ ok: false, error: 'DB_UNAVAILABLE' });
    });

    it('returns 200 with entries array on success', async () => {
      mockValidToken();

      const fakeEntries = [
        { provider: 'fitbit', created_at: '2026-04-22T00:00:00Z', notified_at: null, notify_via: 'email' },
        { provider: 'oura', created_at: '2026-04-22T01:00:00Z', notified_at: null, notify_via: 'push' },
      ];
      mockChain.mockResolvedValue({ data: fakeEntries, error: null });

      const res = await request(app)
        .get('/api/v1/wearables/waitlist')
        .set('Authorization', VALID_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, entries: fakeEntries });
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/wearables/waitlist/:provider
  // -------------------------------------------------------------------------

  describe('DELETE /api/v1/wearables/waitlist/:provider', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const res = await request(app).delete('/api/v1/wearables/waitlist/fitbit');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    });

    it('returns 503 when DB is unavailable', async () => {
      mockValidToken();
      mockGetSupabase.mockReturnValue(null);

      const res = await request(app)
        .delete('/api/v1/wearables/waitlist/fitbit')
        .set('Authorization', VALID_TOKEN);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ ok: false, error: 'DB_UNAVAILABLE' });
    });

    it('returns 200 on successful deletion', async () => {
      mockValidToken();
      mockChain.mockResolvedValue({ data: null, error: null });

      const res = await request(app)
        .delete('/api/v1/wearables/waitlist/fitbit')
        .set('Authorization', VALID_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    });
  });
});