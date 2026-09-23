/**
 * VTID-04371 (WS-0.7) — /admin/conversation/metrics/* route wiring:
 * admin-gated, reads only the repository seam, degrades per source.
 */

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireExafyAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const fakeSb = { tag: 'sb' };
let dbConfigured = true;
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => (dbConfigured ? fakeSb : null) }));

const repoMock = {
  fetchOasisEventsByStage: jest.fn(),
  fetchConversationMetricsSince: jest.fn(),
  fetchConversationMetricSeries: jest.fn(),
  fetchLearningAutomationRuns: jest.fn(),
  fetchProfileNarrativeStamps: jest.fn(),
};
jest.mock('../../src/routes/conversation-hub-repository', () => repoMock);

import express from 'express';
import request from 'supertest';
import conversationHubRouter from '../../src/routes/conversation-hub';

function makeApp() {
  const app = express();
  app.use('/api/v1', conversationHubRouter);
  return app;
}

const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000).toISOString();

beforeEach(() => {
  dbConfigured = true;
  Object.values(repoMock).forEach((m) => m.mockReset());
});

describe('GET /admin/conversation/metrics/summary', () => {
  it('summarises the rollup for the window and clamps window_hours', async () => {
    repoMock.fetchConversationMetricsSince.mockResolvedValue({
      data: [{ hour_start: hour, metric: 'sessions_started', dimension: '', value: 5, sample_count: 5, computed_at: hour }],
      error: null,
    });
    const res = await request(makeApp()).get('/api/v1/admin/conversation/metrics/summary?window_hours=99999');
    expect(res.status).toBe(200);
    expect(res.body.data.window_hours).toBe(720);
    expect(res.body.data.sessions.started).toBe(5);
    const [sb, sinceIso] = repoMock.fetchConversationMetricsSince.mock.calls[0];
    expect(sb).toBe(fakeSb);
    expect(Date.parse(sinceIso) % 3_600_000).toBe(0);
    expect(repoMock.fetchOasisEventsByStage).not.toHaveBeenCalled();
  });

  it('503 without a database, 500 JSON on a read error', async () => {
    dbConfigured = false;
    expect((await request(makeApp()).get('/api/v1/admin/conversation/metrics/summary')).status).toBe(503);
    dbConfigured = true;
    repoMock.fetchConversationMetricsSince.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await request(makeApp()).get('/api/v1/admin/conversation/metrics/summary');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'boom' });
  });
});

describe('GET /admin/conversation/metrics/series', () => {
  it('requires a well-formed metric name', async () => {
    const res = await request(makeApp()).get('/api/v1/admin/conversation/metrics/series?metric=drop;table');
    expect(res.status).toBe(400);
    expect(repoMock.fetchConversationMetricSeries).not.toHaveBeenCalled();
  });

  it('returns a gap-filled hourly series', async () => {
    repoMock.fetchConversationMetricSeries.mockResolvedValue({
      data: [{ hour_start: hour, metric: 'first_audio_ms_p50', dimension: '', value: 2100, sample_count: 7 }],
      error: null,
    });
    const res = await request(makeApp()).get('/api/v1/admin/conversation/metrics/series?metric=first_audio_ms_p50&window_hours=3');
    expect(res.status).toBe(200);
    expect(res.body.data.series).toHaveLength(3);
    expect(res.body.data.series[2]).toEqual({ hour_start: hour, value: 2100, sample_count: 7 });
  });
});

describe('GET /admin/conversation/metrics/learning', () => {
  it('combines jobs, narrative freshness and coverage', async () => {
    repoMock.fetchLearningAutomationRuns.mockResolvedValue({
      data: [{ automation_id: 'AP-0911', status: 'completed', started_at: '2026-07-06T23:12:33.498Z', completed_at: null }],
      error: null,
    });
    repoMock.fetchProfileNarrativeStamps.mockResolvedValue({ data: [{ generated_at: '2026-07-06T23:12:40.000Z' }], error: null });
    repoMock.fetchConversationMetricsSince.mockResolvedValue({
      data: [{ hour_start: hour, metric: 'sessions_finalized', dimension: '', value: 2, sample_count: 2 }],
      error: null,
    });
    const res = await request(makeApp()).get('/api/v1/admin/conversation/metrics/learning');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.window_hours).toBe(168);
    expect(d.jobs).toHaveLength(8);
    expect(d.jobs.find((j: { automation_id: string }) => j.automation_id === 'AP-0911').stale).toBe(true);
    expect(d.profile_narrative).toMatchObject({ users_with_narrative: 1, fresh_7d: 0 });
    expect(d.coverage.sessions_finalized).toBe(2);
    expect(d.errors).toEqual([]);
    expect(repoMock.fetchProfileNarrativeStamps).toHaveBeenCalledWith(fakeSb, 'user_profile_narrative_v1');
  });

  it('a failed source is reported and the rest still returns', async () => {
    repoMock.fetchLearningAutomationRuns.mockResolvedValue({ data: null, error: { message: 'denied' } });
    repoMock.fetchProfileNarrativeStamps.mockResolvedValue({ data: [], error: null });
    repoMock.fetchConversationMetricsSince.mockResolvedValue({ data: [], error: null });
    const res = await request(makeApp()).get('/api/v1/admin/conversation/metrics/learning');
    expect(res.status).toBe(200);
    expect(res.body.data.jobs).toBeNull();
    expect(res.body.data.errors).toEqual(['automation_runs: denied']);
    expect(res.body.data.coverage.sessions_finalized).toBe(0);
  });
});
