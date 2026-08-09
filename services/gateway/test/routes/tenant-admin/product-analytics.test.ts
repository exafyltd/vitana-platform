/**
 * Tests for src/routes/tenant-admin/product-analytics.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/analytics
 *   GET /summary, /assistant, /journeys, /features, /interests, /events
 *
 * The whole router is behind requireTenantAdmin (router.use). Unlike
 * test/product-analytics-admin.test.ts (which stubs the middleware), this
 * suite runs the REAL requireTenantAdmin: jose-verified JWT, cross-tenant
 * 403, role lookup against user_tenants.
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
    gte: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    range: jest.fn(() => chain),
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
const router = require('../../../src/routes/tenant-admin/product-analytics').default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/analytics', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const tenantAdminClaims = (tenantId: string) => ({
  sub: 'admin-a',
  email: 'admin-a@example.com',
  app_metadata: { active_tenant_id: tenantId, exafy_admin: false },
});

const EXAFY_ADMIN_CLAIMS = {
  sub: 'super-admin',
  email: 'super@exafy.io',
  app_metadata: { exafy_admin: true },
};

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
}

function eventRow(overrides: Record<string, any> = {}) {
  return {
    event_name: 'screen_viewed',
    event_type: 'journey',
    user_id_hash: 'user-a',
    session_id: 'session-1',
    conversation_id: null,
    screen_route: '/community',
    feature_key: null,
    source: 'web',
    properties: {},
    occurred_at: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('Tenant Admin Product Analytics Routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
    mockInvalidJwt();
  });

  // --- Auth / RBAC (router-level middleware) ---

  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).get(`/api/v1/admin/tenants/${TENANT_A}/analytics/summary`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('tenant isolation: tenant A admin cannot read tenant B analytics (403, no query)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_B}/analytics/summary`)
      .set('Authorization', 'Bearer tenant-a-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(chainFor('product_analytics_events').select).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin member of the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'community' }, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/events`)
      .set('Authorization', 'Bearer member-token');

    expect(res.status).toBe(403);
    expect(chainFor('product_analytics_events').select).not.toHaveBeenCalled();
  });

  it('exafy super-admin can read any tenant\'s analytics', async () => {
    mockVerifiedJwt(EXAFY_ADMIN_CLAIMS);
    chainFor('product_analytics_events').mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_B}/analytics/events`)
      .set('Authorization', 'Bearer exafy-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockUserTenantsSingle).not.toHaveBeenCalled();
    // Even the super-admin's read is scoped to the requested tenant
    expect(chainFor('product_analytics_events').eq).toHaveBeenCalledWith('tenant_id', TENANT_B);
  });

  it('returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/summary`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET /summary ---

  it('GET /summary aggregates events and scopes the fetch to the tenant + window', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [
      eventRow({ event_name: 'screen_viewed', screen_route: '/community', session_id: 's1', user_id_hash: 'u1' }),
      eventRow({ event_name: 'screen_viewed', screen_route: '/community', session_id: 's2', user_id_hash: 'u2' }),
      eventRow({ event_name: 'screen_viewed', screen_route: '/wallet', session_id: 's1', user_id_hash: 'u1' }),
      eventRow({ event_name: 'user_message_sent', event_type: 'assistant', conversation_id: 'c1', session_id: 's1', user_id_hash: 'u1' }),
      eventRow({ event_name: 'conversation_started', event_type: 'assistant', conversation_id: 'c1', session_id: 's1', user_id_hash: 'u1' }),
      eventRow({ event_name: 'feature_opened', event_type: 'feature', feature_key: 'diary', session_id: 's2', user_id_hash: 'u2' }),
      eventRow({ event_name: 'feature_completed', event_type: 'feature', feature_key: 'diary', session_id: 's2', user_id_hash: 'u2' }),
      eventRow({ event_name: 'topic_detected', event_type: 'assistant', conversation_id: 'c1', session_id: 's1', user_id_hash: 'u1', properties: { topic: 'longevity' } }),
    ];
    const chain = chainFor('product_analytics_events');
    chain.mockResolvedValueOnce({ data: rows, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/summary?days=7`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      days: 7,
      active_users: 2,
      sessions: 2,
      screen_views: 3,
      assistant_conversations: 1,
      assistant_messages: 1,
      feature_opens: 1,
      feature_completions: 1,
      unresolved_conversations: 1, // c1 started, never resolved
    });
    expect(res.body.top_routes[0]).toEqual({ screen_route: '/community', count: 2 });
    expect(res.body.top_features[0]).toEqual({ feature_key: 'diary', count: 1 });
    expect(res.body.top_interests[0]).toEqual({ topic: 'longevity', count: 1 });

    // Tenant isolation + bounded time window on the raw-event fetch
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chain.gte).toHaveBeenCalledWith('occurred_at', expect.any(String));
  });

  it('GET /summary clamps days to 90', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('product_analytics_events').mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/summary?days=999`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(90);
  });

  it('GET /summary returns 500 when the event fetch fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('product_analytics_events').mockResolvedValueOnce({ data: null, error: { message: 'fetch failed' } });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/summary`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

  // --- GET /assistant ---

  it('GET /assistant computes rates, percentiles, and tool stats', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [
      eventRow({ event_name: 'user_message_sent', event_type: 'assistant', conversation_id: 'c1', user_id_hash: 'u1' }),
      eventRow({ event_name: 'user_message_sent', event_type: 'assistant', conversation_id: 'c1', user_id_hash: 'u1' }),
      eventRow({ event_name: 'conversation_resolved', event_type: 'assistant', conversation_id: 'c1', user_id_hash: 'u1' }),
      eventRow({ event_name: 'assistant_response_completed', event_type: 'assistant', conversation_id: 'c1', user_id_hash: 'u1', properties: { response_time_ms: 100 } }),
      eventRow({ event_name: 'assistant_response_completed', event_type: 'assistant', conversation_id: 'c1', user_id_hash: 'u1', properties: { response_time_ms: 200 } }),
      eventRow({ event_name: 'intent_classified', event_type: 'assistant', conversation_id: 'c1', user_id_hash: 'u1', properties: { intent: 'health_question' } }),
      eventRow({ event_name: 'tool_called', event_type: 'assistant', conversation_id: 'c1', user_id_hash: 'u1', properties: { tool_name: 'search' } }),
      eventRow({ event_name: 'tool_call_failed', event_type: 'assistant', conversation_id: 'c1', user_id_hash: 'u1', properties: { tool_name: 'search' } }),
      eventRow({ event_name: 'assistant_feedback_given', event_type: 'assistant', conversation_id: 'c1', user_id_hash: 'u1', properties: { sentiment: 'positive' } }),
    ];
    const chain = chainFor('product_analytics_events');
    chain.mockResolvedValueOnce({ data: rows, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/assistant`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      conversations: 1,
      messages: 2,
      users: 1,
      avg_messages_per_conversation: 2,
      resolution_rate: 1,
      abandonment_rate: 0,
      positive_feedback: 1,
      negative_feedback: 0,
      p95_response_ms: 200,
      // 1 tool_called, 1 tool_call_failed → failures/calls = 1/1
      tool_failure_rate: 1,
    });
    expect(res.body.top_intents[0]).toEqual({ intent: 'health_question', count: 1 });
    expect(res.body.top_tools[0]).toEqual({ tool_name: 'search', calls: 1, failures: 1 });
    expect(res.body.recent_unresolved).toEqual([]); // c1 was resolved

    // Assistant view is restricted to assistant/friction event types
    expect(chain.in).toHaveBeenCalledWith('event_type', ['assistant', 'friction']);
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  // --- GET /journeys ---

  it('GET /journeys reconstructs per-session entry/exit routes', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [
      eventRow({ event_name: 'screen_viewed', screen_route: '/home', session_id: 's1', occurred_at: '2026-07-27T10:00:00.000Z' }),
      eventRow({ event_name: 'screen_viewed', screen_route: '/wallet', session_id: 's1', occurred_at: '2026-07-27T10:05:00.000Z' }),
      eventRow({ event_name: 'screen_viewed', screen_route: '/home', session_id: 's2', occurred_at: '2026-07-27T11:00:00.000Z' }),
    ];
    chainFor('product_analytics_events').mockResolvedValueOnce({ data: rows, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/journeys`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toBe(2);
    expect(res.body.screen_views).toBe(3);
    expect(res.body.top_entry_routes[0]).toEqual({ screen_route: '/home', sessions: 2 });
    // s1 exits at /wallet, s2 exits at /home
    const exits = Object.fromEntries(res.body.top_exit_routes.map((r: any) => [r.screen_route, r.sessions]));
    expect(exits).toEqual({ '/wallet': 1, '/home': 1 });
    expect(res.body.top_paths[0]).toEqual({ path: ['/home', '/wallet'], sessions: 1 });
  });

  // --- GET /features ---

  it('GET /features computes completion rate and repeat users per feature', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [
      eventRow({ event_name: 'feature_opened', event_type: 'feature', feature_key: 'diary', user_id_hash: 'u1', occurred_at: '2026-07-26T09:00:00.000Z' }),
      eventRow({ event_name: 'feature_opened', event_type: 'feature', feature_key: 'diary', user_id_hash: 'u1', occurred_at: '2026-07-27T09:00:00.000Z' }),
      eventRow({ event_name: 'feature_completed', event_type: 'feature', feature_key: 'diary', user_id_hash: 'u1', occurred_at: '2026-07-27T09:10:00.000Z' }),
      eventRow({ event_name: 'feature_opened', event_type: 'feature', feature_key: 'orb', user_id_hash: 'u2', occurred_at: '2026-07-27T09:00:00.000Z' }),
    ];
    chainFor('product_analytics_events').mockResolvedValueOnce({ data: rows, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/features`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    const diary = res.body.top_features.find((f: any) => f.feature_key === 'diary');
    expect(diary).toMatchObject({ opens: 2, completions: 1, completion_rate: 0.5, repeat_users: 1 });
    const orb = res.body.top_features.find((f: any) => f.feature_key === 'orb');
    expect(orb).toMatchObject({ opens: 1, completions: 0, completion_rate: 0, repeat_users: 0 });
  });

  // --- GET /interests ---

  it('GET /interests aggregates topics with repeated-user counts', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [
      eventRow({ event_name: 'topic_detected', event_type: 'assistant', user_id_hash: 'u1', properties: { topic: 'fasting' } }),
      eventRow({ event_name: 'interest_detected', event_type: 'interest', user_id_hash: 'u1', properties: { topic: 'fasting' } }),
      eventRow({ event_name: 'topic_detected', event_type: 'assistant', user_id_hash: 'u2', properties: { topic: 'fasting' } }),
      eventRow({ event_name: 'content_saved', event_type: 'content', user_id_hash: 'u2', properties: { topic: 'sleep' } }),
      // event outside the interest set — ignored
      eventRow({ event_name: 'screen_viewed', properties: { topic: 'noise' } }),
    ];
    chainFor('product_analytics_events').mockResolvedValueOnce({ data: rows, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/interests`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.top_topics[0]).toEqual({ topic: 'fasting', users: 2, events: 3, repeated_users: 1 });
    expect(res.body.top_topics[1]).toEqual({ topic: 'sleep', users: 1, events: 1, repeated_users: 0 });
    expect(res.body.top_topics).toHaveLength(2);
  });

  // --- GET /events ---

  it('GET /events returns the raw feed scoped to the tenant with optional filters', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const rows = [eventRow(), eventRow({ session_id: 's2' })];
    const chain = chainFor('product_analytics_events');
    chain.mockResolvedValueOnce({ data: rows, error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/events?event_name=screen_viewed&event_type=journey`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.events).toEqual(rows);
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A); // isolation
    expect(chain.eq).toHaveBeenCalledWith('event_name', 'screen_viewed');
    expect(chain.eq).toHaveBeenCalledWith('event_type', 'journey');
    expect(chain.limit).toHaveBeenCalledWith(100); // default limit
  });

  it('GET /events clamps limit to 500', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('product_analytics_events');
    chain.mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/events?limit=99999`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(chain.limit).toHaveBeenCalledWith(500);
  });

  it('GET /events returns 500 with the DB error surfaced', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('product_analytics_events').mockResolvedValueOnce({ data: null, error: { message: 'events read failed' } });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/analytics/events`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('events read failed');
  });
});
