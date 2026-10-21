/**
 * BOOTSTRAP-PRODUCT-ANALYTICS: admin read endpoint tests.
 *
 * GET /api/v1/admin/tenants/:tenantId/analytics/*
 *  - missing auth → 401
 *  - tenant the caller cannot access → 403
 *  - data is scoped to the requested tenant (query filter asserted)
 *  - aggregation shapes for summary/assistant
 */

import request from 'supertest';
import express from 'express';

process.env.NODE_ENV = 'test';

const ALLOWED_TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

// Simulate the real middleware contract: 401 without a token, 403 when the
// caller's tenant doesn't match the route tenant, next() otherwise.
jest.mock('../src/middleware/require-tenant-admin', () => ({
  requireTenantAdmin: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    if (req.params.tenantId !== ALLOWED_TENANT) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    req.identity = { user_id: 'admin-user' };
    return next();
  },
}));

// Chainable supabase query mock that records filters and resolves rows.
const recordedFilters: Array<Record<string, unknown>> = [];
let mockRows: any[] = [];

function makeQuery() {
  const filters: Record<string, unknown> = {};
  const builder: any = {
    select: jest.fn(() => builder),
    eq: jest.fn((col: string, val: unknown) => {
      filters[`eq:${col}`] = val;
      return builder;
    }),
    in: jest.fn((col: string, vals: unknown) => {
      filters[`in:${col}`] = vals;
      return builder;
    }),
    gte: jest.fn(() => builder),
    order: jest.fn(() => builder),
    limit: jest.fn(() => {
      recordedFilters.push(filters);
      return Promise.resolve({ data: mockRows, error: null });
    }),
    range: jest.fn(() => {
      recordedFilters.push(filters);
      return Promise.resolve({ data: mockRows, error: null });
    }),
  };
  return builder;
}

jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn().mockReturnValue({ from: jest.fn(() => makeQuery()) }),
}));

import tenantProductAnalyticsRouter from '../src/routes/tenant-admin/product-analytics';

function eventRow(overrides: Record<string, unknown> = {}) {
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
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('GET /api/v1/admin/tenants/:tenantId/analytics', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    recordedFilters.length = 0;
    mockRows = [];
    app = express();
    app.use(express.json());
    app.use('/api/v1/admin/tenants/:tenantId/analytics', tenantProductAnalyticsRouter);
  });

  it('rejects a missing auth token with 401', async () => {
    const res = await request(app).get(`/api/v1/admin/tenants/${ALLOWED_TENANT}/analytics/summary`);
    expect(res.status).toBe(401);
  });

  it('rejects a tenant the admin cannot access with 403', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/tenants/${OTHER_TENANT}/analytics/summary`)
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(403);
  });

  it('scopes queries to the requested tenant', async () => {
    await request(app)
      .get(`/api/v1/admin/tenants/${ALLOWED_TENANT}/analytics/summary`)
      .set('Authorization', 'Bearer test-token');

    expect(recordedFilters.length).toBeGreaterThan(0);
    for (const filters of recordedFilters) {
      expect(filters['eq:tenant_id']).toBe(ALLOWED_TENANT);
    }
  });

  it('aggregates summary KPIs from raw events', async () => {
    mockRows = [
      eventRow({ user_id_hash: 'user-a', session_id: 's1' }),
      eventRow({ user_id_hash: 'user-b', session_id: 's2', screen_route: '/discover' }),
      eventRow({
        event_name: 'conversation_started',
        event_type: 'assistant',
        conversation_id: 'c1',
        session_id: 's1',
      }),
      eventRow({
        event_name: 'user_message_sent',
        event_type: 'assistant',
        conversation_id: 'c1',
        session_id: 's1',
        properties: { message_length: 12 },
      }),
      eventRow({ event_name: 'feature_opened', event_type: 'feature', feature_key: 'community', session_id: 's2' }),
    ];

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${ALLOWED_TENANT}/analytics/summary?days=7`)
      .set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.active_users).toBe(2);
    expect(res.body.sessions).toBe(2);
    expect(res.body.screen_views).toBe(2);
    expect(res.body.assistant_conversations).toBe(1);
    expect(res.body.assistant_messages).toBe(1);
    expect(res.body.feature_opens).toBe(1);
    expect(res.body.unresolved_conversations).toBe(1);
    expect(res.body.top_features).toEqual([{ feature_key: 'community', count: 1 }]);
  });

  it('computes assistant quality metrics without exposing raw text', async () => {
    mockRows = [
      eventRow({
        event_name: 'conversation_started',
        event_type: 'assistant',
        conversation_id: 'c1',
      }),
      eventRow({
        event_name: 'user_message_sent',
        event_type: 'assistant',
        conversation_id: 'c1',
        properties: { message_length: 40, input_mode: 'text' },
      }),
      eventRow({
        event_name: 'assistant_response_completed',
        event_type: 'assistant',
        conversation_id: 'c1',
        properties: { response_time_ms: 1200, model: 'gemini' },
      }),
      eventRow({
        event_name: 'intent_classified',
        event_type: 'assistant',
        conversation_id: 'c1',
        properties: { intent: 'health_question', confidence: 0.9 },
      }),
      eventRow({
        event_name: 'tool_called',
        event_type: 'assistant',
        conversation_id: 'c1',
        properties: { tool_name: 'memory_search' },
      }),
      eventRow({
        event_name: 'tool_call_failed',
        event_type: 'assistant',
        conversation_id: 'c1',
        properties: { tool_name: 'memory_search', error_code: 'TIMEOUT' },
      }),
      eventRow({
        event_name: 'conversation_resolved',
        event_type: 'assistant',
        conversation_id: 'c1',
      }),
    ];

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${ALLOWED_TENANT}/analytics/assistant?days=30`)
      .set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(res.body.conversations).toBe(1);
    expect(res.body.messages).toBe(1);
    expect(res.body.resolution_rate).toBe(1);
    expect(res.body.p95_response_ms).toBe(1200);
    expect(res.body.tool_failure_rate).toBe(1);
    expect(res.body.top_intents).toEqual([{ intent: 'health_question', count: 1 }]);
    expect(res.body.top_tools).toEqual([{ tool_name: 'memory_search', calls: 1, failures: 1 }]);
    expect(res.body.recent_unresolved).toEqual([]);
    // Metadata only — no raw text fields anywhere in the response.
    const body = JSON.stringify(res.body);
    for (const key of ['"message"', '"prompt"', '"raw_text"', '"transcript"']) {
      expect(body).not.toContain(key);
    }
  });

  it('clamps the days parameter to 1..90', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/tenants/${ALLOWED_TENANT}/analytics/summary?days=4000`)
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(90);
  });
});
