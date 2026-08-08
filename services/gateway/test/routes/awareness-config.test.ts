/**
 * Tests for src/routes/awareness-config.ts
 *
 * Mounted at /api/v1/awareness:
 *   GET  /config       — manifest + overrides + resolved snapshot
 *   GET  /audit         — last N audit rows
 *   POST /config        — upsert one signal
 *   POST /config/bulk   — upsert many signals
 *
 * All endpoints are guarded by requireAdminAuth (jose-verified JWT +
 * exafy_admin=true). Writes go through a raw @supabase/supabase-js
 * service-role client (adminClient()), not the shared getSupabase().
 */
import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Per-table thenable query-chain mock for the route's own adminClient()
// (a raw createClient() from @supabase/supabase-js, distinct from getSupabase()).
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

const mockAdminSupabase = { from: jest.fn((table: string) => chainFor(table)) };
const mockCreateClient = jest.fn(() => mockAdminSupabase as any);

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: any[]) => mockCreateClient(...args),
}));

// getSupabase() is used by requireAdminAuth's resolveVitanaId() lookup —
// keep it inert (app_users lookup returns nothing, vitana_id stays null).
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    })),
  })),
}));

jest.mock('jose');

// Fire-and-forget active-day tracker invoked by requireAdminAuth — keep inert
jest.mock('../../src/services/guide/active-usage', () => ({
  upsertActiveDay: jest.fn().mockResolvedValue(undefined),
}));

const mockGetAwarenessConfig = jest.fn();
const mockInvalidateAwarenessConfigCache = jest.fn();
const mockGetManifest = jest.fn();
const mockGetSignal = jest.fn();

jest.mock('../../src/services/awareness-registry', () => ({
  getAwarenessConfig: (...args: any[]) => mockGetAwarenessConfig(...args),
  invalidateAwarenessConfigCache: (...args: any[]) => mockInvalidateAwarenessConfigCache(...args),
  getManifest: (...args: any[]) => mockGetManifest(...args),
  getSignal: (...args: any[]) => mockGetSignal(...args),
}));

import router from '../../src/routes/awareness-config';

const app = express();
app.use(express.json());
app.use('/api/v1/awareness', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_CLAIMS = {
  sub: 'admin-123',
  email: 'admin@example.com',
  app_metadata: { exafy_admin: true },
};

const NON_ADMIN_CLAIMS = {
  sub: 'user-123',
  email: 'user@example.com',
  app_metadata: { exafy_admin: false },
};

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
}

const SAMPLE_SIGNAL = (overrides: Partial<{ key: string; locked: boolean }> = {}) => ({
  key: overrides.key ?? 'content.music.enabled',
  tier: 'content',
  subcategory: 'Music',
  label: 'Music',
  description: 'Enables music suggestions.',
  default_on: true,
  locked: overrides.locked ?? false,
});

describe('Awareness Config Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockInvalidJwt();
    mockGetManifest.mockReturnValue([SAMPLE_SIGNAL()]);
  });

  // --- Auth Middleware (applies to every endpoint) ---

  const endpoints: Array<{ method: 'get' | 'post'; url: string; body?: object }> = [
    { method: 'get', url: '/api/v1/awareness/config' },
    { method: 'get', url: '/api/v1/awareness/audit' },
    { method: 'post', url: '/api/v1/awareness/config', body: { key: 'x', enabled: true } },
    { method: 'post', url: '/api/v1/awareness/config/bulk', body: { changes: [{ key: 'x', enabled: true }] } },
  ];

  describe('Authorization', () => {
    endpoints.forEach(({ method, url, body }) => {
      it(`returns 401 for ${method.toUpperCase()} ${url} without an Authorization header`, async () => {
        const res = await request(app)[method](url).send(body || {});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('UNAUTHENTICATED');
      });

      it(`returns 401 for ${method.toUpperCase()} ${url} with an invalid token`, async () => {
        mockInvalidJwt();
        const res = await request(app)[method](url).set('Authorization', 'Bearer bad-token').send(body || {});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('UNAUTHENTICATED');
      });

      it(`returns 403 for ${method.toUpperCase()} ${url} when caller is not exafy_admin`, async () => {
        mockVerifiedJwt(NON_ADMIN_CLAIMS);
        const res = await request(app)[method](url).set('Authorization', 'Bearer non-admin-token').send(body || {});
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('FORBIDDEN');
      });
    });
  });

  // --- GET /config ---

  describe('GET /api/v1/awareness/config', () => {
    it('returns manifest + overrides + resolved snapshot', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      mockGetAwarenessConfig.mockResolvedValue({
        overrides: { 'content.music.enabled': { enabled: false, params: {} } },
        resolved: {
          'content.music.enabled': { enabled: false, params: {}, source: 'override' },
        },
        built_at: '2026-07-28T00:00:00.000Z',
      });

      const res = await request(app)
        .get('/api/v1/awareness/config')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.manifest).toEqual([SAMPLE_SIGNAL()]);
      expect(res.body.overrides).toEqual({ 'content.music.enabled': { enabled: false, params: {} } });
      expect(res.body.resolved['content.music.enabled'].source).toBe('override');
      expect(res.body.built_at).toBe('2026-07-28T00:00:00.000Z');
    });

    it('returns 500 when the snapshot builder throws', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      mockGetAwarenessConfig.mockRejectedValue(new Error('snapshot build failed'));

      const res = await request(app)
        .get('/api/v1/awareness/config')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('snapshot build failed');
    });
  });

  // --- GET /audit ---

  describe('GET /api/v1/awareness/audit', () => {
    it('returns audit entries with the default limit of 20', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      const rows = [{ id: 'a1', key: 'content.music.enabled', new_enabled: false }];
      chainFor('awareness_config_audit').mockResolvedValue({ data: rows, error: null });

      const res = await request(app)
        .get('/api/v1/awareness/audit')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.entries).toEqual(rows);
      expect(chainFor('awareness_config_audit').limit).toHaveBeenCalledWith(20);
    });

    it('clamps an over-large limit to 100', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      chainFor('awareness_config_audit').mockResolvedValue({ data: [], error: null });

      await request(app)
        .get('/api/v1/awareness/audit?limit=9999')
        .set('Authorization', 'Bearer admin-token');

      expect(chainFor('awareness_config_audit').limit).toHaveBeenCalledWith(100);
    });

    it('clamps a sub-1 limit up to 1', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      chainFor('awareness_config_audit').mockResolvedValue({ data: [], error: null });

      await request(app)
        .get('/api/v1/awareness/audit?limit=0')
        .set('Authorization', 'Bearer admin-token');

      expect(chainFor('awareness_config_audit').limit).toHaveBeenCalledWith(1);
    });

    it('returns 503 when Supabase is not configured', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      delete process.env.SUPABASE_URL;

      const res = await request(app)
        .get('/api/v1/awareness/audit')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Supabase not configured');
    });

    it('returns 500 on a query error', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      chainFor('awareness_config_audit').mockResolvedValue({ data: null, error: { message: 'audit query failed' } });

      const res = await request(app)
        .get('/api/v1/awareness/audit')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('audit query failed');
    });
  });

  // --- POST /config ---

  describe('POST /api/v1/awareness/config', () => {
    it('returns 400 for an invalid body', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);

      const res = await request(app)
        .post('/api/v1/awareness/config')
        .set('Authorization', 'Bearer admin-token')
        .send({ enabled: true }); // missing key

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid body');
    });

    it('returns 404 for an unknown signal key', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      mockGetSignal.mockReturnValue(undefined);

      const res = await request(app)
        .post('/api/v1/awareness/config')
        .set('Authorization', 'Bearer admin-token')
        .send({ key: 'no.such.signal', enabled: false });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Unknown awareness signal: no.such.signal');
    });

    it('returns 400 when attempting to disable a locked signal', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      mockGetSignal.mockReturnValue(SAMPLE_SIGNAL({ key: 'identity.user_id', locked: true }));

      const res = await request(app)
        .post('/api/v1/awareness/config')
        .set('Authorization', 'Bearer admin-token')
        .send({ key: 'identity.user_id', enabled: false });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Signal identity.user_id is locked and cannot be disabled');
    });

    it('allows re-enabling a locked signal (locked only blocks disabling)', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      mockGetSignal.mockReturnValue(SAMPLE_SIGNAL({ key: 'identity.user_id', locked: true }));
      chainFor('awareness_config').mockResolvedValueOnce({ data: { enabled: true, params: {} }, error: null });
      chainFor('awareness_config').mockResolvedValueOnce({ data: null, error: null });

      const res = await request(app)
        .post('/api/v1/awareness/config')
        .set('Authorization', 'Bearer admin-token')
        .send({ key: 'identity.user_id', enabled: true });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('upserts the signal, writes an audit row, and invalidates the cache', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      mockGetSignal.mockReturnValue(SAMPLE_SIGNAL({ key: 'content.music.enabled' }));
      // 1st await: prevRow select/maybeSingle
      chainFor('awareness_config').mockResolvedValueOnce({ data: { enabled: true, params: { foo: 1 } }, error: null });
      // 2nd await: the upsert itself
      chainFor('awareness_config').mockResolvedValueOnce({ data: null, error: null });

      const res = await request(app)
        .post('/api/v1/awareness/config')
        .set('Authorization', 'Bearer admin-token')
        .send({ key: 'content.music.enabled', enabled: false, params: { foo: 2 } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, key: 'content.music.enabled', enabled: false, params: { foo: 2 } });

      expect(chainFor('awareness_config').upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'content.music.enabled',
          enabled: false,
          params: { foo: 2 },
          updated_by: 'admin-123',
        }),
        { onConflict: 'key' },
      );
      expect(chainFor('awareness_config_audit').insert).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'content.music.enabled',
          prev_enabled: true,
          new_enabled: false,
          prev_params: { foo: 1 },
          new_params: { foo: 2 },
          changed_by: 'admin-123',
        }),
      );
      expect(mockInvalidateAwarenessConfigCache).toHaveBeenCalled();
    });

    it('returns 500 when the upsert fails', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      mockGetSignal.mockReturnValue(SAMPLE_SIGNAL({ key: 'content.music.enabled' }));
      chainFor('awareness_config').mockResolvedValueOnce({ data: null, error: null }); // prevRow
      chainFor('awareness_config').mockResolvedValueOnce({ data: null, error: { message: 'upsert failed' } });

      const res = await request(app)
        .post('/api/v1/awareness/config')
        .set('Authorization', 'Bearer admin-token')
        .send({ key: 'content.music.enabled', enabled: true });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('upsert failed');
      // Cache must not be invalidated on failure
      expect(mockInvalidateAwarenessConfigCache).not.toHaveBeenCalled();
    });
  });

  // --- POST /config/bulk ---

  describe('POST /api/v1/awareness/config/bulk', () => {
    it('returns 400 when changes[] is empty', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);

      const res = await request(app)
        .post('/api/v1/awareness/config/bulk')
        .set('Authorization', 'Bearer admin-token')
        .send({ changes: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid body');
    });

    it('applies valid changes and reports per-key failures for unknown/locked signals', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      mockGetSignal.mockImplementation((key: string) => {
        if (key === 'content.music.enabled') return SAMPLE_SIGNAL({ key });
        if (key === 'identity.user_id') return SAMPLE_SIGNAL({ key, locked: true });
        return undefined; // 'no.such.signal'
      });
      // Only 'content.music.enabled' reaches upsertOne (prevRow + upsert)
      chainFor('awareness_config').mockResolvedValueOnce({ data: null, error: null });
      chainFor('awareness_config').mockResolvedValueOnce({ data: null, error: null });

      const res = await request(app)
        .post('/api/v1/awareness/config/bulk')
        .set('Authorization', 'Bearer admin-token')
        .send({
          changes: [
            { key: 'content.music.enabled', enabled: true },
            { key: 'identity.user_id', enabled: false }, // locked, disabling -> failure
            { key: 'no.such.signal', enabled: true }, // unknown -> failure
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false); // failures present
      expect(res.body.succeeded).toEqual([{ key: 'content.music.enabled', enabled: true }]);
      expect(res.body.failures).toEqual(
        expect.arrayContaining([
          { key: 'identity.user_id', error: 'locked — cannot disable' },
          { key: 'no.such.signal', error: 'unknown signal' },
        ]),
      );
      expect(mockInvalidateAwarenessConfigCache).toHaveBeenCalled();
    });

    it('returns ok:true when every change succeeds', async () => {
      mockVerifiedJwt(ADMIN_CLAIMS);
      mockGetSignal.mockReturnValue(SAMPLE_SIGNAL({ key: 'content.music.enabled' }));
      chainFor('awareness_config').mockResolvedValueOnce({ data: null, error: null });
      chainFor('awareness_config').mockResolvedValueOnce({ data: null, error: null });

      const res = await request(app)
        .post('/api/v1/awareness/config/bulk')
        .set('Authorization', 'Bearer admin-token')
        .send({ changes: [{ key: 'content.music.enabled', enabled: true }] });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.failures).toEqual([]);
    });
  });
});
