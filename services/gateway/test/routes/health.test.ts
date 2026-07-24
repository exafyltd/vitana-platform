import request from 'supertest';
import express from 'express';

jest.mock('../../src/lib/supabase-user');
jest.mock('../../src/lib/supabase');
jest.mock('../../src/services/oasis-event-service');

import healthRouter from '../../src/routes/health';
import { createUserSupabaseClient } from '../../src/lib/supabase-user';
import { getSupabase } from '../../src/lib/supabase';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

const mockCreateUserSupabaseClient = createUserSupabaseClient as jest.MockedFunction<typeof createUserSupabaseClient>;
const mockGetSupabase = getSupabase as jest.MockedFunction<typeof getSupabase>;
const mockEmitOasisEvent = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;

const TOKEN = 'test-jwt-token';
const AUTH_HEADER = `Bearer ${TOKEN}`;

const GOOD_CTX = { tenant_id: 't1', user_id: 'u1', active_role: 'DEV' };

function makeFromChain() {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.eq = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.order = jest.fn().mockResolvedValue({ data: [], error: null });
  chain.upsert = jest.fn().mockResolvedValue({ data: null, error: null });
  chain.single = jest.fn().mockResolvedValue({ data: null, error: null });
  chain.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
  return chain;
}

function makeSupabaseMock() {
  const fromChain = makeFromChain();
  const mock: any = {
    rpc: jest.fn(),
    from: jest.fn().mockReturnValue(fromChain),
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }),
    },
    _fromChain: fromChain,
  };
  return mock;
}

const testApp = express();
testApp.use(express.json());
testApp.use('/', healthRouter);

describe('Health Router', () => {
  let supabaseMock: ReturnType<typeof makeSupabaseMock>;
  let adminMock: ReturnType<typeof makeSupabaseMock>;

  beforeEach(() => {
    jest.clearAllMocks();
    supabaseMock = makeSupabaseMock();
    adminMock = makeSupabaseMock();
    mockCreateUserSupabaseClient.mockReturnValue(supabaseMock as any);
    mockGetSupabase.mockReturnValue(adminMock as any);
    mockEmitOasisEvent.mockResolvedValue(undefined as any);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 } as any);
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  });

  // ============================================================
  // GET /
  // ============================================================
  describe('GET /', () => {
    it('returns 200 with ok:true and 6 endpoints', async () => {
      const res = await request(testApp).get('/');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.endpoints)).toBe(true);
      expect(res.body.endpoints).toHaveLength(6);
    });
  });

  // ============================================================
  // POST /lab-reports/ingest
  // ============================================================
  describe('POST /lab-reports/ingest', () => {
    it('returns 401 when Authorization header is absent', async () => {
      const res = await request(testApp).post('/lab-reports/ingest').send({});
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });

    it('returns 401 when me_context returns a JWT error', async () => {
      supabaseMock.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'JWT expired', code: 'PGRST301' },
      });
      const res = await request(testApp)
        .post('/lab-reports/ingest')
        .set('Authorization', AUTH_HEADER)
        .send({ provider: 'lab', report_date: '2026-01-01', biomarkers: [] });
      expect(res.status).toBe(401);
    });

    it('returns 400 when me_context returns a generic error', async () => {
      supabaseMock.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'Connection refused' },
      });
      const res = await request(testApp)
        .post('/lab-reports/ingest')
        .set('Authorization', AUTH_HEADER)
        .send({ provider: 'lab', report_date: '2026-01-01', biomarkers: [] });
      expect(res.status).toBe(400);
    });

    it('returns 400 for missing required body fields', async () => {
      supabaseMock.rpc.mockResolvedValueOnce({ data: GOOD_CTX, error: null });
      const res = await request(testApp)
        .post('/lab-reports/ingest')
        .set('Authorization', AUTH_HEADER)
        .send({ provider: 'lab' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns 502 for a generic RPC error', async () => {
      supabaseMock.rpc
        .mockResolvedValueOnce({ data: GOOD_CTX, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: 'DB error', code: '42P01' } });
      const res = await request(testApp)
        .post('/lab-reports/ingest')
        .set('Authorization', AUTH_HEADER)
        .send({ provider: 'lab', report_date: '2026-01-01', biomarkers: [{ name: 'glucose', value: 95 }] });
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('UPSTREAM_ERROR');
    });

    it('returns 401 when the ingest RPC returns a PGRST301 JWT error', async () => {
      supabaseMock.rpc
        .mockResolvedValueOnce({ data: GOOD_CTX, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: 'JWT expired', code: 'PGRST301' } });
      const res = await request(testApp)
        .post('/lab-reports/ingest')
        .set('Authorization', AUTH_HEADER)
        .send({ provider: 'lab', report_date: '2026-01-01', biomarkers: [{ name: 'glucose', value: 95 }] });
      expect(res.status).toBe(401);
    });

    it('returns 200 with lab_report_id and biomarker_count on success', async () => {
      supabaseMock.rpc
        .mockResolvedValueOnce({ data: GOOD_CTX, error: null })
        .mockResolvedValueOnce({ data: { lab_report_id: 'lr-123', biomarker_count: 3 }, error: null });
      const res = await request(testApp)
        .post('/lab-reports/ingest')
        .set('Authorization', AUTH_HEADER)
        .send({ provider: 'lab', report_date: '2026-01-01', biomarkers: [{ name: 'glucose', value: 95 }] });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.lab_report_id).toBe('lr-123');
      expect(res.body.biomarker_count).toBe(3);
    });
  });

  // ============================================================
  // POST /wearables/ingest
  // ============================================================
  describe('POST /wearables/ingest', () => {
    it('returns 401 when Authorization header is absent', async () => {
      const res = await request(testApp).post('/wearables/ingest').send({});
      expect(res.status).toBe(401);
    });

    it('returns 400 when me_context fails', async () => {
      supabaseMock.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'DB error' },
      });
      const res = await request(testApp)
        .post('/wearables/ingest')
        .set('Authorization', AUTH_HEADER)
        .send({ provider: 'fitbit', samples: [] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when samples field is missing', async () => {
      supabaseMock.rpc.mockResolvedValueOnce({ data: GOOD_CTX, error: null });
      const res = await request(testApp)
        .post('/wearables/ingest')
        .set('Authorization', AUTH_HEADER)
        .send({ provider: 'fitbit' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns 502 for an RPC error', async () => {
      supabaseMock.rpc
        .mockResolvedValueOnce({ data: GOOD_CTX, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: 'DB down', code: '500' } });
      const res = await request(testApp)
        .post('/wearables/ingest')
        .set('Authorization', AUTH_HEADER)
        .send({ provider: 'fitbit', samples: [{ type: 'heart_rate', value: 72 }] });
      expect(res.status).toBe(502);
    });

    it('returns 200 with inserted_count on success', async () => {
      supabaseMock.rpc
        .mockResolvedValueOnce({ data: GOOD_CTX, error: null })
        .mockResolvedValueOnce({ data: { inserted_count: 10 }, error: null });
      const res = await request(testApp)
        .post('/wearables/ingest')
        .set('Authorization', AUTH_HEADER)
        .send({ provider: 'fitbit', samples: [{ type: 'heart_rate', value: 72 }] });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.inserted_count).toBe(10);
    });
  });

  // ============================================================
  // POST /recompute/daily
  // ============================================================
  describe('POST /recompute/daily', () => {
    it('returns 401 when Authorization header is absent', async () => {
      const res = await request(testApp)
        .post('/recompute/daily')
        .send({ date: '2026-01-01' });
      expect(res.status).toBe(401);
    });

    it('returns 400 for a bad date format', async () => {
      const res = await request(testApp)
        .post('/recompute/daily')
        .set('Authorization', AUTH_HEADER)
        .send({ date: '01-01-2026' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_DATE');
    });

    it('returns 400 when features RPC errors', async () => {
      supabaseMock.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'features failed' },
      });
      const res = await request(testApp)
        .post('/recompute/daily')
        .set('Authorization', AUTH_HEADER)
        .send({ date: '2026-01-01' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('FEATURES_COMPUTE_FAILED');
    });

    it('returns 400 when features RPC returns ok:false', async () => {
      supabaseMock.rpc.mockResolvedValueOnce({
        data: { ok: false, error: 'NO_DATA' },
        error: null,
      });
      const res = await request(testApp)
        .post('/recompute/daily')
        .set('Authorization', AUTH_HEADER)
        .send({ date: '2026-01-01' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NO_DATA');
    });

    it('returns 400 when index RPC errors — features OASIS event already emitted', async () => {
      supabaseMock.rpc
        .mockResolvedValueOnce({
          data: { ok: true, upserted_count: 5, tenant_id: 't1', user_id: 'u1' },
          error: null,
        })
        .mockResolvedValueOnce({ data: null, error: { message: 'index failed' } });
      const res = await request(testApp)
        .post('/recompute/daily')
        .set('Authorization', AUTH_HEADER)
        .send({ date: '2026-01-01' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INDEX_COMPUTE_FAILED');
      expect(mockEmitOasisEvent).toHaveBeenCalledTimes(2);
    });

    it('returns 400 when index RPC returns ok:false', async () => {
      supabaseMock.rpc
        .mockResolvedValueOnce({
          data: { ok: true, upserted_count: 5, tenant_id: 't1', user_id: 'u1' },
          error: null,
        })
        .mockResolvedValueOnce({ data: { ok: false, error: 'STALE_DATA' }, error: null });
      const res = await request(testApp)
        .post('/recompute/daily')
        .set('Authorization', AUTH_HEADER)
        .send({ date: '2026-01-01' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('STALE_DATA');
    });

    it('returns 400 when recs RPC errors', async () => {
      supabaseMock.rpc
        .mockResolvedValueOnce({
          data: { ok: true, upserted_count: 5, tenant_id: 't1', user_id: 'u1' },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { ok: true, score_total: 72, model_version: 'v1', tenant_id: 't1', user_id: 'u1' },
          error: null,
        })
        .mockResolvedValueOnce({ data: null, error: { message: 'recs failed' } });
      const res = await request(testApp)
        .post('/recompute/daily')
        .set('Authorization', AUTH_HEADER)
        .send({ date: '2026-01-01' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('RECOMMENDATIONS_FAILED');
    });

    it('returns 200 on full pipeline success and emits exactly 3 OASIS events', async () => {
      supabaseMock.rpc
        .mockResolvedValueOnce({
          data: { ok: true, upserted_count: 5, tenant_id: 't1', user_id: 'u1' },
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            ok: true,
            score_total: 72,
            score_physical: 70,
            score_mental: 74,
            score_nutritional: 72,
            score_social: 68,
            score_environmental: 76,
            score_prosperity: 71,
            model_version: 'v1',
            confidence: 0.9,
            tenant_id: 't1',
            user_id: 'u1',
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { ok: true, created_count: 3, model_version: 'v1', tenant_id: 't1', user_id: 'u1' },
          error: null,
        });
      const res = await request(testApp)
        .post('/recompute/daily')
        .set('Authorization', AUTH_HEADER)
        .send({ date: '2026-01-01' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.features.ok).toBe(true);
      expect(res.body.index.score_total).toBe(72);
      expect(res.body.recommendations.created_count).toBe(3);
      expect(mockEmitOasisEvent).toHaveBeenCalledTimes(3);
    });
  });

  // ============================================================
  // GET /summary
  // ============================================================
  describe('GET /summary', () => {
    it('returns 401 when Authorization header is absent', async () => {
      const res = await request(testApp).get('/summary?date=2026-01-01');
      expect(res.status).toBe(401);
    });

    it('returns 400 when date query param is missing', async () => {
      const res = await request(testApp)
        .get('/summary')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_DATE');
    });

    it('returns 400 for an invalid date format', async () => {
      const res = await request(testApp)
        .get('/summary?date=not-a-date')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(400);
    });

    it('returns 200 with null index when PGRST116 (row not found) — graceful degradation', async () => {
      supabaseMock._fromChain.single.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST116', message: 'Not found' },
      });
      supabaseMock._fromChain.order.mockResolvedValueOnce({ data: [], error: null });
      const res = await request(testApp)
        .get('/summary?date=2026-01-01')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.index).toBeNull();
      expect(res.body.recommendations).toHaveLength(0);
    });

    it('returns 200 with index and recommendations on success', async () => {
      supabaseMock._fromChain.single.mockResolvedValueOnce({
        data: {
          score_total: 78,
          score_physical: 80,
          score_mental: 76,
          score_nutritional: 78,
          score_social: 72,
          score_environmental: 84,
          score_prosperity: 75,
          model_version: 'v1',
          confidence: 0.92,
        },
        error: null,
      });
      supabaseMock._fromChain.order.mockResolvedValueOnce({
        data: [
          {
            id: 'r1',
            recommendation_type: 'sleep',
            priority: 1,
            title: 'Sleep more',
            description: 'Go to bed earlier',
            action_items: [],
            safety_checked: true,
            expires_at: null,
          },
        ],
        error: null,
      });
      const res = await request(testApp)
        .get('/summary?date=2026-01-01')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.index.score_total).toBe(78);
      expect(res.body.recommendations).toHaveLength(1);
      expect(res.body.recommendation_count).toBe(1);
    });
  });

  // ============================================================
  // POST /baseline-survey
  // ============================================================
  describe('POST /baseline-survey', () => {
    it('returns 401 when Authorization header is absent', async () => {
      const res = await request(testApp)
        .post('/baseline-survey')
        .send({ physical: 3, mental: 3, nutritional: 3 });
      expect(res.status).toBe(401);
    });

    it('returns 400 for a non-integer rating', async () => {
      const res = await request(testApp)
        .post('/baseline-survey')
        .set('Authorization', AUTH_HEADER)
        .send({ physical: 3.5, mental: 3, nutritional: 3 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_RATING');
    });

    it('returns 400 for an out-of-range rating', async () => {
      const res = await request(testApp)
        .post('/baseline-survey')
        .set('Authorization', AUTH_HEADER)
        .send({ physical: 6, mental: 3, nutritional: 3 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_RATING');
    });

    it('returns 401 when the Supabase user lookup fails', async () => {
      supabaseMock.auth.getUser.mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'Invalid token' },
      });
      const res = await request(testApp)
        .post('/baseline-survey')
        .set('Authorization', AUTH_HEADER)
        .send({ physical: 3, mental: 3, nutritional: 3 });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 400 when the survey upsert fails', async () => {
      supabaseMock.rpc.mockResolvedValueOnce({ data: { tenant_id: 't1' }, error: null });
      supabaseMock._fromChain.upsert.mockResolvedValueOnce({
        data: null,
        error: { message: 'upsert failed' },
      });
      const res = await request(testApp)
        .post('/baseline-survey')
        .set('Authorization', AUTH_HEADER)
        .send({ physical: 3, mental: 3, nutritional: 3 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('SURVEY_WRITE_FAILED');
    });

    it('returns 200 with ok:true and index.score_total on success', async () => {
      // Legacy 3-question payload maps to 5 pillars (hydration/sleep default to 3).
      // Baseline curve: rating 3 → 25 per pillar; 5 pillars × 25 × weight 1.0 = 125.
      supabaseMock.rpc.mockResolvedValueOnce({ data: { tenant_id: 't1' }, error: null });
      const res = await request(testApp)
        .post('/baseline-survey')
        .set('Authorization', AUTH_HEADER)
        .send({ physical: 3, mental: 3, nutritional: 3 });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.index.score_total).toBe(125);
      expect(res.body.index.model_version).toBe('baseline-survey-v3-5pillar');
      // Survey row is written via the user client; the Day-0 score via the admin client
      expect(supabaseMock.from).toHaveBeenCalledWith('vitana_index_baseline_survey');
      expect(adminMock.from).toHaveBeenCalledWith('vitana_index_scores');
    });

    it('returns 200 and honors an explicit 5-pillar payload', async () => {
      // Curve: 1→10, 2→20, 3→25, 4→32, 5→40 → total 10+20+25+32+40 = 127
      supabaseMock.rpc.mockResolvedValueOnce({ data: { tenant_id: 't1' }, error: null });
      const res = await request(testApp)
        .post('/baseline-survey')
        .set('Authorization', AUTH_HEADER)
        .send({ nutrition: 1, hydration: 2, exercise: 3, sleep: 4, mental: 5 });
      expect(res.status).toBe(200);
      expect(res.body.index.score_total).toBe(127);
      expect(res.body.index.score_nutrition).toBe(10);
      expect(res.body.index.score_mental).toBe(40);
    });
  });

  // ============================================================
  // GET /baseline-survey/status
  // ============================================================
  describe('GET /baseline-survey/status', () => {
    it('returns 401 when Authorization header is absent', async () => {
      const res = await request(testApp).get('/baseline-survey/status');
      expect(res.status).toBe(401);
    });

    it('returns 401 when the Supabase user lookup fails', async () => {
      supabaseMock.auth.getUser.mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'Invalid token' },
      });
      const res = await request(testApp)
        .get('/baseline-survey/status')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 400 on DB error', async () => {
      supabaseMock._fromChain.maybeSingle.mockResolvedValueOnce({
        data: null,
        error: { message: 'DB error' },
      });
      const res = await request(testApp)
        .get('/baseline-survey/status')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(400);
    });

    it('returns completed:true when both survey row and score row exist', async () => {
      // User client: survey row
      supabaseMock._fromChain.maybeSingle.mockResolvedValueOnce({
        data: { completed_at: '2026-01-01T00:00:00Z' },
        error: null,
      });
      // Admin client: vitana_index_scores row
      adminMock._fromChain.maybeSingle.mockResolvedValueOnce({
        data: { id: 'score-1' },
        error: null,
      });
      const res = await request(testApp)
        .get('/baseline-survey/status')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.completed).toBe(true);
      expect(res.body.has_survey).toBe(true);
      expect(res.body.has_score).toBe(true);
      expect(res.body.completed_at).toBe('2026-01-01T00:00:00Z');
    });

    it('returns completed:false when the survey exists but no score was written', async () => {
      supabaseMock._fromChain.maybeSingle.mockResolvedValueOnce({
        data: { completed_at: '2026-01-01T00:00:00Z' },
        error: null,
      });
      // Admin score lookup finds nothing (default maybeSingle → { data: null })
      const res = await request(testApp)
        .get('/baseline-survey/status')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.completed).toBe(false);
      expect(res.body.has_survey).toBe(true);
      expect(res.body.has_score).toBe(false);
    });

    it('returns completed:false when no survey row exists', async () => {
      supabaseMock._fromChain.maybeSingle.mockResolvedValueOnce({
        data: null,
        error: null,
      });
      const res = await request(testApp)
        .get('/baseline-survey/status')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).toBe(200);
      expect(res.body.completed).toBe(false);
    });
  });
});