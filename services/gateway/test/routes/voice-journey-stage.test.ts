/**
 * VTID-02937 (B4) — GET /api/v1/voice/journey-stage/preview tests.
 *
 * Verifies:
 *   - Validates userId + tenantId (400 when missing).
 *   - Calls all three fetcher methods with the provided ids.
 *   - Returns ok:true with raw rows + compiled context.
 *   - Reflects fetcher source-health failures in the compiled context.
 *   - Returns 500 with vtid when a fetcher throws unexpectedly.
 *   - Truncates index_history_head to 10 rows.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

const fetchAppUser = jest.fn();
const fetchUserActiveDaysAggregate = jest.fn();
const fetchVitanaIndexHistory = jest.fn();

jest.mock('../../src/services/journey-stage/journey-stage-fetcher', () => ({
  defaultJourneyStageFetcher: {
    fetchAppUser: (a: any) => fetchAppUser(a),
    fetchUserActiveDaysAggregate: (a: any) => fetchUserActiveDaysAggregate(a),
    fetchVitanaIndexHistory: (a: any) => fetchVitanaIndexHistory(a),
  },
}));

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-journey-stage').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('B4 — GET /api/v1/voice/journey-stage/preview', () => {
  beforeEach(() => {
    fetchAppUser.mockReset();
    fetchUserActiveDaysAggregate.mockReset();
    fetchVitanaIndexHistory.mockReset();
  });

  it('returns 400 when userId is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/journey-stage/preview?tenantId=t');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.vtid).toBe('VTID-02937');
  });

  it('returns 400 when tenantId is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/journey-stage/preview?userId=u');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns ok:true with raw rows + compiled context', async () => {
    fetchAppUser.mockResolvedValueOnce({ ok: true, row: null });
    fetchUserActiveDaysAggregate.mockResolvedValueOnce({
      ok: true,
      aggregate: { usage_days_count: 0, last_active_date: null },
    });
    fetchVitanaIndexHistory.mockResolvedValueOnce({ ok: true, rows: [] });

    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/journey-stage/preview?userId=u&tenantId=t');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vtid).toBe('VTID-02937');
    expect(res.body.app_user).toBeNull();
    expect(res.body.active_days).toEqual({ usage_days_count: 0, last_active_date: null });
    expect(Array.isArray(res.body.index_history_head)).toBe(true);
    expect(res.body.context).toBeDefined();
    expect(res.body.context.onboarding_stage).toBe('first_session');
    expect(res.body.context.source_health.app_users.ok).toBe(true);
  });

  it('passes userId / tenantId through to fetchers + caps history at 60', async () => {
    fetchAppUser.mockResolvedValueOnce({ ok: true, row: null });
    fetchUserActiveDaysAggregate.mockResolvedValueOnce({ ok: true, aggregate: { usage_days_count: 0, last_active_date: null } });
    fetchVitanaIndexHistory.mockResolvedValueOnce({ ok: true, rows: [] });
    const app = buildApp();
    await request(app).get('/api/v1/voice/journey-stage/preview?userId=alice&tenantId=acme');
    expect(fetchAppUser).toHaveBeenCalledWith({ userId: 'alice' });
    expect(fetchUserActiveDaysAggregate).toHaveBeenCalledWith({ userId: 'alice' });
    expect(fetchVitanaIndexHistory).toHaveBeenCalledWith({ tenantId: 'acme', userId: 'alice', limit: 60 });
  });

  it('truncates index_history_head to 10 rows', async () => {
    fetchAppUser.mockResolvedValueOnce({ ok: true, row: null });
    fetchUserActiveDaysAggregate.mockResolvedValueOnce({ ok: true, aggregate: { usage_days_count: 0, last_active_date: null } });
    fetchVitanaIndexHistory.mockResolvedValueOnce({
      ok: true,
      rows: Array.from({ length: 25 }, (_, i) => ({ date: '2026-05-' + (i + 1), score_total: 300 + i })),
    });
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/journey-stage/preview?userId=u&tenantId=t');
    expect(res.body.index_history_head).toHaveLength(10);
  });

  it('reflects partial fetcher failure in source-health', async () => {
    fetchAppUser.mockResolvedValueOnce({ ok: false, row: null, reason: 'supabase_unconfigured' });
    fetchUserActiveDaysAggregate.mockResolvedValueOnce({ ok: true, aggregate: { usage_days_count: 0, last_active_date: null } });
    fetchVitanaIndexHistory.mockResolvedValueOnce({ ok: true, rows: [] });

    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/journey-stage/preview?userId=u&tenantId=t');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.context.source_health.app_users.ok).toBe(false);
    expect(res.body.context.source_health.app_users.reason).toBe('supabase_unconfigured');
    expect(res.body.context.source_health.user_active_days.ok).toBe(true);
    expect(res.body.context.source_health.vitana_index_scores.ok).toBe(true);
  });

  it('returns 500 with vtid when a fetcher throws unexpectedly', async () => {
    fetchAppUser.mockRejectedValueOnce(new Error('boom'));
    fetchUserActiveDaysAggregate.mockResolvedValueOnce({ ok: true, aggregate: { usage_days_count: 0, last_active_date: null } });
    fetchVitanaIndexHistory.mockResolvedValueOnce({ ok: true, rows: [] });

    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/journey-stage/preview?userId=u&tenantId=t');
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.vtid).toBe('VTID-02937');
  });
});
