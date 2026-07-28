/**
 * Tests for src/middleware/auth-supabase-jwt.ts (VTID-01157 / VTID-ORBC).
 *
 * Contract under test:
 *   - requireAuth: valid HS256 token → identity + auth_source + raw claims
 *     attached (incl. vitana_id lookup from app_users and active-day tracking);
 *     missing/malformed/invalid/expired token → 401 UNAUTHENTICATED;
 *     no secrets configured → 401 without ever calling jwtVerify.
 *   - Dual-secret behavior: platform secret first, then LOVABLE_JWT_SECRET
 *     (auth_source='lovable').
 *   - optionalAuth: never blocks; attaches identity only when the token is valid.
 *   - requireExafyAdmin: 401 without identity, 403 without exafy_admin claim.
 *   - requireAdminAuth: combined auth + exafy_admin gating.
 *   - requireTenant / requireAuthWithTenant: tenant from JWT, DB fallback via
 *     user_tenants(is_primary), else 400 TENANT_REQUIRED.
 *   - resolveVitanaId: cached per user, invalidateVitanaIdCache busts the cache.
 */

import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

jest.mock('jose');

// Per-table thenable query-chain mock for the getSupabase() service client
// (used by resolveVitanaId → app_users and requireTenant → user_tenants).
const createChain = () => {
  const responseQueue: any[] = [];
  let defaultData: any = { data: null, error: null };

  const chain: any = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
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

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

jest.mock('../../src/services/guide/active-usage', () => ({
  upsertActiveDay: jest.fn().mockResolvedValue(undefined),
}));

import {
  requireAuth,
  optionalAuth,
  requireExafyAdmin,
  requireTenant,
  requireAuthWithTenant,
  requireAdminAuth,
  resolveVitanaId,
  invalidateVitanaIdCache,
} from '../../src/middleware/auth-supabase-jwt';
import { upsertActiveDay } from '../../src/services/guide/active-usage';

// ---------------------------------------------------------------------------
// App under test — one route per middleware combination
// ---------------------------------------------------------------------------

const echo = (req: any, res: any) =>
  res.json({
    ok: true,
    identity: req.identity ?? null,
    auth_source: req.auth_source ?? null,
    has_raw_claims: !!req.auth_raw_claims,
  });

const app = express();
app.get('/auth', requireAuth, echo);
app.get('/opt', optionalAuth, echo);
app.get('/admin', requireAuth, requireExafyAdmin, echo);
app.get('/admin-auth', requireAdminAuth, echo);
app.get('/tenant', requireAuth, requireTenant, echo);
app.get('/auth-tenant', requireAuthWithTenant, echo);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let subCounter = 0;
/** Unique sub per test — the module-level vitana_id cache persists across tests. */
const uniqueSub = (label: string) => `${label}-${++subCounter}`;

function claims(sub: string, overrides: Record<string, unknown> = {}) {
  return {
    sub,
    email: 'user@example.com',
    role: 'authenticated',
    aud: ['authenticated'],
    exp: 1893456000,
    iat: 1893452400,
    app_metadata: { active_tenant_id: 'tenant-1', exafy_admin: false },
    ...overrides,
  };
}

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt(message = 'signature verification failed') {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error(message));
}

describe('auth-supabase-jwt middleware', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.LOVABLE_JWT_SECRET;
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockInvalidJwt();
  });

  // =========================================================================
  // requireAuth
  // =========================================================================

  describe('requireAuth', () => {
    it('returns 401 UNAUTHENTICATED when the Authorization header is missing', async () => {
      const res = await request(app).get('/auth');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
      expect(jose.jwtVerify).not.toHaveBeenCalled();
    });

    it('returns 401 UNAUTHENTICATED for a non-Bearer Authorization header', async () => {
      const res = await request(app).get('/auth').set('Authorization', 'Token abc');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 401 UNAUTHENTICATED for an invalid/expired token', async () => {
      mockInvalidJwt('"exp" claim timestamp check failed');
      const res = await request(app).get('/auth').set('Authorization', 'Bearer expired');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 401 without calling jwtVerify when no secrets are configured', async () => {
      delete process.env.SUPABASE_JWT_SECRET;
      delete process.env.LOVABLE_JWT_SECRET;

      const res = await request(app).get('/auth').set('Authorization', 'Bearer whatever');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
      expect(jose.jwtVerify).not.toHaveBeenCalled();
    });

    it('attaches identity, raw claims and auth_source=platform for a valid token', async () => {
      const sub = uniqueSub('user');
      mockVerifiedJwt(claims(sub));
      chainFor('app_users').mockResolvedValue({ data: { vitana_id: 'VIT-42' }, error: null });

      const res = await request(app).get('/auth').set('Authorization', 'Bearer good-token');

      expect(res.status).toBe(200);
      expect(res.body.identity).toEqual({
        user_id: sub,
        email: 'user@example.com',
        tenant_id: 'tenant-1',
        exafy_admin: false,
        role: 'authenticated',
        aud: 'authenticated', // first element of the aud array
        exp: 1893456000,
        iat: 1893452400,
        vitana_id: 'VIT-42',
      });
      expect(res.body.auth_source).toBe('platform');
      expect(res.body.has_raw_claims).toBe(true);
      expect(jose.jwtVerify).toHaveBeenCalledWith(
        'good-token',
        expect.anything(),
        expect.objectContaining({ algorithms: ['HS256'] })
      );
      // fire-and-forget active-day tracker got the authenticated user
      expect(upsertActiveDay).toHaveBeenCalledWith(sub);
    });

    it('is null-tolerant on vitana_id when the user has no app_users row', async () => {
      const sub = uniqueSub('no-vitana');
      mockVerifiedJwt(claims(sub));
      chainFor('app_users').mockResolvedValue({ data: null, error: null });

      const res = await request(app).get('/auth').set('Authorization', 'Bearer good-token');
      expect(res.status).toBe(200);
      expect(res.body.identity.vitana_id).toBeNull();
    });

    it('falls back to LOVABLE_JWT_SECRET and reports auth_source=lovable', async () => {
      process.env.LOVABLE_JWT_SECRET = 'lovable-secret';
      const sub = uniqueSub('lovable');
      (jose.jwtVerify as jest.Mock)
        .mockRejectedValueOnce(new Error('signature verification failed')) // platform secret
        .mockResolvedValueOnce({ payload: claims(sub) }); // lovable secret

      const res = await request(app).get('/auth').set('Authorization', 'Bearer lovable-token');

      expect(res.status).toBe(200);
      expect(res.body.auth_source).toBe('lovable');
      expect(jose.jwtVerify).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // optionalAuth
  // =========================================================================

  describe('optionalAuth', () => {
    it('passes through without identity when no token is present', async () => {
      const res = await request(app).get('/opt');
      expect(res.status).toBe(200);
      expect(res.body.identity).toBeNull();
      expect(res.body.auth_source).toBeNull();
    });

    it('passes through without identity when the token is invalid', async () => {
      mockInvalidJwt();
      const res = await request(app).get('/opt').set('Authorization', 'Bearer bad');
      expect(res.status).toBe(200);
      expect(res.body.identity).toBeNull();
    });

    it('attaches identity when a valid token is present', async () => {
      const sub = uniqueSub('opt');
      mockVerifiedJwt(claims(sub));

      const res = await request(app).get('/opt').set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body.identity.user_id).toBe(sub);
      expect(res.body.auth_source).toBe('platform');
    });
  });

  // =========================================================================
  // requireExafyAdmin
  // =========================================================================

  describe('requireExafyAdmin', () => {
    it('returns 403 FORBIDDEN for an authenticated non-admin', async () => {
      mockVerifiedJwt(claims(uniqueSub('plain')));
      const res = await request(app).get('/admin').set('Authorization', 'Bearer good');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    });

    it('allows an exafy_admin through', async () => {
      const sub = uniqueSub('exafy');
      mockVerifiedJwt(
        claims(sub, { app_metadata: { active_tenant_id: 'tenant-1', exafy_admin: true } })
      );
      const res = await request(app).get('/admin').set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body.identity.exafy_admin).toBe(true);
    });

    it('returns 401 when used without a preceding requireAuth (no identity)', () => {
      const req: any = { headers: {} };
      const status = jest.fn().mockReturnThis();
      const json = jest.fn();
      const next = jest.fn();

      requireExafyAdmin(req, { status, json } as any, next);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'UNAUTHENTICATED' }));
      expect(next).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // requireAdminAuth (combined)
  // =========================================================================

  describe('requireAdminAuth', () => {
    it('returns 401 without a token', async () => {
      const res = await request(app).get('/admin-auth');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 403 for a valid non-admin token', async () => {
      mockVerifiedJwt(claims(uniqueSub('aa-plain')));
      const res = await request(app).get('/admin-auth').set('Authorization', 'Bearer good');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('allows a valid exafy_admin token', async () => {
      const sub = uniqueSub('aa-admin');
      mockVerifiedJwt(claims(sub, { app_metadata: { exafy_admin: true } }));
      const res = await request(app).get('/admin-auth').set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body.identity.user_id).toBe(sub);
    });
  });

  // =========================================================================
  // requireTenant / requireAuthWithTenant
  // =========================================================================

  describe('requireTenant', () => {
    it('passes when the JWT carries active_tenant_id', async () => {
      mockVerifiedJwt(claims(uniqueSub('t-jwt')));
      const res = await request(app).get('/tenant').set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body.identity.tenant_id).toBe('tenant-1');
    });

    it('resolves the primary tenant from user_tenants when the JWT lacks one', async () => {
      mockVerifiedJwt(claims(uniqueSub('t-db'), { app_metadata: {} }));
      chainFor('user_tenants').mockResolvedValue({
        data: { tenant_id: 'tenant-from-db' },
        error: null,
      });

      const res = await request(app).get('/tenant').set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body.identity.tenant_id).toBe('tenant-from-db');
      expect(chainFor('user_tenants').eq).toHaveBeenCalledWith('is_primary', true);
    });

    it('returns 400 TENANT_REQUIRED when no tenant exists in JWT or DB', async () => {
      mockVerifiedJwt(claims(uniqueSub('t-none'), { app_metadata: {} }));
      chainFor('user_tenants').mockResolvedValue({ data: null, error: null });

      const res = await request(app).get('/tenant').set('Authorization', 'Bearer good');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: 'TENANT_REQUIRED' });
    });
  });

  describe('requireAuthWithTenant', () => {
    it('returns 401 without a token', async () => {
      const res = await request(app).get('/auth-tenant');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('allows a valid token with a tenant in the JWT', async () => {
      mockVerifiedJwt(claims(uniqueSub('at-ok')));
      const res = await request(app).get('/auth-tenant').set('Authorization', 'Bearer good');
      expect(res.status).toBe(200);
      expect(res.body.identity.tenant_id).toBe('tenant-1');
    });

    it('returns 400 TENANT_REQUIRED when neither JWT nor DB yields a tenant', async () => {
      mockVerifiedJwt(claims(uniqueSub('at-none'), { app_metadata: {} }));
      chainFor('user_tenants').mockResolvedValue({ data: null, error: null });

      const res = await request(app).get('/auth-tenant').set('Authorization', 'Bearer good');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('TENANT_REQUIRED');
    });
  });

  // =========================================================================
  // resolveVitanaId cache behavior
  // =========================================================================

  describe('resolveVitanaId', () => {
    it('returns null for an empty userId without querying', async () => {
      const before = mockSupabase.from.mock.calls.length;
      expect(await resolveVitanaId('')).toBeNull();
      expect(mockSupabase.from.mock.calls.length).toBe(before);
    });

    it('caches the lookup per user and re-queries after invalidation', async () => {
      const sub = uniqueSub('cache');
      chainFor('app_users').mockResolvedValue({ data: { vitana_id: 'VIT-A' }, error: null });

      expect(await resolveVitanaId(sub)).toBe('VIT-A');
      const callsAfterFirst = mockSupabase.from.mock.calls.length;

      // Second call: served from cache, no additional query
      expect(await resolveVitanaId(sub)).toBe('VIT-A');
      expect(mockSupabase.from.mock.calls.length).toBe(callsAfterFirst);

      // Invalidate → next call hits the DB again and sees the new value
      invalidateVitanaIdCache(sub);
      chainFor('app_users').mockResolvedValue({ data: { vitana_id: 'VIT-B' }, error: null });
      expect(await resolveVitanaId(sub)).toBe('VIT-B');
      expect(mockSupabase.from.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });
});
