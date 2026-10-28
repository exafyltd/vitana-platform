/**
 * Tests for src/routes/life-stage-awareness.ts (D40)
 *
 * Mounted at /api/v1/life-stage:
 *   POST /assess               GET  /current
 *   POST /override/:assessmentId   GET /explain/:assessmentId
 *   GET  /orb-context          POST /process
 *   POST /goals/detect         GET  /goals        PATCH /goals/:goalId
 *   POST /trajectory/score     GET  /rules
 *
 * Auth is bespoke (not the shared requireAuth middleware): every handler
 * pulls a raw Bearer token via getBearerToken() and rejects with 401 unless
 * either a token is present or isDevSandbox() is true (ENVIRONMENT/
 * VITANA_ENV containing "dev"/"sandbox"). Tests run with neither env var
 * set, so the unauthenticated-token path is exercised for real.
 */
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAssessLifeStage = jest.fn();
const mockGetCurrentLifeStage = jest.fn();
const mockOverrideLifeStage = jest.fn();
const mockExplainLifeStage = jest.fn();
const mockGetOrbLifeStageContext = jest.fn();
const mockProcessForOrb = jest.fn();
const mockDetectGoal = jest.fn();
const mockGetGoals = jest.fn();
const mockUpdateGoal = jest.fn();
const mockScoreTrajectory = jest.fn();

jest.mock('../../src/services/d40-life-stage-awareness-engine', () => ({
  assessLifeStage: (...args: any[]) => mockAssessLifeStage(...args),
  getCurrentLifeStage: (...args: any[]) => mockGetCurrentLifeStage(...args),
  overrideLifeStage: (...args: any[]) => mockOverrideLifeStage(...args),
  explainLifeStage: (...args: any[]) => mockExplainLifeStage(...args),
  getOrbLifeStageContext: (...args: any[]) => mockGetOrbLifeStageContext(...args),
  processForOrb: (...args: any[]) => mockProcessForOrb(...args),
  detectGoal: (...args: any[]) => mockDetectGoal(...args),
  getGoals: (...args: any[]) => mockGetGoals(...args),
  updateGoal: (...args: any[]) => mockUpdateGoal(...args),
  scoreTrajectory: (...args: any[]) => mockScoreTrajectory(...args),
}));

// GET /rules bypasses the service module and queries Supabase directly via
// a user-scoped client.
const mockRulesChain: any = {
  select: jest.fn(() => mockRulesChain),
  eq: jest.fn(() => mockRulesChain),
  order: jest.fn(() => mockRulesChain),
  then: jest.fn((resolve: (v: any) => any) => Promise.resolve(mockRulesChain.__result).then(resolve)),
  __result: { data: [], error: null },
};
const mockUserSupabase = { from: jest.fn(() => mockRulesChain) };
const mockCreateUserSupabaseClient = jest.fn(() => mockUserSupabase as any);

jest.mock('../../src/lib/supabase-user', () => ({
  createUserSupabaseClient: (...args: any[]) => mockCreateUserSupabaseClient(...args),
}));

import router from '../../src/routes/life-stage-awareness';

const app = express();
app.use(express.json());
app.use('/api/v1/life-stage', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = 'valid-user-jwt';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const ASSESSMENT_ID = 'assess-123';
const GOAL_ID = 'goal-123';

describe('Life Stage Awareness Routes (D40)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENVIRONMENT;
    delete process.env.VITANA_ENV;
    mockRulesChain.__result = { data: [], error: null };
  });

  // --- Auth: no token + not dev-sandbox -> 401 across every endpoint ---

  describe('Authorization (no Authorization header, non-dev environment)', () => {
    const endpoints: Array<{ method: 'get' | 'post' | 'patch'; url: string; body?: object }> = [
      { method: 'post', url: '/api/v1/life-stage/assess' },
      { method: 'get', url: '/api/v1/life-stage/current' },
      { method: 'post', url: `/api/v1/life-stage/override/${ASSESSMENT_ID}`, body: { availability_level: 'busy' } },
      { method: 'get', url: `/api/v1/life-stage/explain/${ASSESSMENT_ID}` },
      { method: 'get', url: '/api/v1/life-stage/orb-context' },
      { method: 'post', url: '/api/v1/life-stage/process' },
      { method: 'post', url: '/api/v1/life-stage/goals/detect', body: { source: 'explicit' } },
      { method: 'get', url: '/api/v1/life-stage/goals' },
      { method: 'patch', url: `/api/v1/life-stage/goals/${GOAL_ID}`, body: { status: 'active' } },
      { method: 'post', url: '/api/v1/life-stage/trajectory/score', body: { actions: ['a'] } },
      { method: 'get', url: '/api/v1/life-stage/rules' },
    ];

    endpoints.forEach(({ method, url, body }) => {
      it(`returns 401 for ${method.toUpperCase()} ${url}`, async () => {
        const res = await request(app)[method](url).send(body || {});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('UNAUTHENTICATED');
      });
    });
  });

  it('allows unauthenticated requests when running in dev-sandbox', async () => {
    process.env.ENVIRONMENT = 'dev-sandbox';
    mockGetCurrentLifeStage.mockResolvedValue({ ok: true, needs_refresh: false });

    const res = await request(app).get('/api/v1/life-stage/current');

    expect(res.status).toBe(200);
    expect(mockGetCurrentLifeStage).toHaveBeenCalledWith(undefined, undefined);
  });

  // --- POST /assess ---

  describe('POST /api/v1/life-stage/assess', () => {
    it('assesses life stage on the happy path', async () => {
      mockAssessLifeStage.mockResolvedValue({ ok: true, life_stage: { phase: 'building' } });

      const res = await request(app)
        .post('/api/v1/life-stage/assess')
        .set(AUTH)
        .send({ session_id: 'sess-1', include_trajectory: true, context_window_days: 14 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.life_stage).toEqual({ phase: 'building' });
      expect(mockAssessLifeStage).toHaveBeenCalledWith(
        { session_id: 'sess-1', include_goals: true, include_trajectory: true, context_window_days: 14 },
        TOKEN,
      );
    });

    it('applies request defaults when fields are omitted', async () => {
      mockAssessLifeStage.mockResolvedValue({ ok: true, life_stage: {} });

      await request(app).post('/api/v1/life-stage/assess').set(AUTH).send({});

      expect(mockAssessLifeStage).toHaveBeenCalledWith(
        { session_id: undefined, include_goals: true, include_trajectory: false, context_window_days: 30 },
        TOKEN,
      );
    });

    it('maps an UNAUTHENTICATED engine error to 401', async () => {
      mockAssessLifeStage.mockResolvedValue({ ok: false, error: 'UNAUTHENTICATED' });

      const res = await request(app).post('/api/v1/life-stage/assess').set(AUTH).send({});

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('maps any other engine error to 500', async () => {
      mockAssessLifeStage.mockResolvedValue({ ok: false, error: 'RPC_FAILED' });

      const res = await request(app).post('/api/v1/life-stage/assess').set(AUTH).send({});

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('RPC_FAILED');
    });
  });

  // --- GET /current ---

  describe('GET /api/v1/life-stage/current', () => {
    it('returns the current assessment on the happy path', async () => {
      mockGetCurrentLifeStage.mockResolvedValue({ ok: true, needs_refresh: false, life_stage: { phase: 'building' } });

      const res = await request(app)
        .get('/api/v1/life-stage/current')
        .query({ session_id: 'sess-9' })
        .set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.needs_refresh).toBe(false);
      expect(mockGetCurrentLifeStage).toHaveBeenCalledWith('sess-9', TOKEN);
    });

    it('maps a not-authenticated engine error to 401', async () => {
      mockGetCurrentLifeStage.mockResolvedValue({ ok: false, error: 'UNAUTHENTICATED', needs_refresh: false });

      const res = await request(app).get('/api/v1/life-stage/current').set(AUTH);

      expect(res.status).toBe(401);
    });

    it('maps a generic engine failure to 500', async () => {
      mockGetCurrentLifeStage.mockResolvedValue({ ok: false, error: 'DB_ERROR', needs_refresh: false });

      const res = await request(app).get('/api/v1/life-stage/current').set(AUTH);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB_ERROR');
    });
  });

  // --- POST /override/:assessmentId ---

  describe('POST /api/v1/life-stage/override/:assessmentId', () => {
    it('overrides an assessment on the happy path', async () => {
      mockOverrideLifeStage.mockResolvedValue({ ok: true, assessment_id: ASSESSMENT_ID });

      const res = await request(app)
        .post(`/api/v1/life-stage/override/${ASSESSMENT_ID}`)
        .set(AUTH)
        .send({ phase: 'stabilizing' });

      expect(res.status).toBe(200);
      expect(res.body.assessment_id).toBe(ASSESSMENT_ID);
      expect(mockOverrideLifeStage).toHaveBeenCalledWith(ASSESSMENT_ID, { phase: 'stabilizing' }, TOKEN);
    });

    it('passes an empty body through as a no-op override object (express.json() always yields {})', async () => {
      // The route's `!override || typeof override !== 'object'` guard is
      // defensive: express.json() sets req.body to {} for any request
      // regardless of Content-Type, so an "empty" request still reaches
      // the engine with an empty override object rather than 400ing.
      mockOverrideLifeStage.mockResolvedValue({ ok: true, assessment_id: ASSESSMENT_ID });

      const res = await request(app)
        .post(`/api/v1/life-stage/override/${ASSESSMENT_ID}`)
        .set(AUTH)
        .send();

      expect(res.status).toBe(200);
      expect(mockOverrideLifeStage).toHaveBeenCalledWith(ASSESSMENT_ID, {}, TOKEN);
    });

    it('returns 404 when the assessment does not exist', async () => {
      mockOverrideLifeStage.mockResolvedValue({ ok: false, error: 'ASSESSMENT_NOT_FOUND' });

      const res = await request(app)
        .post(`/api/v1/life-stage/override/${ASSESSMENT_ID}`)
        .set(AUTH)
        .send({ phase: 'stabilizing' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('ASSESSMENT_NOT_FOUND');
    });

    it('returns 500 for any other override failure', async () => {
      mockOverrideLifeStage.mockResolvedValue({ ok: false, error: 'WRITE_FAILED' });

      const res = await request(app)
        .post(`/api/v1/life-stage/override/${ASSESSMENT_ID}`)
        .set(AUTH)
        .send({ phase: 'stabilizing' });

      expect(res.status).toBe(500);
    });
  });

  // --- GET /explain/:assessmentId ---

  describe('GET /api/v1/life-stage/explain/:assessmentId', () => {
    it('returns explanation evidence on the happy path', async () => {
      mockExplainLifeStage.mockResolvedValue({ ok: true, assessment_id: ASSESSMENT_ID, rules_applied_keys: ['r1'] });

      const res = await request(app).get(`/api/v1/life-stage/explain/${ASSESSMENT_ID}`).set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.rules_applied_keys).toEqual(['r1']);
      expect(mockExplainLifeStage).toHaveBeenCalledWith(ASSESSMENT_ID, TOKEN);
    });

    it('returns 404 when the assessment is not found', async () => {
      mockExplainLifeStage.mockResolvedValue({ ok: false, error: 'ASSESSMENT_NOT_FOUND' });

      const res = await request(app).get(`/api/v1/life-stage/explain/${ASSESSMENT_ID}`).set(AUTH);

      expect(res.status).toBe(404);
    });

    it('returns 500 for other explain failures', async () => {
      mockExplainLifeStage.mockResolvedValue({ ok: false, error: 'EXPLAIN_FAILED' });

      const res = await request(app).get(`/api/v1/life-stage/explain/${ASSESSMENT_ID}`).set(AUTH);

      expect(res.status).toBe(500);
    });
  });

  // --- GET /orb-context ---

  describe('GET /api/v1/life-stage/orb-context', () => {
    it('returns has_life_stage:false when no context is available', async () => {
      mockGetOrbLifeStageContext.mockResolvedValue(null);

      const res = await request(app).get('/api/v1/life-stage/orb-context').set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, has_life_stage: false, context: null, orb_context: null });
    });

    it('returns formatted context when available', async () => {
      mockGetOrbLifeStageContext.mockResolvedValue({
        context: 'User is in a building phase.',
        orbContext: { phase: 'building', stability: 'stable', in_transition: false, active_goal_count: 2 },
      });

      const res = await request(app)
        .get('/api/v1/life-stage/orb-context')
        .query({ session_id: 'sess-1' })
        .set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.has_life_stage).toBe(true);
      expect(res.body.context).toBe('User is in a building phase.');
      expect(res.body.orb_context.phase).toBe('building');
      expect(mockGetOrbLifeStageContext).toHaveBeenCalledWith('sess-1', TOKEN);
    });
  });

  // --- POST /process ---

  describe('POST /api/v1/life-stage/process', () => {
    it('returns has_life_stage:false when processing yields nothing', async () => {
      mockProcessForOrb.mockResolvedValue(null);

      const res = await request(app).post('/api/v1/life-stage/process').set(AUTH).send({});

      expect(res.status).toBe(200);
      expect(res.body.has_life_stage).toBe(false);
    });

    it('returns the assessment id and formatted context on success', async () => {
      mockProcessForOrb.mockResolvedValue({
        context: 'ctx',
        orbContext: { phase: 'building', stability: 'stable', in_transition: false, active_goal_count: 0 },
        assessmentId: 'assess-999',
      });

      const res = await request(app)
        .post('/api/v1/life-stage/process')
        .set(AUTH)
        .send({ session_id: 'sess-1' });

      expect(res.status).toBe(200);
      expect(res.body.assessment_id).toBe('assess-999');
      expect(mockProcessForOrb).toHaveBeenCalledWith('sess-1', TOKEN);
    });
  });

  // --- POST /goals/detect ---

  describe('POST /api/v1/life-stage/goals/detect', () => {
    it('detects and registers a goal on the happy path', async () => {
      mockDetectGoal.mockResolvedValue({ ok: true, goal: { id: 'g1', category: 'health' } });

      const res = await request(app)
        .post('/api/v1/life-stage/goals/detect')
        .set(AUTH)
        .send({ message: 'I want to run a marathon', session_id: 'sess-1', source: 'conversation' });

      expect(res.status).toBe(200);
      expect(res.body.goal.id).toBe('g1');
      expect(mockDetectGoal).toHaveBeenCalledWith(
        { message: 'I want to run a marathon', session_id: 'sess-1', source: 'conversation' },
        TOKEN,
      );
    });

    it('returns 400 when source is missing', async () => {
      const res = await request(app)
        .post('/api/v1/life-stage/goals/detect')
        .set(AUTH)
        .send({ message: 'no source here' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_REQUEST');
      expect(mockDetectGoal).not.toHaveBeenCalled();
    });

    it('returns 500 on a non-auth engine failure', async () => {
      mockDetectGoal.mockResolvedValue({ ok: false, error: 'DETECT_FAILED' });

      const res = await request(app)
        .post('/api/v1/life-stage/goals/detect')
        .set(AUTH)
        .send({ source: 'explicit' });

      expect(res.status).toBe(500);
    });
  });

  // --- GET /goals ---

  describe('GET /api/v1/life-stage/goals', () => {
    it('returns the user goal list', async () => {
      mockGetGoals.mockResolvedValue({ ok: true, goals: [{ id: 'g1' }, { id: 'g2' }] });

      const res = await request(app).get('/api/v1/life-stage/goals').set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.goals).toHaveLength(2);
      expect(mockGetGoals).toHaveBeenCalledWith(TOKEN);
    });

    it('returns 500 on failure', async () => {
      mockGetGoals.mockResolvedValue({ ok: false, error: 'GOALS_FAILED' });

      const res = await request(app).get('/api/v1/life-stage/goals').set(AUTH);

      expect(res.status).toBe(500);
    });
  });

  // --- PATCH /goals/:goalId ---

  describe('PATCH /api/v1/life-stage/goals/:goalId', () => {
    it('updates a goal on the happy path', async () => {
      mockUpdateGoal.mockResolvedValue({ ok: true, goal: { id: GOAL_ID, status: 'completed' } });

      const res = await request(app)
        .patch(`/api/v1/life-stage/goals/${GOAL_ID}`)
        .set(AUTH)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
      expect(res.body.goal.status).toBe('completed');
      expect(mockUpdateGoal).toHaveBeenCalledWith(GOAL_ID, { status: 'completed' }, TOKEN);
    });

    it('passes an empty body through as a no-op update object (express.json() always yields {})', async () => {
      // Same defensive-guard caveat as the override route above: express.json()
      // always yields {} for req.body, so this never actually 400s in practice.
      mockUpdateGoal.mockResolvedValue({ ok: true, goal: { id: GOAL_ID } });

      const res = await request(app)
        .patch(`/api/v1/life-stage/goals/${GOAL_ID}`)
        .set(AUTH)
        .send();

      expect(res.status).toBe(200);
      expect(mockUpdateGoal).toHaveBeenCalledWith(GOAL_ID, {}, TOKEN);
    });

    it('returns 404 when the goal does not exist', async () => {
      mockUpdateGoal.mockResolvedValue({ ok: false, error: 'GOAL_NOT_FOUND' });

      const res = await request(app)
        .patch(`/api/v1/life-stage/goals/${GOAL_ID}`)
        .set(AUTH)
        .send({ status: 'archived' });

      expect(res.status).toBe(404);
    });

    it('returns 500 for other update failures', async () => {
      mockUpdateGoal.mockResolvedValue({ ok: false, error: 'UPDATE_FAILED' });

      const res = await request(app)
        .patch(`/api/v1/life-stage/goals/${GOAL_ID}`)
        .set(AUTH)
        .send({ status: 'archived' });

      expect(res.status).toBe(500);
    });
  });

  // --- POST /trajectory/score ---

  describe('POST /api/v1/life-stage/trajectory/score', () => {
    it('scores actions against the trajectory on the happy path', async () => {
      mockScoreTrajectory.mockResolvedValue({
        ok: true,
        scored_actions: [{ action: 'a1', coherence: 0.9 }],
        overall_coherence: 0.9,
        conflicts_detected: 0,
        multi_goal_opportunities: 1,
      });

      const res = await request(app)
        .post('/api/v1/life-stage/trajectory/score')
        .set(AUTH)
        .send({ actions: [{ action: 'a1' }], session_id: 'sess-1' });

      expect(res.status).toBe(200);
      expect(res.body.scored_actions).toHaveLength(1);
      expect(mockScoreTrajectory).toHaveBeenCalledWith(
        { actions: [{ action: 'a1' }], session_id: 'sess-1', include_trade_offs: true },
        TOKEN,
      );
    });

    it('returns 400 when actions is missing', async () => {
      const res = await request(app)
        .post('/api/v1/life-stage/trajectory/score')
        .set(AUTH)
        .send({ session_id: 'sess-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_REQUEST');
      expect(mockScoreTrajectory).not.toHaveBeenCalled();
    });

    it('returns 400 when actions is an empty array', async () => {
      const res = await request(app)
        .post('/api/v1/life-stage/trajectory/score')
        .set(AUTH)
        .send({ actions: [] });

      expect(res.status).toBe(400);
    });

    it('returns 500 on a scoring failure', async () => {
      mockScoreTrajectory.mockResolvedValue({ ok: false, error: 'SCORE_FAILED' });

      const res = await request(app)
        .post('/api/v1/life-stage/trajectory/score')
        .set(AUTH)
        .send({ actions: [{ action: 'a1' }] });

      expect(res.status).toBe(500);
    });
  });

  // --- GET /rules ---

  describe('GET /api/v1/life-stage/rules', () => {
    it('returns active rules ordered by domain/weight', async () => {
      const rules = [{ rule_key: 'r1', domain: 'health', weight: 10, active: true }];
      mockRulesChain.__result = { data: rules, error: null };

      const res = await request(app).get('/api/v1/life-stage/rules').set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.rules).toEqual(rules);
      expect(res.body.count).toBe(1);
      expect(mockCreateUserSupabaseClient).toHaveBeenCalledWith(TOKEN);
      expect(mockRulesChain.eq).toHaveBeenCalledWith('active', true);
    });

    it('returns 500 on a query error', async () => {
      mockRulesChain.__result = { data: null, error: { message: 'rules query failed' } };

      const res = await request(app).get('/api/v1/life-stage/rules').set(AUTH);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('rules query failed');
    });

    it('returns 500 when the Supabase client cannot be constructed', async () => {
      mockCreateUserSupabaseClient.mockReturnValueOnce(null as any);

      const res = await request(app).get('/api/v1/life-stage/rules').set(AUTH);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('SERVICE_UNAVAILABLE');
    });
  });
});
