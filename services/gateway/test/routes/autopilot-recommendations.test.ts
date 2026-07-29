/**
 * Test suite for src/routes/autopilot-recommendations.ts (VTID-01180 + VTID-01185)
 * Phase 5 of docs/TEST_COVERAGE_PLAN.md — autopilot subsystem.
 *
 * The route file talks to Supabase two ways:
 *   1. Raw `fetch()` calls to the PostgREST/RPC endpoints (queryRecommendationsByRole,
 *      queryRecommendationsFallback, callRpc, activateCommunityAutopilotRecommendation,
 *      emitAlignmentEventForActivation, spec creation, bridge dispatch).
 *   2. `createClient()` from @supabase/supabase-js for a handful of `user_tenants` /
 *      i18n-locale lookups (tenant resolution, resolveRecommendationLocale, milestone
 *      checks).
 *
 * Both are mocked below:
 *   - `global.fetch` is a single jest.fn() whose default implementation resolves
 *     requests against a small in-test stub registry (`stubFetch`), matched from the
 *     END of the registry backwards so test-specific stubs (pushed after the
 *     beforeEach defaults) take priority over generic fallbacks. An unmatched
 *     call throws, which every call site in the source either surfaces as a
 *     structured `{ok:false}` (callRpc / queryRecommendationsByRole, both wrap fetch
 *     in try/catch) or swallows silently (the non-fatal side-effect blocks — alignment
 *     telemetry, spec creation, bridge dispatch, auto-replenish — are all wrapped in
 *     their own try/catch in the source).
 *   - `@supabase/supabase-js`'s `createClient()` returns a shared chainable mock
 *     whose terminal methods (`.maybeSingle()`, `.single()`, `.like()`, bare
 *     `await`) drain a FIFO queue (`queueSupabaseResult`), defaulting to
 *     `{ data: null, error: null }` when the queue is empty.
 *
 * Business-logic modules with real side effects (recommendation-engine,
 * notification-service, oasis-event-service, wave-defaults, calendar-service,
 * the G4 ranker, dev-autopilot-execute) are jest.mock'd wholesale — this suite
 * verifies the ROUTE's contract (status codes, auth/ownership gates, response
 * shape, which downstream fn got called with what), not those modules' internals.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
delete process.env.DEFAULT_TENANT_ID;

import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUserAsync: jest.fn(),
}));

jest.mock('../../src/services/recommendation-engine', () => ({
  generateRecommendations: jest.fn(),
  generatePersonalRecommendations: jest.fn(),
  regenerateCommunityRecommendations: jest.fn(),
  SourceType: {},
}));

jest.mock('../../src/services/wave-defaults', () => ({
  DEFAULT_WAVE_CONFIG: [],
  buildTemplateToWaveMap: () => new Map(),
}));

jest.mock('../../src/services/recommendation-engine/ranking/index-pillar-weighter', () => ({
  buildRankerContext: jest.fn().mockResolvedValue({}),
  rankBatch: jest.fn((recs: any[]) =>
    recs.map((rec) => ({
      rec,
      rank_score: 0,
      pillar_boost: 0,
      compass_boost: 0,
      economic_boost: 0,
      journey_mode: 'steady',
    })),
  ),
}));

jest.mock('../../src/services/dev-autopilot-execute', () => ({
  bridgeActivationToExecution: jest.fn().mockResolvedValue({ ok: true, execution_id: 'exec-1' }),
}));

jest.mock('../../src/services/calendar-service', () => ({
  computeNextAvailableSlot: jest.fn().mockResolvedValue(new Date('2026-08-01T10:00:00.000Z')),
  createCalendarEvent: jest.fn().mockResolvedValue({ id: 'cal-evt-1' }),
}));

jest.mock('@supabase/supabase-js', () => {
  const state: { queue: any[] } = { queue: [] };
  const CHAIN_METHODS = [
    'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'or',
    'order', 'range', 'limit', 'ilike',
  ];

  function nextResult() {
    if (state.queue.length > 0) return state.queue.shift();
    return { data: null, error: null };
  }

  function makeChain(): any {
    const chain: any = {};
    CHAIN_METHODS.forEach((m) => {
      chain[m] = jest.fn(() => chain);
    });
    chain.like = jest.fn(() => Promise.resolve(nextResult()));
    chain.maybeSingle = jest.fn(() => Promise.resolve(nextResult()));
    chain.single = jest.fn(() => Promise.resolve(nextResult()));
    chain.then = (resolve: any, reject: any) => Promise.resolve(nextResult()).then(resolve, reject);
    return chain;
  }

  const client = { from: jest.fn(() => makeChain()) };

  return {
    createClient: jest.fn(() => client),
    __supabaseMockState: state,
  };
});

import { emitOasisEvent } from '../../src/services/oasis-event-service';
import { notifyUserAsync } from '../../src/services/notification-service';
import {
  generateRecommendations,
  generatePersonalRecommendations,
  regenerateCommunityRecommendations,
} from '../../src/services/recommendation-engine';
import { bridgeActivationToExecution } from '../../src/services/dev-autopilot-execute';
import * as supabaseJsMock from '@supabase/supabase-js';

const mockEmitOasisEvent = emitOasisEvent as jest.Mock;
const mockNotifyUserAsync = notifyUserAsync as jest.Mock;
const mockGenerateRecommendations = generateRecommendations as jest.Mock;
const mockGeneratePersonalRecommendations = generatePersonalRecommendations as jest.Mock;
const mockRegenerateCommunityRecommendations = regenerateCommunityRecommendations as jest.Mock;
const mockBridgeActivationToExecution = bridgeActivationToExecution as jest.Mock;

function queueSupabaseResult(data: any, error: any = null) {
  (supabaseJsMock as any).__supabaseMockState.queue.push({ data, error });
}

// ---------------------------------------------------------------------------
// Fetch stub registry
// ---------------------------------------------------------------------------

type StubMatcher = (url: string, init: any) => boolean;
interface FetchStub {
  match: StubMatcher;
  status: number;
  body: any;
  contentRange?: string;
}

let fetchStubs: FetchStub[] = [];

function stubFetch(match: StubMatcher, body: any, opts: { status?: number; contentRange?: string } = {}) {
  fetchStubs.push({ match, body, status: opts.status ?? 200, contentRange: opts.contentRange });
}

function methodIs(m: string): StubMatcher {
  return (_url, init) => (init?.method || 'GET').toUpperCase() === m.toUpperCase();
}
function urlHas(...subs: string[]): StubMatcher {
  return (url) => subs.every((s) => url.includes(s));
}
function and(...matchers: StubMatcher[]): StubMatcher {
  return (url, init) => matchers.every((m) => m(url, init));
}
function not(matcher: StubMatcher): StubMatcher {
  return (url, init) => !matcher(url, init);
}

function findStub(url: string, init: any): FetchStub | undefined {
  for (let i = fetchStubs.length - 1; i >= 0; i--) {
    if (fetchStubs[i].match(url, init)) return fetchStubs[i];
  }
  return undefined;
}

const mockFetch = jest.fn();

function defaultFetchImpl(url: any, init?: any) {
  const urlStr = String(url);
  const stub = findStub(urlStr, init);
  if (!stub) {
    return Promise.reject(new Error(`Unhandled fetch: ${init?.method || 'GET'} ${urlStr}`));
  }
  const status = stub.status;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(stub.body),
    json: async () => stub.body,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-range' ? stub.contentRange ?? null : null),
    },
  } as any);
}

const originalFetch = global.fetch;

beforeAll(() => {
  global.fetch = mockFetch as any;
});

afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  mockFetch.mockImplementation(defaultFetchImpl);
  fetchStubs = [];
  (supabaseJsMock as any).__supabaseMockState.queue = [];
  process.env.SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
  delete process.env.DEFAULT_TENANT_ID;

  // Sane, non-crashing defaults for the mocked recommendation-engine async fns —
  // several call sites in the route are fire-and-forget (`.catch(...)` chained
  // directly onto the call, uncalled with `await`) or destructure the result
  // without optional chaining, so an unconfigured jest.fn() returning `undefined`
  // would throw synchronously and mask the actual behavior under test. Individual
  // tests override with `mockResolvedValueOnce` where the return value matters.
  mockRegenerateCommunityRecommendations.mockResolvedValue({ ok: true, generated: 0 });
  mockGeneratePersonalRecommendations.mockResolvedValue({
    ok: true, generated: 0, duplicates_skipped: 0, errors: [], duration_ms: 1, analysis_summary: {}, run_id: 'r',
  });
  mockGenerateRecommendations.mockResolvedValue({
    ok: true, generated: 0, duplicates_skipped: 0, errors: [], duration_ms: 1, analysis_summary: {}, run_id: 'r',
  });
});

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------

function mountApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/autopilot-recommendations').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/autopilot/recommendations', router);
  return app;
}

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REC_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// =============================================================================
// GET /recommendations
// =============================================================================

describe('GET /api/v1/autopilot/recommendations', () => {
  it('no role: uses the RPC fallback path and returns annotated recommendations', async () => {
    stubFetch(
      and(methodIs('POST'), urlHas('/rpc/get_autopilot_recommendations')),
      [
        { id: 'r1', title: 'Rec One', status: 'new', contribution_vector: null },
        { id: 'r2', title: 'Rec Two', status: 'new', contribution_vector: null },
      ],
    );

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body._debug.queryPath).toBe('rpc');
    expect(res.body.count).toBe(2);
    expect(res.body.has_more).toBe(false);
    // annotateWithPillarImpact stamps identity metadata on every row
    expect(res.body.recommendations[0]).toMatchObject({
      id: 'r1',
      recommended_by: 'vitana',
      visual_identity: 'orb',
      pillar_impact: { primary_pillar: null, magnitude: 'none' },
    });
  });

  it('no role: computes has_more when RPC returns more than limit+1 rows', async () => {
    stubFetch(
      and(methodIs('POST'), urlHas('/rpc/get_autopilot_recommendations')),
      [
        { id: 'r1', title: 'A', status: 'new' },
        { id: 'r2', title: 'B', status: 'new' },
        { id: 'r3', title: 'C', status: 'new' },
      ],
    );

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.has_more).toBe(true);
    expect(res.body.recommendations).toHaveLength(2);
  });

  it('no role: RPC transport failure returns 400', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/get_autopilot_recommendations')), { message: 'boom' }, { status: 500 });

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('role=developer: queries by role directly (system-wide, non-community source)', async () => {
    stubFetch(
      and(methodIs('GET'), urlHas('/autopilot_recommendations', 'source_type=neq.community', 'user_id=is.null')),
      [{ id: 'dev-1', title: 'Dev Rec', status: 'new', source_ref: null }],
      { contentRange: '0-0/1' },
    );

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations?role=developer');

    expect(res.status).toBe(200);
    expect(res.body._debug.queryPath).toBe('role-based');
    expect(res.body.recommendations).toHaveLength(1);
    expect(res.body.recommendations[0].id).toBe('dev-1');
  });

  it('role=community, no user id: short-circuits to an empty list without calling fetch', async () => {
    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations?role=community');

    expect(res.status).toBe(200);
    expect(res.body.recommendations).toEqual([]);
    expect(res.body.count).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('role=community with user id: returns the community rec with wave/horizon enrichment', async () => {
    stubFetch(
      and(methodIs('GET'), urlHas('/autopilot_recommendations', 'source_type=eq.community', `user_id=eq.${USER_ID}`)),
      [{ id: 'com-1', title: 'onboarding_profile', status: 'new', source_ref: 'onboarding_profile' }],
      { contentRange: '0-0/1' },
    );

    const app = mountApp();
    const res = await request(app)
      .get('/api/v1/autopilot/recommendations?role=community')
      .set('X-User-ID', USER_ID);

    expect(res.status).toBe(200);
    expect(res.body.recommendations).toHaveLength(1);
    expect(res.body.recommendations[0]).toMatchObject({ id: 'com-1', wave_id: 'wave-1', horizon: 'today' });
    expect(res.body.waves).toEqual([]);
  });

  it('role=community: retired-action recs (unknown source_ref) are filtered out', async () => {
    stubFetch(
      and(methodIs('GET'), urlHas('/autopilot_recommendations', 'source_type=eq.community')),
      [
        { id: 'retired-1', title: 'Organize a meetup', status: 'new', source_ref: 'organize_meetup' },
        { id: 'valid-1', title: 'Complete profile', status: 'new', source_ref: 'onboarding_profile' },
      ],
    );

    const app = mountApp();
    const res = await request(app)
      .get('/api/v1/autopilot/recommendations?role=community')
      .set('X-User-ID', USER_ID);

    expect(res.status).toBe(200);
    const ids = res.body.recommendations.map((r: any) => r.id);
    expect(ids).toEqual(['valid-1']);
  });

  it('role=community: falls back to the no-source_type query when the primary query is empty, then dedups', async () => {
    stubFetch(
      and(methodIs('GET'), urlHas('/autopilot_recommendations', 'source_type=eq.community')),
      [],
      { contentRange: '0-0/0' },
    );
    stubFetch(
      and(methodIs('GET'), urlHas('/autopilot_recommendations', `user_id=eq.${USER_ID}`), not(urlHas('source_type=eq.community'))),
      [{ id: 'fallback-1', title: 'Fallback Rec', status: 'new', source_ref: 'onboarding_avatar' }],
    );

    const app = mountApp();
    const res = await request(app)
      .get('/api/v1/autopilot/recommendations?role=community')
      .set('X-User-ID', USER_ID);

    expect(res.status).toBe(200);
    expect(res.body.recommendations).toHaveLength(1);
    expect(res.body.recommendations[0].id).toBe('fallback-1');
    expect(res.body._debug.fallbackUsed).toBe(true);
  });

  it('role=community: auto-generates when queue has zero "new" recs, and re-fetches on success', async () => {
    // Primary query returns only an activated rec — no 'new' status present.
    stubFetch(
      and(methodIs('GET'), urlHas('/autopilot_recommendations', 'source_type=eq.community')),
      [{ id: 'old-1', title: 'Old', status: 'activated', source_ref: 'onboarding_profile' }],
    );
    // Tenant lookup for auto-generation.
    queueSupabaseResult({ tenant_id: TENANT_ID });
    mockGeneratePersonalRecommendations.mockResolvedValueOnce({ ok: true, generated: 1, duplicates_skipped: 0 });

    const app = mountApp();
    const res = await request(app)
      .get('/api/v1/autopilot/recommendations?role=community')
      .set('X-User-ID', USER_ID);

    expect(res.status).toBe(200);
    expect(mockGeneratePersonalRecommendations).toHaveBeenCalledWith(
      USER_ID,
      TENANT_ID,
      expect.objectContaining({ trigger_type: 'auto_replenish' }),
    );
    // Falls back to serving the pre-existing (activated) rows since genResult.generated>0
    // triggers a re-fetch that (by default, unstubbed beyond the once-registered stub) hits
    // the same stubbed URL again — supertest response should still be 200 ok.
    expect(res.body.ok).toBe(true);
  });

  it('role-based: RPC-equivalent transport failure returns 400', async () => {
    stubFetch(and(methodIs('GET'), urlHas('/autopilot_recommendations')), { message: 'db down' }, { status: 500 });

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations?role=developer');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('clamps limit to [1,100] and offset to >=0', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/get_autopilot_recommendations')), []);

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations?limit=99999&offset=-5');

    expect(res.status).toBe(200);
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.p_limit).toBe(101); // 100 + 1 lookahead row
    expect(body.p_offset).toBe(0);
  });
});

// =============================================================================
// GET /recommendations/count
// =============================================================================

describe('GET /api/v1/autopilot/recommendations/count', () => {
  it('no role: returns the RPC count', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/get_autopilot_recommendations_count')), 7);

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations/count');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, count: 7 });
  });

  it('no role: RPC failure returns 400', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/get_autopilot_recommendations_count')), { message: 'x' }, { status: 500 });

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations/count');

    expect(res.status).toBe(400);
  });

  it('role-based: returns count derived from the content-range header', async () => {
    stubFetch(
      and(methodIs('GET'), urlHas('/autopilot_recommendations', 'source_type=neq.community')),
      [],
      { contentRange: '0-0/42' },
    );

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations/count?role=developer');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(42);
    expect(res.body._debug).toEqual({ role: 'developer', userId: null, queryPath: 'role-based' });
  });

  it('role-based: transport failure degrades to count=0, not an error', async () => {
    stubFetch(and(methodIs('GET'), urlHas('/autopilot_recommendations')), { message: 'x' }, { status: 500 });

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations/count?role=community').set('X-User-ID', USER_ID);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
});

// =============================================================================
// POST /recommendations/generate-personal
// =============================================================================

describe('POST /api/v1/autopilot/recommendations/generate-personal', () => {
  it('401 when no user id is present', async () => {
    const app = mountApp();
    const res = await request(app).post('/api/v1/autopilot/recommendations/generate-personal').send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'User ID required' });
  });

  it('503 when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;

    const app = mountApp();
    const res = await request(app)
      .post('/api/v1/autopilot/recommendations/generate-personal')
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(503);
  });

  it('400 when the user has no resolvable tenant', async () => {
    queueSupabaseResult(null); // user_tenants lookup -> no row, no DEFAULT_TENANT_ID either

    const app = mountApp();
    const res = await request(app)
      .post('/api/v1/autopilot/recommendations/generate-personal')
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No tenant found for user');
  });

  it('happy path: resolves tenant then delegates to generatePersonalRecommendations', async () => {
    queueSupabaseResult({ tenant_id: TENANT_ID });
    mockGeneratePersonalRecommendations.mockResolvedValueOnce({
      ok: true,
      run_id: 'run-1',
      generated: 3,
      duplicates_skipped: 1,
      errors: [],
      duration_ms: 120,
      analysis_summary: {},
    });

    const app = mountApp();
    const res = await request(app)
      .post('/api/v1/autopilot/recommendations/generate-personal')
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, generated: 3, duplicates_skipped: 1, vtid: 'VTID-01185' });
    expect(mockGeneratePersonalRecommendations).toHaveBeenCalledWith(
      USER_ID,
      TENANT_ID,
      expect.objectContaining({ trigger_type: 'manual' }),
    );
  });

  it('falls back to DEFAULT_TENANT_ID when no primary tenant row exists', async () => {
    process.env.DEFAULT_TENANT_ID = 'default-tenant';
    queueSupabaseResult(null);
    mockGeneratePersonalRecommendations.mockResolvedValueOnce({ ok: true, generated: 0, duplicates_skipped: 0, errors: [], duration_ms: 1, analysis_summary: {}, run_id: 'r' });

    const app = mountApp();
    const res = await request(app)
      .post('/api/v1/autopilot/recommendations/generate-personal')
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(200);
    expect(mockGeneratePersonalRecommendations).toHaveBeenCalledWith(USER_ID, 'default-tenant', expect.anything());
  });

  it('returns 500 when generation itself fails', async () => {
    queueSupabaseResult({ tenant_id: TENANT_ID });
    mockGeneratePersonalRecommendations.mockResolvedValueOnce({
      ok: false,
      run_id: 'r',
      generated: 0,
      duplicates_skipped: 0,
      errors: [{ source: 'community', error: 'analyzer crashed' }],
      duration_ms: 1,
      analysis_summary: {},
    });

    const app = mountApp();
    const res = await request(app)
      .post('/api/v1/autopilot/recommendations/generate-personal')
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

// =============================================================================
// POST /recommendations/:id/activate
// =============================================================================

describe('POST /api/v1/autopilot/recommendations/:id/activate', () => {
  describe('community role', () => {
    it('503 when Supabase is not configured', async () => {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE;

      const app = mountApp();
      const res = await request(app)
        .post(`/api/v1/autopilot/recommendations/${REC_ID}/activate?role=community`)
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(503);
    });

    it('404 when the recommendation does not exist', async () => {
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), []);

      const app = mountApp();
      const res = await request(app)
        .post(`/api/v1/autopilot/recommendations/${REC_ID}/activate?role=community`)
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Recommendation not found');
    });

    it('403 when the rec is not a community-sourced recommendation', async () => {
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), [
        { id: REC_ID, title: 'Roadmap item', source_type: 'roadmap', user_id: null, status: 'new' },
      ]);

      const app = mountApp();
      const res = await request(app)
        .post(`/api/v1/autopilot/recommendations/${REC_ID}/activate?role=community`)
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Not a community recommendation');
    });

    it('403 when the rec belongs to another user (cross-user isolation)', async () => {
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), [
        { id: REC_ID, title: 'Onboarding', source_type: 'community', source_ref: 'onboarding_profile', user_id: USER_ID, status: 'new' },
      ]);

      const app = mountApp();
      const res = await request(app)
        .post(`/api/v1/autopilot/recommendations/${REC_ID}/activate?role=community`)
        .set('X-User-ID', OTHER_USER_ID)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Recommendation belongs to another user');
    });

    it('400 when the rec is not in an activatable state', async () => {
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), [
        { id: REC_ID, title: 'Done already', source_type: 'community', source_ref: 'onboarding_profile', user_id: USER_ID, status: 'rejected' },
      ]);

      const app = mountApp();
      const res = await request(app)
        .post(`/api/v1/autopilot/recommendations/${REC_ID}/activate?role=community`)
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot activate recommendation in status');
    });

    it('200 idempotent when already activated', async () => {
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), [
        { id: REC_ID, title: 'Complete profile', source_type: 'community', source_ref: 'onboarding_profile', user_id: USER_ID, status: 'activated' },
      ]);

      const app = mountApp();
      const res = await request(app)
        .post(`/api/v1/autopilot/recommendations/${REC_ID}/activate?role=community`)
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.already_activated).toBe(true);
      expect(res.body.action_type).toBe('navigate');
      expect(res.body.target).toBe('/profile/edit');
    });

    it('happy path: patches status, emits OASIS, and returns the navigate action', async () => {
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), [
        { id: REC_ID, title: 'Complete profile', source_type: 'community', source_ref: 'onboarding_profile', user_id: USER_ID, status: 'new' },
      ]);
      stubFetch(and(methodIs('PATCH'), urlHas(`id=eq.${REC_ID}`)), {}, { status: 200 });
      stubFetch(and(methodIs('GET'), urlHas('status=eq.new', 'limit=1')), [{ id: 'still-new' }]); // replenish-check: queue not empty

      const app = mountApp();
      const res = await request(app)
        .post(`/api/v1/autopilot/recommendations/${REC_ID}/activate?role=community`)
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        recommendation_id: REC_ID,
        status: 'activated',
        action_type: 'navigate',
        target: '/profile/edit',
        completion_message: "Let's complete your profile!",
        replenished: 0,
      });
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'autopilot.recommendation.activated', payload: expect.objectContaining({ recommendation_id: REC_ID }) }),
      );
      const patchCall = mockFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      expect(JSON.parse(String(patchCall![1].body))).toMatchObject({ status: 'activated' });
    });

    it('creates a calendar event for actions that declare calendar_event metadata', async () => {
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), [
        { id: REC_ID, title: 'Attend a meetup', source_type: 'community', source_ref: 'engage_meetup', user_id: USER_ID, status: 'new' },
      ]);
      stubFetch(and(methodIs('PATCH'), urlHas(`id=eq.${REC_ID}`)), {}, { status: 200 });
      stubFetch(and(methodIs('GET'), urlHas('status=eq.new', 'limit=1')), []);

      const { createCalendarEvent } = require('../../src/services/calendar-service');
      const app = mountApp();
      const res = await request(app)
        .post(`/api/v1/autopilot/recommendations/${REC_ID}/activate?role=community`)
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.calendar_event_id).toBe('cal-evt-1');
      expect(createCalendarEvent).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ event_type: 'community', source_ref_id: REC_ID }),
      );
    });

    it('auto-replenishes when this was the last "new" recommendation', async () => {
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), [
        { id: REC_ID, title: 'Complete profile', source_type: 'community', source_ref: 'onboarding_profile', user_id: USER_ID, status: 'new' },
      ]);
      stubFetch(and(methodIs('PATCH'), urlHas(`id=eq.${REC_ID}`)), {}, { status: 200 });
      stubFetch(and(methodIs('GET'), urlHas('status=eq.new', 'limit=1')), []); // queue now empty
      mockGeneratePersonalRecommendations.mockResolvedValueOnce({ generated: 2 });

      const app = mountApp();
      const res = await request(app)
        .post(`/api/v1/autopilot/recommendations/${REC_ID}/activate?role=community`)
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.replenished).toBe(2);
      expect(mockGeneratePersonalRecommendations).toHaveBeenCalledWith(
        USER_ID,
        '',
        expect.objectContaining({ trigger_type: 'auto_replenish' }),
      );
    });
  });

  describe('developer/admin (VTID-creating) role', () => {
    it('400 when the RPC transport fails', async () => {
      stubFetch(and(methodIs('POST'), urlHas('/rpc/activate_autopilot_recommendation')), { message: 'x' }, { status: 500 });

      const app = mountApp();
      const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/activate`).send({});

      expect(res.status).toBe(400);
    });

    it('400 when the RPC reports a business-logic failure', async () => {
      stubFetch(and(methodIs('POST'), urlHas('/rpc/activate_autopilot_recommendation')), { ok: false, error: 'already rejected' });

      const app = mountApp();
      const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/activate`).send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('already rejected');
    });

    it('happy path: creates a VTID, emits OASIS event, and returns vtid_ref', async () => {
      stubFetch(
        and(methodIs('POST'), urlHas('/rpc/activate_autopilot_recommendation')),
        { ok: true, vtid: 'VTID-09999', recommendation_id: REC_ID, title: 'Improve caching', status: 'activated', already_activated: false },
      );
      // Non-essential side-fetches (alignment lookup, spec-creation lookup, bridge
      // source_type lookup) all key off `id=eq.<REC_ID>` with varying `select=`
      // clauses; defaulting them all to [] makes each of those blocks no-op safely.
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), []);

      const app = mountApp();
      const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/activate`).send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, vtid: 'VTID-09999', vtid_ref: 'VTID-01180' });
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'autopilot.recommendation.activated', vtid: 'VTID-09999' }),
      );
    });

    it('already_activated: skips alignment/spec/bridge side effects', async () => {
      stubFetch(
        and(methodIs('POST'), urlHas('/rpc/activate_autopilot_recommendation')),
        { ok: true, vtid: 'VTID-09999', recommendation_id: REC_ID, title: 'Improve caching', status: 'activated', already_activated: true },
      );

      const app = mountApp();
      const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/activate`).send({});

      expect(res.status).toBe(200);
      expect(res.body.already_activated).toBe(true);
      // Only the RPC call itself — no id=eq.<id> GET lookups for alignment/spec/bridge.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('creates an oasis_specs draft from the recommendation snapshot on fresh activation', async () => {
      stubFetch(
        and(methodIs('POST'), urlHas('/rpc/activate_autopilot_recommendation')),
        { ok: true, vtid: 'VTID-09999', recommendation_id: REC_ID, title: 'Improve caching', status: 'activated', already_activated: false },
      );
      // Generic catch-all registered FIRST: the fetch router prefers the LAST
      // matching stub, so this must come before the more specific one below in
      // order for the specific one to win.
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), []); // alignment + bridge lookups fall back to []
      stubFetch(
        and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`, 'select=title,summary,domain,risk_level,impact_score,effort_score,spec_snapshot')),
        [{ title: 'Improve caching', summary: 'Speeds up p95', domain: 'infra', risk_level: 'low', impact_score: 7, effort_score: 3, spec_snapshot: {} }],
      );
      stubFetch(and(methodIs('POST'), urlHas('/rest/v1/oasis_specs')), [{ id: 'spec-1' }]);
      stubFetch(and(methodIs('PATCH'), urlHas('/rest/v1/vtid_ledger')), {});

      const app = mountApp();
      const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/activate`).send({});

      expect(res.status).toBe(200);
      const specInsertCall = mockFetch.mock.calls.find(([url, init]) => String(url).includes('/rest/v1/oasis_specs') && init?.method === 'POST');
      expect(specInsertCall).toBeDefined();
      const specBody = JSON.parse(String(specInsertCall![1].body));
      expect(specBody.vtid).toBe('VTID-09999');
      expect(specBody.status).toBe('draft');
    });

    it('dispatches to the executor bridge for dev_autopilot-sourced recs', async () => {
      stubFetch(
        and(methodIs('POST'), urlHas('/rpc/activate_autopilot_recommendation')),
        { ok: true, vtid: 'VTID-09999', recommendation_id: REC_ID, title: 'Fix flaky test', status: 'activated', already_activated: false },
      );
      stubFetch(and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`)), []); // alignment + spec-snapshot lookups -> []
      stubFetch(
        and(methodIs('GET'), urlHas(`id=eq.${REC_ID}`, 'select=source_type')),
        [{ source_type: 'dev_autopilot' }],
      );

      const app = mountApp();
      const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/activate`).send({});

      expect(res.status).toBe(200);
      // Fire-and-forget: flush microtasks so the .then() chain resolves before asserting.
      await new Promise((r) => setImmediate(r));
      expect(mockBridgeActivationToExecution).toHaveBeenCalledWith(REC_ID, null);
    });
  });
});

// =============================================================================
// POST /recommendations/:id/reject
// =============================================================================

describe('POST /api/v1/autopilot/recommendations/:id/reject', () => {
  it('happy path: passes reason through to the RPC', async () => {
    stubFetch(
      and(methodIs('POST'), urlHas('/rpc/reject_autopilot_recommendation')),
      { ok: true, recommendation_id: REC_ID, status: 'rejected' },
    );

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/reject`)
      .send({ reason: 'not relevant' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(init.body))).toEqual({ p_recommendation_id: REC_ID, p_reason: 'not relevant' });
  });

  it('400 on RPC transport failure', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/reject_autopilot_recommendation')), { message: 'x' }, { status: 500 });

    const app = mountApp();
    const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/reject`).send({});

    expect(res.status).toBe(400);
  });

  it('400 when the RPC reports a business-logic failure', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/reject_autopilot_recommendation')), { ok: false, error: 'not found' });

    const app = mountApp();
    const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/reject`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not found');
  });

  it('community role: fires a fire-and-forget guarded regeneration', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/reject_autopilot_recommendation')), { ok: true, recommendation_id: REC_ID });
    mockRegenerateCommunityRecommendations.mockResolvedValueOnce({ ok: true, generated: 0, reason: 'cooldown' });

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/reject?role=community`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(200);
    expect(mockRegenerateCommunityRecommendations).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ requireEmptyQueue: true, trigger_type: 'auto_replenish' }),
    );
  });
});

// =============================================================================
// POST /recommendations/:id/snooze
// =============================================================================

describe('POST /api/v1/autopilot/recommendations/:id/snooze', () => {
  it('happy path: defaults to 24 hours', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/snooze_autopilot_recommendation')), { ok: true, snoozed_until: 'later' });

    const app = mountApp();
    const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/snooze`).send({});

    expect(res.status).toBe(200);
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(init.body))).toEqual({ p_recommendation_id: REC_ID, p_hours: 24 });
  });

  it('clamps hours to [1,168]', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/snooze_autopilot_recommendation')), { ok: true });

    const app = mountApp();
    const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/snooze`).send({ hours: 100000 });

    expect(res.status).toBe(200);
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(init.body)).p_hours).toBe(168);
  });

  it('400 on RPC transport failure', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/snooze_autopilot_recommendation')), { message: 'x' }, { status: 500 });

    const app = mountApp();
    const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/snooze`).send({});

    expect(res.status).toBe(400);
  });

  it('400 when the RPC reports a business-logic failure', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/snooze_autopilot_recommendation')), { ok: false, error: 'not found' });

    const app = mountApp();
    const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/snooze`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not found');
  });
});

// =============================================================================
// POST /recommendations/generate
// =============================================================================

describe('POST /api/v1/autopilot/recommendations/generate', () => {
  describe('role=community', () => {
    it('401 when no user id present', async () => {
      const app = mountApp();
      const res = await request(app).post('/api/v1/autopilot/recommendations/generate?role=community').send({});

      expect(res.status).toBe(401);
    });

    it('500 when regeneration fails', async () => {
      mockRegenerateCommunityRecommendations.mockResolvedValueOnce({ ok: false, generated: 0, error: 'db error' });

      const app = mountApp();
      const res = await request(app)
        .post('/api/v1/autopilot/recommendations/generate?role=community')
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('db error');
    });

    it('200 with generated=0 and a reason when the guard fires', async () => {
      mockRegenerateCommunityRecommendations.mockResolvedValueOnce({ ok: true, generated: 0, reason: 'disabled' });

      const app = mountApp();
      const res = await request(app)
        .post('/api/v1/autopilot/recommendations/generate?role=community')
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, generated: 0, reason: 'disabled', recommendations: [] });
    });

    it('200 with a fresh batch on success', async () => {
      mockRegenerateCommunityRecommendations.mockResolvedValueOnce({ ok: true, generated: 2, run_id: 'run-2' });
      stubFetch(
        and(methodIs('GET'), urlHas('/autopilot_recommendations', 'source_type=eq.community')),
        [{ id: 'fresh-1', title: 'Fresh', status: 'new', source_ref: 'onboarding_profile' }],
      );

      const app = mountApp();
      const res = await request(app)
        .post('/api/v1/autopilot/recommendations/generate?role=community')
        .set('X-User-ID', USER_ID)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.generated).toBe(2);
      expect(res.body.recommendations).toHaveLength(1);
      expect(res.body.run_id).toBe('run-2');
    });
  });

  describe('developer/admin (analyzer-sourced) generation', () => {
    it('400 when no valid sources are given', async () => {
      const app = mountApp();
      const res = await request(app)
        .post('/api/v1/autopilot/recommendations/generate')
        .send({ sources: ['not-a-real-source'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No valid sources specified');
    });

    it('happy path: runs generation, emits start/completion OASIS events', async () => {
      mockGenerateRecommendations.mockResolvedValueOnce({
        ok: true,
        run_id: 'run-3',
        generated: 5,
        duplicates_skipped: 1,
        errors: [],
        duration_ms: 900,
        analysis_summary: {},
      });

      const app = mountApp();
      const res = await request(app)
        .post('/api/v1/autopilot/recommendations/generate')
        .send({ sources: ['codebase'] });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, generated: 5, vtid: 'VTID-01185' });
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'autopilot.recommendation.generation.started' }));
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'autopilot.recommendation.generation.completed' }));
    });

    it('500 when generation fails, emits a failure OASIS event', async () => {
      mockGenerateRecommendations.mockResolvedValueOnce({
        ok: false,
        run_id: 'run-4',
        generated: 0,
        duplicates_skipped: 0,
        errors: [{ source: 'oasis', error: 'timeout' }],
        duration_ms: 10,
        analysis_summary: {},
      });

      const app = mountApp();
      const res = await request(app)
        .post('/api/v1/autopilot/recommendations/generate')
        .send({ sources: ['oasis'] });

      expect(res.status).toBe(500);
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'autopilot.recommendation.generation.failed' }));
    });

    it('notifies the triggering user and surfaces a high-impact rec when generated>0', async () => {
      mockGenerateRecommendations.mockResolvedValueOnce({
        ok: true,
        run_id: 'run-5',
        generated: 2,
        duplicates_skipped: 0,
        errors: [],
        duration_ms: 10,
        analysis_summary: {},
      });
      queueSupabaseResult({ tenant_id: TENANT_ID }); // user_tenants .single()
      queueSupabaseResult([{ id: 'hi-1', title: 'Critical fix', summary: 'Do it now', impact_score: 9 }]); // high-impact query

      const app = mountApp();
      const res = await request(app)
        .post('/api/v1/autopilot/recommendations/generate')
        .set('X-User-ID', USER_ID)
        .send({ sources: ['codebase'] });

      expect(res.status).toBe(200);
      expect(mockNotifyUserAsync).toHaveBeenCalledWith(
        USER_ID, TENANT_ID, 'new_recommendation', expect.objectContaining({ title: expect.stringContaining('2') }), expect.anything(),
      );
      expect(mockNotifyUserAsync).toHaveBeenCalledWith(
        USER_ID, TENANT_ID, 'high_impact_recommendation', expect.objectContaining({ title: 'Critical fix' }), expect.anything(),
      );
    });
  });
});

// =============================================================================
// GET /recommendations/sources
// =============================================================================

describe('GET /api/v1/autopilot/recommendations/sources', () => {
  it('happy path: maps analyzer source rows', async () => {
    stubFetch(
      and(methodIs('POST'), urlHas('/rpc/get_autopilot_analyzer_sources')),
      [{ source_type: 'codebase', status: 'ready', enabled: true, last_scan_at: '2026-07-01T00:00:00Z', items_scanned: 10 }],
    );

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations/sources');

    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([
      expect.objectContaining({ type: 'codebase', status: 'ready', enabled: true, items_scanned: 10 }),
    ]);
  });

  it('400 on RPC failure', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/get_autopilot_analyzer_sources')), { message: 'x' }, { status: 500 });

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations/sources');

    expect(res.status).toBe(400);
  });
});

// =============================================================================
// GET /recommendations/history
// =============================================================================

describe('GET /api/v1/autopilot/recommendations/history', () => {
  it('happy path: paginates and strips the lookahead row', async () => {
    stubFetch(
      and(methodIs('POST'), urlHas('/rpc/get_autopilot_recommendation_history')),
      [
        { run_id: 'r1', status: 'completed' },
        { run_id: 'r2', status: 'completed' },
      ],
    );

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations/history?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.has_more).toBe(true);
  });

  it('passes trigger_type through to the RPC', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/get_autopilot_recommendation_history')), []);

    const app = mountApp();
    await request(app).get('/api/v1/autopilot/recommendations/history?trigger_type=manual');

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(init.body)).p_trigger_type).toBe('manual');
  });

  it('400 on RPC failure', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/get_autopilot_recommendation_history')), { message: 'x' }, { status: 500 });

    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations/history');

    expect(res.status).toBe(400);
  });
});

// =============================================================================
// POST /recommendations/:id/complete
// =============================================================================

describe('POST /api/v1/autopilot/recommendations/:id/complete', () => {
  it('401 when no user id is present', async () => {
    const app = mountApp();
    const res = await request(app).post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`).send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'User ID required' });
  });

  it('happy path: completes and returns the reward', async () => {
    stubFetch(
      and(methodIs('POST'), urlHas('/rpc/complete_autopilot_recommendation')),
      { ok: true, recommendation_id: REC_ID, title: 'Complete profile', completed_at: '2026-07-28T00:00:00Z', reward: 10, source_ref: 'onboarding_profile' },
    );
    queueSupabaseResult({ tenant_id: TENANT_ID }); // tenant lookup
    queueSupabaseResult([]); // milestone "remaining onboarding" check -> none left

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete?role=community`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, recommendation_id: REC_ID, status: 'completed', reward: 10 });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'autopilot.recommendation.completed' }));
  });

  it('emits a milestone event when the last onboarding rec is completed', async () => {
    stubFetch(
      and(methodIs('POST'), urlHas('/rpc/complete_autopilot_recommendation')),
      { ok: true, recommendation_id: REC_ID, title: 'Complete profile', completed_at: '2026-07-28T00:00:00Z', reward: 10, source_ref: 'onboarding_profile' },
    );
    queueSupabaseResult({ tenant_id: TENANT_ID });
    queueSupabaseResult([]); // no remaining onboarding recs -> milestone fires

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(200);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user.milestone.reached', payload: expect.objectContaining({ milestone: 'onboarding_complete' }) }),
    );
  });

  it('404 when the RPC reports the recommendation was not found', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/complete_autopilot_recommendation')), { ok: false, error: 'Recommendation not found' });

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(404);
  });

  it('403 when the RPC reports the rec belongs to another user (cross-user isolation)', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/complete_autopilot_recommendation')), { ok: false, error: 'Recommendation belongs to another user' });

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .set('X-User-ID', OTHER_USER_ID)
      .send({});

    expect(res.status).toBe(403);
  });

  it('403 when the RPC reports the rec is system-wide (not user-scoped)', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/complete_autopilot_recommendation')), { ok: false, error: 'system-wide recommendations cannot be completed this way' });

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(403);
  });

  it('400 when the rec is not in a completable state', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/complete_autopilot_recommendation')), { ok: false, error: 'Cannot complete recommendation in status: new' });

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(400);
  });

  it('500 on RPC transport failure', async () => {
    stubFetch(and(methodIs('POST'), urlHas('/rpc/complete_autopilot_recommendation')), { message: 'x' }, { status: 500 });

    const app = mountApp();
    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/complete`)
      .set('X-User-ID', USER_ID)
      .send({});

    expect(res.status).toBe(500);
  });
});

// =============================================================================
// GET /recommendations/health
// =============================================================================

describe('GET /api/v1/autopilot/recommendations/health', () => {
  it('always returns ok:true with the endpoint inventory', async () => {
    const app = mountApp();
    const res = await request(app).get('/api/v1/autopilot/recommendations/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('autopilot-recommendations');
    expect(res.body.endpoints).toEqual(
      expect.arrayContaining(['GET /recommendations', 'POST /recommendations/:id/complete']),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
