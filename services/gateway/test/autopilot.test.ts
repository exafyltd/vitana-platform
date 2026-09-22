/**
 * Autopilot routes — baseline integration coverage (VTID-04298)
 *
 * services/gateway/src/routes/autopilot.ts is the core autopilot pipeline
 * router (planner handoff, execution pipeline, controller, event loop). It is
 * mounted at /api/v1/autopilot and — since the post-audit hardening pass — every
 * route except the health endpoints is gated by the GATEWAY_SERVICE_TOKEN
 * bearer (see requireServiceToken in that file).
 *
 * This suite pins the smallest, highest-value contract so a regression in
 * authentication, response shape or the auto-approve governance gates fails CI
 * immediately:
 *
 *   1. Health endpoints — no auth required.
 *      GET /api/v1/autopilot/health          → 200 { ok, service: 'autopilot-api' }
 *      GET /api/v1/autopilot/pipeline/health → 200 { ok: true, ... }
 *   2. Auth gating — missing/invalid bearer → 401.
 *   3. List endpoint — GET /tasks/pending-plan → { ok: true, data: Task[] }.
 *   4. Auto-approve / execution-armed gating — the VTID-01170 deprecation
 *      guard (400 DEPRECATED) and the VTID-01187 EXECUTION_DISARMED gate (403).
 *
 * The router is a thin HTTP layer over its service modules, so every service
 * import is mocked at the module boundary: these tests exercise only the
 * route's own logic, never a live database, GitHub or LLM call.
 */

import supertestBase from 'supertest';
import express from 'express';

// Known service token for the auth-gating tests. requireServiceToken reads
// process.env.GATEWAY_SERVICE_TOKEN at request time.
process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';

// No live database: this router never touches supabase-js directly, but its
// service modules would. Returning null is the "supabase not configured" path.
jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => null),
}));

jest.mock('../src/services/system-controls-service', () => ({
  isAutopilotExecutionArmed: jest.fn(),
}));

jest.mock('../src/services/operator-service', () => ({
  getPendingPlanTasks: jest.fn(),
  submitPlan: jest.fn(),
  emitValidationResult: jest.fn(),
  getAutopilotTaskStatus: jest.fn(),
}));

jest.mock('../src/services/worker-core-service', () => ({
  startWork: jest.fn(),
  completeWork: jest.fn(),
  getWorkerState: jest.fn(),
}));

jest.mock('../src/services/validator-core-service', () => ({
  runValidation: jest.fn(),
  getValidatorState: jest.fn(),
}));

jest.mock('../src/services/autopilot-controller', () => ({
  startAutopilotRun: jest.fn(),
  getAutopilotRun: jest.fn(),
  getActiveRuns: jest.fn(),
  getSpecSnapshot: jest.fn(),
  verifySpecIntegrity: jest.fn(),
  getAutopilotStatus: jest.fn(),
}));

jest.mock('../src/services/autopilot-verification', () => ({
  runVerification: jest.fn(),
}));

jest.mock('../src/services/autopilot-validator', () => ({
  validateForMerge: jest.fn(),
  getValidationResult: jest.fn(),
}));

jest.mock('../src/services/autopilot-event-loop', () => ({
  startEventLoop: jest.fn(),
  stopEventLoop: jest.fn(),
  getEventLoopStatus: jest.fn(),
  getEventLoopHistory: jest.fn(),
  resetEventLoopCursor: jest.fn(),
}));

import { isAutopilotExecutionArmed } from '../src/services/system-controls-service';
import { getPendingPlanTasks, submitPlan } from '../src/services/operator-service';
import { getAutopilotStatus } from '../src/services/autopilot-controller';
import { getEventLoopStatus } from '../src/services/autopilot-event-loop';

import router from '../src/routes/autopilot';

const SERVICE_TOKEN = 'test-service-token';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/autopilot', router);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ ok: false, error: err.message });
  });
  return app;
}

const app = buildApp();

/** Authenticated request helper — every gated call site goes through this. */
function request(client: any = app) {
  const agent = supertestBase(client);
  return {
    get: (path: string) => agent.get(path).set('Authorization', `Bearer ${SERVICE_TOKEN}`),
    post: (path: string) => agent.post(path).set('Authorization', `Bearer ${SERVICE_TOKEN}`),
  };
}

function jsonRes(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Defaults: execution armed so the governance gate doesn't block unrelated
  // assertions, loop disarmed by config (the deliberate idle state), and an
  // empty Supabase response for the raw-fetch /pipeline/health queries.
  (isAutopilotExecutionArmed as jest.Mock).mockResolvedValue(true);
  (getAutopilotStatus as jest.Mock).mockReturnValue({ status: 'idle', active_runs: 0 });
  (getEventLoopStatus as jest.Mock).mockResolvedValue({
    ok: true,
    is_running: false,
    execution_armed: false,
    config: { enabled: false },
    stats: {},
  });
  (getPendingPlanTasks as jest.Mock).mockResolvedValue([]);
  const fetchMock = global.fetch as unknown as jest.Mock;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonRes(200, []));
  process.env.GATEWAY_SERVICE_TOKEN = SERVICE_TOKEN;
});

// =============================================================================
// 1. Health endpoints — explicitly exempt from requireServiceToken
// =============================================================================

describe('GET /health', () => {
  it('is reachable without an Authorization header and identifies the service', async () => {
    (getEventLoopStatus as jest.Mock).mockResolvedValue({ ok: true, is_running: true, config: {} });

    const res = await supertestBase(app).get('/api/v1/autopilot/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('autopilot-api');
    expect(res.body.status).toBe('healthy');
  });
});

describe('GET /pipeline/health', () => {
  it('is reachable without an Authorization header and reports ok with the pipeline summary', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/pipeline/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tasks).toEqual({
      scheduled: 0,
      in_progress: 0,
      completed: 0,
      rejected: 0,
      blocked: 0,
    });
    expect(res.body.stuck_count).toBe(0);
  });
});

// =============================================================================
// 2. Auth gating — GATEWAY_SERVICE_TOKEN bearer required on non-health routes
// =============================================================================

describe('requireServiceToken auth gating', () => {
  it('401s with "missing bearer token" when no Authorization header is sent', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/tasks/pending-plan');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'missing bearer token' });
    expect(getPendingPlanTasks).not.toHaveBeenCalled();
  });

  it('401s with "invalid service token" when the bearer token does not match', async () => {
    const res = await supertestBase(app)
      .get('/api/v1/autopilot/tasks/pending-plan')
      .set('Authorization', 'Bearer not-the-service-token');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'invalid service token' });
    expect(getPendingPlanTasks).not.toHaveBeenCalled();
  });

  it('401s when the token is correct but the scheme is not "bearer"', async () => {
    const res = await supertestBase(app)
      .get('/api/v1/autopilot/tasks/pending-plan')
      .set('Authorization', `Token ${SERVICE_TOKEN}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing bearer token');
  });
});

// =============================================================================
// 3. List pending-plan tasks (VTID-0532 planner handoff, read-only)
// =============================================================================

describe('GET /tasks/pending-plan', () => {
  it('returns 200 with { ok: true, data: Task[] } for a valid service token', async () => {
    const tasks = [
      { vtid: 'VTID-00001', status: 'scheduled', title: 'Add integration coverage' },
      { vtid: 'VTID-00002', status: 'pending', title: 'Wire the event loop' },
    ];
    (getPendingPlanTasks as jest.Mock).mockResolvedValue(tasks);

    const res = await request().get('/api/v1/autopilot/tasks/pending-plan');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual(tasks);
    // Response shape contract: every task carries at least vtid + status.
    for (const task of res.body.data) {
      expect(typeof task.vtid).toBe('string');
      expect(typeof task.status).toBe('string');
    }
  });

  it('returns an empty data array when nothing is pending planning', async () => {
    (getPendingPlanTasks as jest.Mock).mockResolvedValue([]);

    const res = await request().get('/api/v1/autopilot/tasks/pending-plan');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [] });
  });

  it('returns 500 with the failure envelope when the operator service throws', async () => {
    (getPendingPlanTasks as jest.Mock).mockRejectedValue(new Error('boom'));

    const res = await request().get('/api/v1/autopilot/tasks/pending-plan');

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Failed to fetch pending plan tasks');
  });
});

// =============================================================================
// 4. Auto-approve / execution-armed gating — POST /tasks/:vtid/plan
//    VTID-01170 deprecation guard, then VTID-01187 EXECUTION_DISARMED gate.
// =============================================================================

describe('POST /tasks/:vtid/plan governance gates', () => {
  const planPath = '/api/v1/autopilot/tasks/VTID-00001/plan';
  const validPlan = {
    plan: {
      summary: 'Do the thing',
      steps: [
        { id: 'step-1', title: 'Step 1', description: 'desc', owner: 'WORKER', estimated_effort: 'S', dependencies: [] },
      ],
    },
    metadata: { plannerModel: 'gemini-pro', plannerRole: 'PLANNER', source: 'autopilot' },
  };

  it('400s with code VTID-01170-DEPRECATED without the X-BYPASS-ORCHESTRATOR header', async () => {
    const res = await request().post(planPath).send(validPlan);

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('VTID-01170-DEPRECATED');
    expect(res.body.canonical_path).toBe('POST /api/v1/worker/orchestrator/route');
    // The deprecation guard runs before the governance gate.
    expect(isAutopilotExecutionArmed).not.toHaveBeenCalled();
    expect(submitPlan).not.toHaveBeenCalled();
  });

  it('403s with error_code EXECUTION_DISARMED when bypassed but execution is disarmed', async () => {
    (isAutopilotExecutionArmed as jest.Mock).mockResolvedValue(false);

    const res = await request()
      .post(planPath)
      .set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS')
      .send(validPlan);

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error_code).toBe('EXECUTION_DISARMED');
    expect(res.body.vtid).toBe('VTID-01187');
    expect(submitPlan).not.toHaveBeenCalled();
  });

  it('proceeds to submit the plan when bypassed and armed', async () => {
    (submitPlan as jest.Mock).mockResolvedValue({
      ok: true,
      vtid: 'VTID-00001',
      status: 'planned',
      planSteps: 1,
    });

    const res = await request()
      .post(planPath)
      .set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS')
      .send(validPlan);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, vtid: 'VTID-00001', status: 'planned', planSteps: 1 });
    expect(submitPlan).toHaveBeenCalledWith(
      'VTID-00001',
      validPlan.plan,
      expect.objectContaining({ plannerModel: 'gemini-pro', plannerRole: 'PLANNER' }),
    );
  });

  it('checks the governance gate before validating the request body', async () => {
    (isAutopilotExecutionArmed as jest.Mock).mockResolvedValue(false);

    const res = await request()
      .post(planPath)
      .set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('EXECUTION_DISARMED');
  });

  it('400s on an invalid plan body when bypassed and armed', async () => {
    const res = await request()
      .post(planPath)
      .set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS')
      .send({ metadata: validPlan.metadata });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(submitPlan).not.toHaveBeenCalled();
  });

  it('401s on the plan endpoint without a service token, before any gate logic', async () => {
    const res = await supertestBase(app)
      .post(planPath)
      .set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS')
      .send(validPlan);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing bearer token');
    expect(isAutopilotExecutionArmed).not.toHaveBeenCalled();
    expect(submitPlan).not.toHaveBeenCalled();
  });
});
