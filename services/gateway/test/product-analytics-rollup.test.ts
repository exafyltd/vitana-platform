/**
 * BOOTSTRAP-PRODUCT-ANALYTICS: rollup job tests.
 *
 *  - computeRollups produces deterministic rows (running twice = same output)
 *  - dimensions preserve feature_key, topic, and screen_route
 *  - runDailyRollup only includes events for the target day (windowed query)
 *  - runDailyRollup upserts on the idempotency key so re-runs don't double-count
 */

process.env.NODE_ENV = 'test';

const mockUpsert = jest.fn().mockResolvedValue({ error: null });
const fetchWindows: Array<{ gte: string; lt: string }> = [];
let mockEventRows: any[] = [];

function makeQuery() {
  const window: any = {};
  const builder: any = {
    select: jest.fn(() => builder),
    gte: jest.fn((_col: string, val: string) => {
      window.gte = val;
      return builder;
    }),
    lt: jest.fn((_col: string, val: string) => {
      window.lt = val;
      return builder;
    }),
    order: jest.fn(() => builder),
    range: jest.fn(() => {
      fetchWindows.push(window);
      return Promise.resolve({ data: mockEventRows, error: null });
    }),
    upsert: mockUpsert,
    delete: jest.fn(() => builder),
  };
  return builder;
}

jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn().mockReturnValue({ from: jest.fn(() => makeQuery()) }),
}));

import { computeRollups, runDailyRollup } from '../src/services/product-analytics/rollup';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DATE = '2026-06-11';

function ev(overrides: Record<string, unknown> = {}) {
  return {
    event_name: 'screen_viewed',
    event_type: 'journey',
    tenant_id: TENANT,
    user_id_hash: 'user-a',
    session_id: 's1',
    conversation_id: null,
    screen_route: '/community',
    feature_key: null,
    properties: {},
    occurred_at: `${DATE}T10:00:00.000Z`,
    ...overrides,
  };
}

describe('computeRollups', () => {
  it('is deterministic — running twice over the same events yields identical rows', () => {
    const events = [
      ev(),
      ev({ user_id_hash: 'user-b', session_id: 's2', screen_route: '/discover' }),
      ev({ event_name: 'feature_opened', event_type: 'feature', feature_key: 'community' }),
    ];
    const normalize = (rows: any[]) => rows.map(({ updated_at, ...rest }) => rest);
    expect(normalize(computeRollups(TENANT, DATE, events as any))).toEqual(
      normalize(computeRollups(TENANT, DATE, events as any)),
    );
  });

  it('preserves feature_key, topic, and screen_route in dimensions', () => {
    const events = [
      ev(),
      ev({ event_name: 'feature_opened', event_type: 'feature', feature_key: 'health_tracker' }),
      ev({ event_name: 'feature_completed', event_type: 'feature', feature_key: 'health_tracker' }),
      ev({
        event_name: 'topic_detected',
        event_type: 'assistant',
        conversation_id: 'c1',
        properties: { topic: 'sleep' },
      }),
    ];
    const rows = computeRollups(TENANT, DATE, events as any);

    const featureOpens = rows.find((r) => r.metric_key === 'feature_opens');
    expect(featureOpens).toMatchObject({ dimensions: { feature_key: 'health_tracker' }, metric_value: 1 });

    const completions = rows.find((r) => r.metric_key === 'feature_completions');
    expect(completions).toMatchObject({ dimensions: { feature_key: 'health_tracker' }, metric_value: 1 });

    const topic = rows.find((r) => r.metric_key === 'topic_events');
    expect(topic).toMatchObject({ dimensions: { topic: 'sleep' }, metric_value: 1 });

    const routeViews = rows.find((r) => r.metric_key === 'route_views');
    expect(routeViews).toMatchObject({ dimensions: { screen_route: '/community' }, metric_value: 1 });
  });

  it('counts daily actives, sessions, and conversations once each', () => {
    const events = [
      ev({ user_id_hash: 'user-a', session_id: 's1' }),
      ev({ user_id_hash: 'user-a', session_id: 's1', screen_route: '/discover' }),
      ev({
        event_name: 'user_message_sent',
        event_type: 'assistant',
        conversation_id: 'c1',
        user_id_hash: 'user-a',
        session_id: 's1',
      }),
      ev({
        event_name: 'user_message_sent',
        event_type: 'assistant',
        conversation_id: 'c1',
        user_id_hash: 'user-a',
        session_id: 's1',
      }),
    ];
    const rows = computeRollups(TENANT, DATE, events as any);
    expect(rows.find((r) => r.metric_key === 'active_users')?.metric_value).toBe(1);
    expect(rows.find((r) => r.metric_key === 'sessions')?.metric_value).toBe(1);
    expect(rows.find((r) => r.metric_key === 'assistant_conversations')?.metric_value).toBe(1);
    expect(rows.find((r) => r.metric_key === 'assistant_messages')?.metric_value).toBe(2);
  });
});

describe('runDailyRollup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchWindows.length = 0;
    mockEventRows = [ev()];
  });

  it('queries exactly the target UTC day window', async () => {
    await runDailyRollup(DATE);
    expect(fetchWindows[0]).toEqual({
      gte: `${DATE}T00:00:00.000Z`,
      lt: '2026-06-12T00:00:00.000Z',
    });
  });

  it('upserts on the idempotency key so re-running never double-counts', async () => {
    await runDailyRollup(DATE);
    await runDailyRollup(DATE);

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    for (const call of mockUpsert.mock.calls) {
      expect(call[1]).toEqual({ onConflict: 'tenant_id,rollup_date,metric_key,dimensions' });
    }
    // Same key set both runs — the second upsert overwrites, not appends.
    const keys = (rows: any[]) => rows.map((r) => `${r.tenant_id}|${r.rollup_date}|${r.metric_key}|${JSON.stringify(r.dimensions)}`);
    expect(keys(mockUpsert.mock.calls[0][0])).toEqual(keys(mockUpsert.mock.calls[1][0]));
  });

  it('groups rollups per tenant', async () => {
    const otherTenant = '22222222-2222-4222-8222-222222222222';
    mockEventRows = [ev(), ev({ tenant_id: otherTenant, session_id: 's9' })];
    const result = await runDailyRollup(DATE);

    expect(result.ok).toBe(true);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    const tenants = mockUpsert.mock.calls.map((c) => c[0][0].tenant_id).sort();
    expect(tenants).toEqual([TENANT, otherTenant].sort());
  });
});
