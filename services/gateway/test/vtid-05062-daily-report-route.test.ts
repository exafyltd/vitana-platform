/**
 * VTID-05062: POST /api/v1/frontend/screen-load/daily-report/run and
 * GET /api/v1/frontend/screen-load/daily-report.
 *
 * In-memory OASIS store; the live fetchers are replaced by fixtures, so no
 * database, no production HTML fetch and no Google Chat call happens.
 */

import request from 'supertest';
import express from 'express';

type Stored = { created_at: string; topic: string; metadata: Record<string, any> };
const mockStore: Stored[] = [];

const mockEmit = jest.fn(async (e: any) => {
  mockStore.unshift({
    created_at: new Date().toISOString(),
    topic: e.type,
    metadata: { ...(e.payload ?? {}), env: e.payload?.env ?? 'production' },
  });
  return { ok: true, event_id: `evt-${mockStore.length}` };
});
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (e: unknown) => mockEmit(e),
}));

const mockGChat = jest.fn(async (_text: string) => ({ ok: true, webhook_set: true, status: 200 }));
jest.mock('../src/services/self-healing-snapshot-service', () => ({
  notifyGChat: (t: string) => mockGChat(t),
}));

jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => ({ fake: true }),
}));

jest.mock('../src/env', () => ({
  VITANA_ENV: 'production',
  isStaging: false,
}));

jest.mock('../src/routes/screen-load-health-repository', () => ({
  fetchRecentScreenLoadHealthEvents: async () => ({ data: [], error: null }),
  fetchLatestDailyReportEvent: async (_sb: unknown, topic: string, opts: { reportDate?: string; env?: string } = {}) => ({
    data: mockStore
      .filter((r) => r.topic === topic)
      .filter((r) => !opts.env || r.metadata.env === opts.env)
      .filter((r) => !opts.reportDate || r.metadata.report_date === opts.reportDate)
      .slice(0, 1),
    error: null,
  }),
}));

let mockHtml: string | null = '';
const mockLiveDeps = jest.fn();
jest.mock('../src/services/screen-load-daily-report', () => {
  const actual = jest.requireActual('../src/services/screen-load-daily-report');
  return {
    ...actual,
    createLiveDailyReportDeps: (_sb: unknown, now: Date) => {
      mockLiveDeps();
      return {
        now,
        fetchEvents: async () => [],
        fetchProdHtml: async () => mockHtml,
        fetchVerifiedCommits: async () => ['abcdef1234567890abcdef1234567890abcdef12'],
      };
    },
  };
});

import { screenLoadHealthRouter } from '../src/routes/screen-load-health';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/frontend/screen-load', screenLoadHealthRouter);
  return a;
}
const RUN = '/api/v1/frontend/screen-load/daily-report/run';
const TOKEN = 'svc-token-05062';

beforeEach(() => {
  mockStore.length = 0;
  mockEmit.mockClear();
  mockGChat.mockClear();
  mockLiveDeps.mockClear();
  mockHtml = '<meta name="vitana-app-version" content="abcdef123456">';
  process.env.GATEWAY_SERVICE_TOKEN = TOKEN;
});
afterAll(() => {
  delete process.env.GATEWAY_SERVICE_TOKEN;
});

describe('POST /daily-report/run — auth', () => {
  it('401 without a bearer token; nothing built, emitted or posted', async () => {
    const res = await request(app()).post(RUN).send({});
    expect(res.status).toBe(401);
    expect(mockLiveDeps).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockGChat).not.toHaveBeenCalled();
  });

  it('401 with a wrong token', async () => {
    const res = await request(app()).post(RUN).set('Authorization', 'Bearer nope').send({});
    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('POST /daily-report/run — idempotent per UTC day', () => {
  it('first call builds, emits screen.load.daily_report and posts GChat once; second call returns the same report', async () => {
    const first = await request(app()).post(RUN).set('Authorization', `Bearer ${TOKEN}`).send({});
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(true);
    // No telemetry in the fixture → insufficient data → yellow; build matches.
    expect(first.body.status).toBe('yellow');
    expect(first.body.health).toBe('degraded');
    expect(first.body.report.build.verdict).toBe('pass');
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const e = mockEmit.mock.calls[0][0];
    expect(e.type).toBe('screen.load.daily_report');
    expect(e.vtid).toBe('VTID-05062');
    expect(e.status).toBe('info');
    expect(e.payload.report_date).toBe(first.body.report.report_date);
    expect(e.payload.screens).toHaveLength(4);
    expect(mockGChat).toHaveBeenCalledTimes(1);
    expect(mockGChat.mock.calls[0][0]).toBe(first.body.report.gchat_text);

    const second = await request(app()).post(RUN).set('Authorization', `Bearer ${TOKEN}`).send({});
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.report.generated_at).toBe(first.body.report.generated_at);
    expect(second.body.report.gchat_text).toBe(first.body.report.gchat_text);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockGChat).toHaveBeenCalledTimes(1);
    expect(mockLiveDeps).toHaveBeenCalledTimes(1);
  });

  it('two concurrent calls build once and post GChat once', async () => {
    const [a, b] = await Promise.all([
      request(app()).post(RUN).set('Authorization', `Bearer ${TOKEN}`).send({}),
      request(app()).post(RUN).set('Authorization', `Bearer ${TOKEN}`).send({}),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockGChat).toHaveBeenCalledTimes(1);
  });

  it('?force=true rebuilds, emits and posts again', async () => {
    await request(app()).post(RUN).set('Authorization', `Bearer ${TOKEN}`).send({});
    mockHtml = null; // production HTML now unavailable → red
    const forced = await request(app()).post(`${RUN}?force=true`).set('Authorization', `Bearer ${TOKEN}`).send({});
    expect(forced.status).toBe(200);
    expect(forced.body.created).toBe(true);
    expect(forced.body.status).toBe('red');
    expect(mockEmit).toHaveBeenCalledTimes(2);
    expect(mockEmit.mock.calls[1][0].status).toBe('error');
    expect(mockGChat).toHaveBeenCalledTimes(2);
  });

  it('a report from yesterday does not satisfy today', async () => {
    mockStore.push({
      created_at: '2020-01-01T06:00:00.000Z',
      topic: 'screen.load.daily_report',
      metadata: { report_date: '2020-01-01', env: 'production', health: 'ok', status: 'green' },
    });
    const res = await request(app()).post(RUN).set('Authorization', `Bearer ${TOKEN}`).send({});
    expect(res.body.created).toBe(true);
    expect(mockGChat).toHaveBeenCalledTimes(1);
  });

  it('emit failure → 500 and no GChat post', async () => {
    mockEmit.mockResolvedValueOnce({ ok: false, error: 'db down' } as any);
    const res = await request(app()).post(RUN).set('Authorization', `Bearer ${TOKEN}`).send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('emit_failed');
    expect(mockGChat).not.toHaveBeenCalled();
  });

  it('Google Chat post fails → 502 so the workflow goes red (the day\'s alert is never silently lost)', async () => {
    mockGChat.mockResolvedValueOnce({ ok: false, webhook_set: true, status: 500 });
    const res = await request(app()).post(RUN).set('Authorization', `Bearer ${TOKEN}`).send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('gchat_failed');
    expect(res.body.detail).toContain('force=true');
  });

  it('Google Chat webhook unset → 502 as well', async () => {
    mockGChat.mockResolvedValueOnce({ ok: false, webhook_set: false, status: 0 });
    const res = await request(app()).post(RUN).set('Authorization', `Bearer ${TOKEN}`).send({});
    expect(res.status).toBe(502);
    expect(res.body.detail).toContain('not configured');
  });
});

describe('GET /daily-report', () => {
  it('no report yet → down/no_report (public, no auth)', async () => {
    const res = await request(app()).get('/api/v1/frontend/screen-load/daily-report');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'down', reason: 'no_report' });
  });

  it('returns the latest report in the health shape', async () => {
    await request(app()).post(RUN).set('Authorization', `Bearer ${TOKEN}`).send({});
    const res = await request(app()).get('/api/v1/frontend/screen-load/daily-report');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.report_status).toBe('yellow');
    expect(res.body.screens).toHaveLength(4);
    expect(res.body.build.verdict).toBe('pass');
  });

  it('a report older than 36 h reads down/report_stale', async () => {
    mockStore.push({
      created_at: '2020-01-01T06:00:00.000Z',
      topic: 'screen.load.daily_report',
      metadata: { report_date: '2020-01-01', env: 'production', health: 'ok', status: 'green' },
    });
    const res = await request(app()).get('/api/v1/frontend/screen-load/daily-report');
    expect(res.body).toMatchObject({ status: 'down', reason: 'report_stale', report_status: 'green' });
  });
});
