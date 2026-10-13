/**
 * VTID-05103 — the audit and agents-registry route handlers were moved into
 * exported functions (the routine runner calls them directly). The HTTP
 * routes must answer exactly as before, and the function must return the same
 * body the route sends (minus `ok`).
 */
import express from 'express';
import request from 'supertest';

const TOKEN = 'test-routine-token';

// URL-aware PostgREST stub: HEAD → a count in content-range, GET → rows.
function stubFetch(rows: Record<string, unknown[]>, count = 7) {
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    const u = String(url);
    if ((init.method || 'GET') === 'HEAD') {
      return { ok: true, status: 206, headers: { get: () => `0-0/${count}` }, json: async () => null, text: async () => '' };
    }
    const key = Object.keys(rows).find((k) => u.includes(k));
    const body = key ? rows[key] : [];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  });
}

function auditsApp() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../src/routes/routine-audits');
  const app = express();
  app.use('/', mod.routineAuditsRouter);
  return { app, mod };
}

beforeEach(() => {
  process.env.ROUTINE_INGEST_TOKEN = TOKEN;
  process.env.SUPABASE_URL = 'https://supa.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc';
});

describe('routine-audits: routes answer as before, functions return the same body', () => {
  it('io-pressure', async () => {
    stubFetch({});
    const { app, mod } = auditsApp();
    const res = await request(app).get('/api/v1/routines/audits/io-pressure').set('X-Routine-Token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, retention_drift_count: 7, today_count: 7, baseline_avg_per_day: 1 });
    expect(await mod.auditIoPressure()).toEqual({ retention_drift_count: 7, today_count: 7, baseline_avg_per_day: 1 });
  });

  it('oasis-summary passes window_hours / until_hours through', async () => {
    stubFetch({ 'select=topic': [{ topic: 'a' }, { topic: 'a' }, { topic: 'b' }] });
    const { app, mod } = auditsApp();
    const res = await request(app)
      .get('/api/v1/routines/audits/oasis-summary?window_hours=192&until_hours=24')
      .set('X-Routine-Token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      window: { sinceHours: 192, untilHours: 24 },
      total_count: 7,
      top_topics: [{ topic: 'a', count: 2 }, { topic: 'b', count: 1 }],
      sample_size: 3,
    });
    const fn = await mod.auditOasisSummary({ windowHours: 192, untilHours: 24 });
    expect(fn.top_topics).toEqual(res.body.top_topics);
  });

  it.each([
    ['autopilot-recs', ['yesterday', 'baseline_window', 'baseline_avg_per_day']],
    ['vitana-index', ['active_users', 'fresh_score_users', 'coverage_rate', 'pillar_nullity_rate', 'balance_factor_p50', 'fresh_rows_total', 'phase_e_pending']],
    ['knowledge-docs-staleness', ['feature_pending', 'total_docs', 'stale_count', 'stale_after_days', 'sample_stalest']],
    ['dyk-tour-progress', ['feature_pending', 'total_tracked', 'day_distribution', 'max_day_seen', 'sample_size']],
    ['spec-memory-quarantine', ['feature_pending', 'total_shadow_log', 'quarantined_now', 'quarantined_recent_7d', 'sample_oldest']],
    ['mobile-screen-latency', ['window_hours', 'platform', 'sample_size', 'platform_breakdown', 'screens']],
  ])('%s keeps its response keys', async (route, keys) => {
    stubFetch({});
    const { app } = auditsApp();
    const res = await request(app).get(`/api/v1/routines/audits/${route}`).set('X-Routine-Token', TOKEN);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['ok', ...keys].sort());
  });

  it('mobile-screen-latency keeps its platform filter', async () => {
    stubFetch({
      'screen.latency.measured': [
        { metadata: { platform: 'ios', screen: '/inbox', metric: 'LCP', value: 100 } },
        { metadata: { platform: 'android', screen: '/inbox', metric: 'LCP', value: 200 } },
      ],
    });
    const { app, mod } = auditsApp();
    const res = await request(app).get('/api/v1/routines/audits/mobile-screen-latency?platform=ios').set('X-Routine-Token', TOKEN);
    expect(res.body).toMatchObject({ platform: 'ios', sample_size: 1, platform_breakdown: { ios: 1, android: 1 } });
    const fn = await mod.auditMobileScreenLatency({ windowHours: 24, platform: 'android' });
    expect(fn.sample_size).toBe(1);
    expect(fn.screens[0].metrics.LCP.p75).toBe(200);
  });
});

describe('agents-registry: route answers as before, readAgentsRegistry returns the same data', () => {
  const rows = [
    { agent_id: 'svc-1', tier: 'service', status: 'healthy', llm_provider: 'none', last_heartbeat_at: new Date().toISOString() },
    { agent_id: 'emb-1', tier: 'embedded', status: 'healthy', llm_provider: 'claude', last_heartbeat_at: null },
  ];

  function registryApp() {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../src/routes/agents-registry');
    const app = express();
    app.use('/', mod.agentsRegistryRouter);
    return { app, mod };
  }

  it('GET /api/v1/agents/registry', async () => {
    stubFetch({ agents_registry: rows });
    const { app, mod } = registryApp();
    const res = await request(app).get('/api/v1/agents/registry');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['agents', 'by_tier', 'counts', 'ok', 'timestamp']);
    expect(res.body.counts).toMatchObject({ total: 2, by_tier: { service: 1, embedded: 1, scheduled: 0 } });
    const fn = await mod.readAgentsRegistry();
    expect(fn.ok).toBe(true);
    expect(fn.counts).toEqual(res.body.counts);
  });

  it('status filter still applies', async () => {
    stubFetch({ agents_registry: rows });
    const { app } = registryApp();
    const res = await request(app).get('/api/v1/agents/registry?status=down');
    expect(res.body.counts.total).toBe(0);
  });
});
