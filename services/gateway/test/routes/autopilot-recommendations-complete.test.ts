/**
 * VTID-03180: smoke test for POST /api/v1/autopilot/recommendations/:id/complete
 *
 * Regression target: the gateway previously PATCHed a `metadata` column that
 * never existed on autopilot_recommendations, so every /complete returned 400
 * and the row stayed in status='activated'. The frontend (vitana-v1
 * use-autopilot.ts → completeRecommendation) was silently falling back to
 * /reject + a per-user localStorage dismiss set, so the user looked unblocked
 * but the canonical row state never advanced.
 *
 * This test pins the contract:
 *   1. Auth gate: 401 without a user id.
 *   2. Happy path: route calls the new RPC and returns ok:true with reward.
 *   3. Idempotent already_completed pass-through.
 *   4. Status pass-through: RPC error messages map to 404 / 403 / 400.
 *   5. Role can come from either ?role=community OR X-Vitana-Active-Role.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import request from 'supertest';
import express from 'express';

// Stub out modules with import-time side effects so the router can load in
// isolation without hitting Supabase, the recommendation engine, or OASIS.
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/notification-service', () => ({
  notifyUserAsync: jest.fn(),
}));
jest.mock('../../src/services/recommendation-engine', () => ({
  generateRecommendations: jest.fn(),
  generatePersonalRecommendations: jest.fn().mockResolvedValue({ generated: 0 }),
  regenerateCommunityRecommendations: jest.fn().mockResolvedValue({ generated: 0 }),
  SourceType: {},
}));
jest.mock('../../src/services/wave-defaults', () => ({
  DEFAULT_WAVE_CONFIG: {},
  buildTemplateToWaveMap: () => ({}),
}));
// The route now requires a verified identity (security-audit fix: this
// router previously trusted a bare X-User-ID header with no verification).
// Simulate "verified" auth from the same X-User-ID header the tests already
// set, so each test can still act as a distinct user without re-mocking JWT
// verification (which is out of scope for this route-behavior smoke test).
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: jest.fn((req: any, _res: any, next: any) => {
    const userId = req.get('X-User-ID');
    if (userId) {
      req.identity = { user_id: userId, email: null, tenant_id: null, exafy_admin: false, role: 'authenticated', aud: null, exp: null, iat: null };
    }
    next();
  }),
}));
jest.mock('@supabase/supabase-js', () => {
  // Chainable PostgREST-shaped query stub. Each .from() returns the same
  // shape; .like terminates with {data:[]} and .maybeSingle terminates with
  // {data:null} — enough to walk both the milestone branch and the tenant
  // lookup the /complete route now performs.
  const make = () => {
    const chain: any = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.like = () => Promise.resolve({ data: [] });
    chain.maybeSingle = async () => ({ data: null });
    return chain;
  };
  return { createClient: () => ({ from: () => make() }) };
});

const REC_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function mountApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/autopilot-recommendations').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/autopilot/recommendations', router);
  return app;
}

describe('VTID-03180 — POST /:id/complete', () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();

  beforeAll(() => {
    global.fetch = mockFetch as any;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function rpcResponse(payload: any, httpOk = true) {
    return {
      ok: httpOk,
      status: httpOk ? 200 : 400,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  }

  test('401 when no user id is present on the request', async () => {
    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .send({});

    // Rejected by the router-level requireVerifiedIdentity gate (security-audit
    // fix) before the handler's own "User ID required" check is ever reached.
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('happy path: activated -> completed, returns ok:true with reward', async () => {
    mockFetch.mockResolvedValueOnce(
      rpcResponse({
        ok: true,
        recommendation_id: REC_ID,
        title: 'Complete your profile',
        status: 'completed',
        completed_at: '2026-05-29T12:00:00.000Z',
        reward: 10,
        source_ref: 'onboarding_profile',
      }),
    );

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete?role=community`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      recommendation_id: REC_ID,
      status: 'completed',
      reward: 10,
      already_completed: false,
    });

    // RPC was called with the right shape, via PostgREST.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/rest/v1/rpc/complete_autopilot_recommendation');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      p_recommendation_id: REC_ID,
      p_user_id: USER_ID,
    });
  });

  test('role can be supplied via X-Vitana-Active-Role header instead of ?role=', async () => {
    mockFetch.mockResolvedValueOnce(
      rpcResponse({
        ok: true,
        recommendation_id: REC_ID,
        title: 'Engage with matches',
        status: 'completed',
        completed_at: '2026-05-29T12:00:00.000Z',
        reward: 0,
        source_ref: 'engage_matches',
      }),
    );

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .set('X-User-ID', USER_ID)
      .set('X-Vitana-Active-Role', 'community')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reward).toBe(0);
  });

  test('idempotent: already_completed RPC response passes through as 200', async () => {
    mockFetch.mockResolvedValueOnce(
      rpcResponse({
        ok: true,
        already_completed: true,
        recommendation_id: REC_ID,
        title: 'Complete your profile',
        status: 'completed',
        completed_at: '2026-05-29T11:00:00.000Z',
        reward: 0,
        source_ref: 'onboarding_profile',
      }),
    );

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete?role=community`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.already_completed).toBe(true);
  });

  test('404 when RPC reports recommendation not found', async () => {
    mockFetch.mockResolvedValueOnce(
      rpcResponse({ ok: false, error: 'Recommendation not found' }),
    );

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Recommendation not found');
  });

  test('403 when RPC reports the row belongs to another user', async () => {
    mockFetch.mockResolvedValueOnce(
      rpcResponse({ ok: false, error: 'Recommendation belongs to another user' }),
    );

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .set('X-User-ID', OTHER_USER_ID)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  test('400 when the row is not in an activatable -> completable state', async () => {
    mockFetch.mockResolvedValueOnce(
      rpcResponse({ ok: false, error: 'Cannot complete recommendation in status: new' }),
    );

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('Cannot complete recommendation in status');
  });
});
