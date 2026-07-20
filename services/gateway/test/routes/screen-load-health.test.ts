/**
 * VTID-SCREEN-LOAD-01: tests for the `/api/v1/frontend/screen-load` router.
 *
 * Coverage matrix:
 *   POST /report
 *     1. Missing Authorization → 401, NOT emitted.
 *     2. Wrong service token → 401, NOT emitted.
 *     3. Correct service token + valid body → 204, emitOasisEvent called
 *        once per screen.
 *     4. Correct service token + invalid body (missing results) → 400.
 *     5. A screen with status:'error' → emitted with status:'error'.
 *     6. A screen over the slow threshold → emitted with status:'warning'.
 *     7. emitOasisEvent throwing → 500.
 *   GET /health
 *     8. No recent events → 'down' (no_recent_runs).
 *     9. Recent run, all fast, none failed → 'ok'.
 *    10. Recent run, p75 over threshold → 'degraded'.
 *    11. Recent run with a failed screen → 'down'.
 *    12. Supabase unconfigured (getSupabase() → null) → 'down'.
 *   GET /
 *    13. Router self-description → 200.
 */

import request from 'supertest';
import express from 'express';

const mockEmit = jest.fn(async () => ({ ok: true, event_id: 'evt-test-1' }));
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => (mockEmit as any)(...args),
}));

// Chainable Supabase query-builder mock: `.from().select().eq().gte().order().limit()`
// resolves to whatever `mockQueryResult` is set to for that test.
let mockQueryResult: { data: any[] | null; error: { message: string } | null } = { data: [], error: null };
let mockGetSupabase: () => any = () => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        gte: () => ({
          order: () => ({
            limit: () => Promise.resolve(mockQueryResult),
          }),
        }),
      }),
    }),
  }),
});
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(),
}));

import { screenLoadHealthRouter } from '../../src/routes/screen-load-health';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/frontend/screen-load', screenLoadHealthRouter);
  return app;
}

const VALID_BODY = {
  run_id: 'run-1',
  environment: 'production' as const,
  results: [{ screen: '/home', duration_ms: 1200, lcp_ms: 900, status: 'ok' as const }],
};

beforeEach(() => {
  mockEmit.mockClear();
  mockEmit.mockResolvedValue({ ok: true, event_id: 'evt-test-1' });
  mockQueryResult = { data: [], error: null };
  mockGetSupabase = () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            order: () => ({
              limit: () => Promise.resolve(mockQueryResult),
            }),
          }),
        }),
      }),
    }),
  });
  process.env.GATEWAY_SERVICE_TOKEN = 'svc-secret-token-xyz';
});

afterAll(() => {
  delete process.env.GATEWAY_SERVICE_TOKEN;
});

describe('POST /api/v1/frontend/screen-load/report — auth gate', () => {
  it('1. missing Authorization → 401, NOT emitted', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/frontend/screen-load/report').send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('2. wrong service token → 401, NOT emitted', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/frontend/screen-load/report')
      .set('Authorization', 'Bearer wrong-token')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/frontend/screen-load/report — happy path', () => {
  it('3. correct token + valid body → 204, emitOasisEvent called once per screen', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/frontend/screen-load/report')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send(VALID_BODY);
    expect(res.status).toBe(204);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.type).toBe('screen.load.synthetic_test');
    expect(call.status).toBe('success');
    expect(call.payload).toMatchObject({ run_id: 'run-1', screen: '/home', duration_ms: 1200 });
  });

  it('5. screen with status:error → emitted with status:error', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/frontend/screen-load/report')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({
        run_id: 'run-2',
        results: [{ screen: '/discover', duration_ms: 20000, status: 'error', error: 'net::ERR_TIMED_OUT' }],
      });
    expect(res.status).toBe(204);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0].status).toBe('error');
  });

  it('6. screen over slow threshold → emitted with status:warning', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/frontend/screen-load/report')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({
        run_id: 'run-3',
        results: [{ screen: '/health', duration_ms: 7000, status: 'ok' }],
      });
    expect(res.status).toBe(204);
    expect(mockEmit.mock.calls[0][0].status).toBe('warning');
  });
});

describe('POST /api/v1/frontend/screen-load/report — body validation', () => {
  it('4. missing results array → 400, NOT emitted', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/frontend/screen-load/report')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ run_id: 'run-4' });
    expect(res.status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/frontend/screen-load/report — ingest failure', () => {
  it('7. emitOasisEvent throwing → 500', async () => {
    mockEmit.mockRejectedValueOnce(new Error('supabase exploded'));
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/frontend/screen-load/report')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

describe('GET /api/v1/frontend/screen-load/health', () => {
  it('8. no recent events → down (no_recent_runs)', async () => {
    mockQueryResult = { data: [], error: null };
    const app = buildApp();
    const res = await request(app).get('/api/v1/frontend/screen-load/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('down');
    expect(res.body.reason).toBe('no_recent_runs');
  });

  it('9. recent run, all fast, none failed → ok', async () => {
    const now = new Date().toISOString();
    mockQueryResult = {
      data: [
        { created_at: now, metadata: { screen: '/home', duration_ms: 1000, load_status: 'ok' } },
        { created_at: now, metadata: { screen: '/discover', duration_ms: 1500, load_status: 'ok' } },
      ],
      error: null,
    };
    const app = buildApp();
    const res = await request(app).get('/api/v1/frontend/screen-load/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.screens_checked).toBe(2);
  });

  it('10. recent run, p75 over threshold → degraded', async () => {
    const now = new Date().toISOString();
    mockQueryResult = {
      data: [
        { created_at: now, metadata: { screen: '/home', duration_ms: 8000, load_status: 'ok' } },
        { created_at: now, metadata: { screen: '/discover', duration_ms: 7500, load_status: 'ok' } },
      ],
      error: null,
    };
    const app = buildApp();
    const res = await request(app).get('/api/v1/frontend/screen-load/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });

  it('11. recent run with a failed screen → down', async () => {
    const now = new Date().toISOString();
    mockQueryResult = {
      data: [{ created_at: now, metadata: { screen: '/inbox', duration_ms: 0, load_status: 'error' } }],
      error: null,
    };
    const app = buildApp();
    const res = await request(app).get('/api/v1/frontend/screen-load/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('down');
    expect(res.body.screens_failed).toContain('/inbox');
  });

  it('12. supabase unconfigured → down', async () => {
    mockGetSupabase = () => null;
    const app = buildApp();
    const res = await request(app).get('/api/v1/frontend/screen-load/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('down');
    expect(res.body.reason).toBe('supabase_unconfigured');
  });
});

describe('GET /api/v1/frontend/screen-load/', () => {
  it('13. router self-description → 200', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/frontend/screen-load/');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('screen-load-health');
  });
});
