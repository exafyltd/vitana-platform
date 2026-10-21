/**
 * VTID-01144: Route tests for D50 Positive Trajectory Reinforcement
 *
 * Covers all 9 endpoints:
 *   GET  /              - root info (no auth)
 *   GET  /metadata      - trajectory metadata (no auth)
 *   GET  /momentum      - momentum state (auth required)
 *   GET  /eligibility   - eligibility check (auth required)
 *   POST /generate      - generate reinforcement (auth required)
 *   POST /:id/deliver   - mark delivered (auth required)
 *   POST /:id/dismiss   - dismiss (auth required)
 *   GET  /history       - reinforcement history (auth required)
 *   GET  /orb-context   - ORB context (auth required)
 *
 * Strategy: mock engine + supabase-user at module boundary; drive via supertest.
 */

import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Environment must be set BEFORE any imports that read process.env at load time
// ---------------------------------------------------------------------------
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

// ---------------------------------------------------------------------------
// Mock: OASIS event service (engine calls this internally)
// ---------------------------------------------------------------------------
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

// ---------------------------------------------------------------------------
// Mock: supabase-user (imported by the route file)
// ---------------------------------------------------------------------------
jest.mock('../../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn().mockReturnValue({ rpc: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Mock: D50 engine — all exported functions + constants
// ---------------------------------------------------------------------------
const mockGetMomentumState = jest.fn();
const mockCheckEligibility = jest.fn();
const mockGenerateReinforcement = jest.fn();
const mockMarkDelivered = jest.fn();
const mockDismissReinforcement = jest.fn();
const mockGetReinforcementHistory = jest.fn();
const mockGetReinforcementContextForOrb = jest.fn();

const MOCK_VTID = 'VTID-01144';

const MOCK_REINFORCEMENT_THRESHOLDS = {
  MIN_SUSTAINED_DAYS: 7,
  MIN_CONFIDENCE: 80,
  MIN_DAYS_BETWEEN_REINFORCEMENTS: 21,
  MAX_DAILY_REINFORCEMENTS: 3,
  LOOKBACK_DAYS: 30,
  MIN_TREND_MAGNITUDE: 20,
  MIN_DATA_POINTS_FOR_TRAJECTORY: 5,
};

const MOCK_TRAJECTORY_TYPE_METADATA = {
  health: { label: 'Health Improvement', description: 'Physical wellbeing trends', message_templates: { what_is_working: [], why_it_matters: [] } },
  routine: { label: 'Routine Stability', description: 'Consistent patterns', message_templates: { what_is_working: [], why_it_matters: [] } },
  social: { label: 'Social Engagement', description: 'Connection patterns', message_templates: { what_is_working: [], why_it_matters: [] } },
  emotional: { label: 'Emotional Balance', description: 'Emotional regulation', message_templates: { what_is_working: [], why_it_matters: [] } },
  learning: { label: 'Skill Progress', description: 'Growth areas', message_templates: { what_is_working: [], why_it_matters: [] } },
  consistency: { label: 'Consistency', description: 'Sustained behaviors', message_templates: { what_is_working: [], why_it_matters: [] } },
};

const MOCK_FRAMING_RULES = {
  MAX_OBSERVATION_WORDS: 30,
  MAX_EXPLANATION_WORDS: 25,
  MAX_FOCUS_WORDS: 15,
  TONE: 'warm',
  FOCUS: 'continuation',
  PROHIBITED_PHRASES: [],
};

jest.mock('../../src/services/d50-positive-trajectory-reinforcement-engine', () => ({
  getMomentumState: (...args: unknown[]) => mockGetMomentumState(...args),
  checkEligibility: (...args: unknown[]) => mockCheckEligibility(...args),
  generateReinforcement: (...args: unknown[]) => mockGenerateReinforcement(...args),
  markDelivered: (...args: unknown[]) => mockMarkDelivered(...args),
  dismissReinforcement: (...args: unknown[]) => mockDismissReinforcement(...args),
  getReinforcementHistory: (...args: unknown[]) => mockGetReinforcementHistory(...args),
  getReinforcementContextForOrb: (...args: unknown[]) => mockGetReinforcementContextForOrb(...args),
  VTID: MOCK_VTID,
  REINFORCEMENT_THRESHOLDS: MOCK_REINFORCEMENT_THRESHOLDS,
  TRAJECTORY_TYPE_METADATA: MOCK_TRAJECTORY_TYPE_METADATA,
  FRAMING_RULES: MOCK_FRAMING_RULES,
}));

// ---------------------------------------------------------------------------
// Also mock D43 (engine imports it at module load time)
// ---------------------------------------------------------------------------
jest.mock('../../src/services/d43-longitudinal-adaptation-engine', () => ({
  getTrends: jest.fn().mockResolvedValue({ ok: true, signals: null }),
  detectDrift: jest.fn().mockResolvedValue({ ok: true }),
  DRIFT_THRESHOLDS: {},
}));

// Import AFTER mocks are registered
import reinforcementRouter from '../../src/routes/positive-trajectory-reinforcement';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const AUTH_HEADER = 'Bearer test-token-abc123';

const MOCK_MOMENTUM_STATE = {
  overall_momentum: 'building' as const,
  trajectory_summaries: [],
  recent_reinforcements: [],
  next_opportunity: null,
};

const MOCK_ELIGIBILITY_RESULT = {
  ok: true,
  eligible_trajectories: [
    {
      eligible: true,
      trajectory_type: 'health' as const,
      confidence: 85,
      days_sustained: 14,
      last_reinforcement_date: null,
      days_since_last_reinforcement: null,
      rejection_reason: null,
      evidence_summary: 'increasing trend in health over 14 days',
    },
  ],
  any_eligible: true,
  next_possible_reinforcement: null,
};

const MOCK_REINFORCEMENT = {
  reinforcement_id: VALID_UUID,
  trajectory_type: 'health' as const,
  confidence: 85,
  what_is_working: 'Your health patterns have been improving consistently.',
  why_it_matters: 'Sustained health improvement builds long-term resilience.',
  suggested_focus: null,
  dismissible: true,
};

const MOCK_HISTORY = {
  ok: true,
  reinforcements: [MOCK_REINFORCEMENT],
  count: 1,
};

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------

let app: express.Application;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/v1/reinforcement', reinforcementRouter);
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: not dev mode
  delete process.env.ENVIRONMENT;
});

afterEach(() => {
  delete process.env.ENVIRONMENT;
});

// ===========================================================================
// GET /
// ===========================================================================

describe('GET /api/v1/reinforcement/', () => {
  it('returns 200 with service info and endpoints array (no auth required)', async () => {
    const res = await request(app).get('/api/v1/reinforcement/');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vtid).toBe(MOCK_VTID);
    expect(Array.isArray(res.body.endpoints)).toBe(true);
    expect(res.body.endpoints.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// GET /metadata
// ===========================================================================

describe('GET /api/v1/reinforcement/metadata', () => {
  it('returns 200 with trajectory types, thresholds, and framing rules (no auth required)', async () => {
    const res = await request(app).get('/api/v1/reinforcement/metadata');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.trajectory_types).toBeDefined();
    expect(res.body.thresholds).toBeDefined();
    expect(res.body.framing_rules).toBeDefined();
    expect(res.body.framing_rules).toHaveProperty('max_observation_words');
    expect(res.body.framing_rules).toHaveProperty('max_explanation_words');
    expect(res.body.framing_rules).toHaveProperty('tone');
    expect(res.body.vtid).toBe(MOCK_VTID);
  });
});

// ===========================================================================
// GET /momentum
// ===========================================================================

describe('GET /api/v1/reinforcement/momentum', () => {
  it('returns 401 when no token is provided (non-dev)', async () => {
    const res = await request(app).get('/api/v1/reinforcement/momentum');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(mockGetMomentumState).not.toHaveBeenCalled();
  });

  it('returns 400 when engine returns error', async () => {
    mockGetMomentumState.mockResolvedValueOnce({ ok: false, error: 'SERVICE_UNAVAILABLE' });
    const res = await request(app)
      .get('/api/v1/reinforcement/momentum')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns 200 with overall_momentum on success', async () => {
    mockGetMomentumState.mockResolvedValueOnce({ ok: true, state: MOCK_MOMENTUM_STATE, computed_at: new Date().toISOString() });
    const res = await request(app)
      .get('/api/v1/reinforcement/momentum')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state.overall_momentum).toBe('building');
  });

  it('passes include_eligible and include_recent query params to engine', async () => {
    mockGetMomentumState.mockResolvedValueOnce({ ok: true, state: MOCK_MOMENTUM_STATE, computed_at: new Date().toISOString() });
    await request(app)
      .get('/api/v1/reinforcement/momentum?include_eligible=false&include_recent=false')
      .set('Authorization', AUTH_HEADER);
    expect(mockGetMomentumState).toHaveBeenCalledWith(
      expect.objectContaining({ include_eligible: false, include_recent: false }),
      'test-token-abc123'
    );
  });
});

// ===========================================================================
// GET /eligibility
// ===========================================================================

describe('GET /api/v1/reinforcement/eligibility', () => {
  it('returns 401 when no token is provided (non-dev)', async () => {
    const res = await request(app).get('/api/v1/reinforcement/eligibility');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 when trajectory_types contains invalid value', async () => {
    // The Zod schema validates trajectory types; invalid values cause parseResult.success = false
    const res = await request(app)
      .get('/api/v1/reinforcement/eligibility?trajectory_types=not_a_real_type')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(mockCheckEligibility).not.toHaveBeenCalled();
  });

  it('returns 400 when engine returns error', async () => {
    mockCheckEligibility.mockResolvedValueOnce({ ok: false, eligible_trajectories: [], any_eligible: false, next_possible_reinforcement: null, error: 'DB_ERROR' });
    const res = await request(app)
      .get('/api/v1/reinforcement/eligibility')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('DB_ERROR');
  });

  it('returns 200 with eligible_trajectories on success', async () => {
    mockCheckEligibility.mockResolvedValueOnce(MOCK_ELIGIBILITY_RESULT);
    const res = await request(app)
      .get('/api/v1/reinforcement/eligibility')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.eligible_trajectories)).toBe(true);
  });

  it('passes valid trajectory_types to engine', async () => {
    mockCheckEligibility.mockResolvedValueOnce(MOCK_ELIGIBILITY_RESULT);
    await request(app)
      .get('/api/v1/reinforcement/eligibility?trajectory_types=health,routine')
      .set('Authorization', AUTH_HEADER);
    expect(mockCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ trajectory_types: ['health', 'routine'] }),
      'test-token-abc123'
    );
  });
});

// ===========================================================================
// POST /generate
// ===========================================================================

describe('POST /api/v1/reinforcement/generate', () => {
  it('returns 401 when no token is provided (non-dev)', async () => {
    const res = await request(app).post('/api/v1/reinforcement/generate').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 when body fails Zod validation (invalid trajectory_type)', async () => {
    const res = await request(app)
      .post('/api/v1/reinforcement/generate')
      .set('Authorization', AUTH_HEADER)
      .send({ trajectory_type: 'invalid_type_xyz' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(mockGenerateReinforcement).not.toHaveBeenCalled();
  });

  it('returns 201 with reinforcement on success', async () => {
    mockGenerateReinforcement.mockResolvedValueOnce({
      ok: true,
      reinforcement: MOCK_REINFORCEMENT,
      reinforcement_id: VALID_UUID,
      delivered: false,
    });
    const res = await request(app)
      .post('/api/v1/reinforcement/generate')
      .set('Authorization', AUTH_HEADER)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.reinforcement.trajectory_type).toBe('health');
  });

  it('returns 400 when engine returns error', async () => {
    mockGenerateReinforcement.mockResolvedValueOnce({ ok: false, delivered: false, error: 'No eligible trajectories' });
    const res = await request(app)
      .post('/api/v1/reinforcement/generate')
      .set('Authorization', AUTH_HEADER)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeDefined();
  });
});

// ===========================================================================
// POST /:id/deliver
// ===========================================================================

describe('POST /api/v1/reinforcement/:id/deliver', () => {
  it('returns 401 when no token is provided (non-dev)', async () => {
    const res = await request(app).post(`/api/v1/reinforcement/${VALID_UUID}/deliver`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 when id is not a valid UUID', async () => {
    const res = await request(app)
      .post('/api/v1/reinforcement/not-a-uuid/deliver')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(mockMarkDelivered).not.toHaveBeenCalled();
  });

  it('returns 200 with delivered_at on success', async () => {
    mockMarkDelivered.mockResolvedValueOnce({ ok: true });
    const res = await request(app)
      .post(`/api/v1/reinforcement/${VALID_UUID}/deliver`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reinforcement_id).toBe(VALID_UUID);
    expect(res.body.delivered_at).toBeDefined();
  });

  it('returns 400 when engine returns error', async () => {
    mockMarkDelivered.mockResolvedValueOnce({ ok: false, error: 'NOT_FOUND' });
    const res = await request(app)
      .post(`/api/v1/reinforcement/${VALID_UUID}/deliver`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

// ===========================================================================
// POST /:id/dismiss
// ===========================================================================

describe('POST /api/v1/reinforcement/:id/dismiss', () => {
  it('returns 401 when no token is provided (non-dev)', async () => {
    const res = await request(app).post(`/api/v1/reinforcement/${VALID_UUID}/dismiss`).send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 when id is not a valid UUID', async () => {
    const res = await request(app)
      .post('/api/v1/reinforcement/bad-id/dismiss')
      .set('Authorization', AUTH_HEADER)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(mockDismissReinforcement).not.toHaveBeenCalled();
  });

  it('returns 400 when reason is invalid', async () => {
    const res = await request(app)
      .post(`/api/v1/reinforcement/${VALID_UUID}/dismiss`)
      .set('Authorization', AUTH_HEADER)
      .send({ reason: 'totally_invalid_reason_xyz' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 200 on successful dismiss', async () => {
    mockDismissReinforcement.mockResolvedValueOnce({
      ok: true,
      reinforcement_id: VALID_UUID,
      dismissed_at: new Date().toISOString(),
    });
    const res = await request(app)
      .post(`/api/v1/reinforcement/${VALID_UUID}/dismiss`)
      .set('Authorization', AUTH_HEADER)
      .send({ reason: 'not_relevant' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reinforcement_id).toBe(VALID_UUID);
  });

  it('returns 400 when engine returns error', async () => {
    mockDismissReinforcement.mockResolvedValueOnce({ ok: false, error: 'ALREADY_DISMISSED' });
    const res = await request(app)
      .post(`/api/v1/reinforcement/${VALID_UUID}/dismiss`)
      .set('Authorization', AUTH_HEADER)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

// ===========================================================================
// GET /history
// ===========================================================================

describe('GET /api/v1/reinforcement/history', () => {
  it('returns 401 when no token is provided (non-dev)', async () => {
    const res = await request(app).get('/api/v1/reinforcement/history');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 when limit is not a number', async () => {
    // GetReinforcementHistoryRequestSchema validates limit as z.number()
    const res = await request(app)
      .get('/api/v1/reinforcement/history?limit=not_a_number')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 200 with reinforcements array on success', async () => {
    mockGetReinforcementHistory.mockResolvedValueOnce(MOCK_HISTORY);
    const res = await request(app)
      .get('/api/v1/reinforcement/history')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.reinforcements)).toBe(true);
    expect(res.body.count).toBe(1);
  });

  it('returns 400 when engine returns error', async () => {
    mockGetReinforcementHistory.mockResolvedValueOnce({ ok: false, error: 'QUERY_FAILED' });
    const res = await request(app)
      .get('/api/v1/reinforcement/history')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

// ===========================================================================
// GET /orb-context
// ===========================================================================

describe('GET /api/v1/reinforcement/orb-context', () => {
  it('returns 401 when no token is provided (non-dev)', async () => {
    const res = await request(app).get('/api/v1/reinforcement/orb-context');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 200 with context: null when engine returns null', async () => {
    mockGetReinforcementContextForOrb.mockResolvedValueOnce(null);
    const res = await request(app)
      .get('/api/v1/reinforcement/orb-context')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.context).toBeNull();
    expect(res.body.has_positive_trajectories).toBe(false);
  });

  it('returns 200 with context and has_positive_trajectories when engine returns value', async () => {
    mockGetReinforcementContextForOrb.mockResolvedValueOnce({
      context: 'User shows building positive momentum across multiple areas.',
      hasPositiveTrajectories: true,
    });
    const res = await request(app)
      .get('/api/v1/reinforcement/orb-context')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.context).toBe('User shows building positive momentum across multiple areas.');
    expect(res.body.has_positive_trajectories).toBe(true);
  });
});

// ===========================================================================
// Dev sandbox bypass
// ===========================================================================

describe('dev sandbox bypass (process.env.ENVIRONMENT = "dev")', () => {
  beforeEach(() => {
    process.env.ENVIRONMENT = 'dev';
  });

  afterEach(() => {
    delete process.env.ENVIRONMENT;
  });

  it('GET /momentum — accepts request without Authorization header', async () => {
    mockGetMomentumState.mockResolvedValueOnce({ ok: true, state: MOCK_MOMENTUM_STATE, computed_at: new Date().toISOString() });
    const res = await request(app).get('/api/v1/reinforcement/momentum');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /eligibility — accepts request without Authorization header', async () => {
    mockCheckEligibility.mockResolvedValueOnce(MOCK_ELIGIBILITY_RESULT);
    const res = await request(app).get('/api/v1/reinforcement/eligibility');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /generate — accepts request without Authorization header', async () => {
    mockGenerateReinforcement.mockResolvedValueOnce({
      ok: true,
      reinforcement: MOCK_REINFORCEMENT,
      reinforcement_id: VALID_UUID,
      delivered: false,
    });
    const res = await request(app).post('/api/v1/reinforcement/generate').send({});
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it('POST /:id/deliver — accepts request without Authorization header', async () => {
    mockMarkDelivered.mockResolvedValueOnce({ ok: true });
    const res = await request(app).post(`/api/v1/reinforcement/${VALID_UUID}/deliver`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /:id/dismiss — accepts request without Authorization header', async () => {
    mockDismissReinforcement.mockResolvedValueOnce({
      ok: true,
      reinforcement_id: VALID_UUID,
      dismissed_at: new Date().toISOString(),
    });
    const res = await request(app).post(`/api/v1/reinforcement/${VALID_UUID}/dismiss`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /history — accepts request without Authorization header', async () => {
    mockGetReinforcementHistory.mockResolvedValueOnce(MOCK_HISTORY);
    const res = await request(app).get('/api/v1/reinforcement/history');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /orb-context — accepts request without Authorization header', async () => {
    mockGetReinforcementContextForOrb.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/v1/reinforcement/orb-context');
    expect(res.status).toBe(200);
    expect(res.body.context).toBeNull();
  });
});