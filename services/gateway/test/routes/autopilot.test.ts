import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks — autopilot.ts is a thin HTTP layer over a large set of service
// modules (planner handoff, worker-core, validator-core, autopilot
// controller, verification, event loop). None of these routes use the
// supabase-js client directly except /pipeline/health and /pipeline/summary,
// which do raw fetch() calls against SUPABASE_URL — those are covered with a
// mocked global.fetch. Everything else is mocked at the service-module
// boundary so these tests exercise only the route's own logic: request
// validation, status-code mapping, and — most importantly — the
// EXECUTION_DISARMED governance gate (VTID-01187).
// ---------------------------------------------------------------------------

jest.mock('../../src/services/system-controls-service', () => ({
  isAutopilotExecutionArmed: jest.fn(),
}));

jest.mock('../../src/services/operator-service', () => ({
  getPendingPlanTasks: jest.fn(),
  submitPlan: jest.fn(),
  emitValidationResult: jest.fn(),
  getAutopilotTaskStatus: jest.fn(),
}));

jest.mock('../../src/services/worker-core-service', () => ({
  startWork: jest.fn(),
  completeWork: jest.fn(),
  getWorkerState: jest.fn(),
}));

jest.mock('../../src/services/validator-core-service', () => ({
  runValidation: jest.fn(),
  getValidatorState: jest.fn(),
}));

jest.mock('../../src/services/autopilot-controller', () => ({
  startAutopilotRun: jest.fn(),
  getAutopilotRun: jest.fn(),
  getActiveRuns: jest.fn(),
  getSpecSnapshot: jest.fn(),
  verifySpecIntegrity: jest.fn(),
  getAutopilotStatus: jest.fn(),
}));

jest.mock('../../src/services/autopilot-verification', () => ({
  runVerification: jest.fn(),
}));

jest.mock('../../src/services/autopilot-validator', () => ({
  validateForMerge: jest.fn(),
  getValidationResult: jest.fn(),
}));

jest.mock('../../src/services/autopilot-event-loop', () => ({
  startEventLoop: jest.fn(),
  stopEventLoop: jest.fn(),
  getEventLoopStatus: jest.fn(),
  getEventLoopHistory: jest.fn(),
  resetEventLoopCursor: jest.fn(),
}));

import { isAutopilotExecutionArmed } from '../../src/services/system-controls-service';
import {
  getPendingPlanTasks,
  submitPlan,
  getAutopilotTaskStatus,
} from '../../src/services/operator-service';
import { startWork, completeWork, getWorkerState } from '../../src/services/worker-core-service';
import { runValidation, getValidatorState } from '../../src/services/validator-core-service';
import {
  startAutopilotRun,
  getAutopilotRun,
  getActiveRuns,
  getSpecSnapshot,
  verifySpecIntegrity,
  getAutopilotStatus,
} from '../../src/services/autopilot-controller';
import { runVerification } from '../../src/services/autopilot-verification';
import { validateForMerge, getValidationResult } from '../../src/services/autopilot-validator';
import {
  startEventLoop,
  stopEventLoop,
  getEventLoopStatus,
  getEventLoopHistory,
  resetEventLoopCursor,
} from '../../src/services/autopilot-event-loop';

import router from '../../src/routes/autopilot';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/autopilot', router);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ ok: false, error: err.message });
  });
  return app;
}
const app = buildApp();

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
  // Default: armed, so tests that don't care about the gate aren't blocked.
  (isAutopilotExecutionArmed as jest.Mock).mockResolvedValue(true);
  (getAutopilotStatus as jest.Mock).mockReturnValue({ status: 'idle' });
  (global.fetch as jest.Mock).mockReset();
  (global.fetch as jest.Mock).mockResolvedValue(jsonRes(200, []));
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
});

const validPlan = {
  plan: {
    summary: 'Do the thing',
    steps: [{ id: 'step-1', title: 'Step 1', description: 'desc', owner: 'WORKER', estimated_effort: 'S', dependencies: [] }],
  },
  metadata: { plannerModel: 'gemini-pro', plannerRole: 'PLANNER', source: 'autopilot' },
};

const validWorkStart = {
  step_id: 'step-1',
  step_index: 0,
  label: 'Do the thing',
  agent: 'Gemini-Worker',
  executor_type: 'llm',
};

// =============================================================================
// VTID-01170: Deprecation guard — fires before the EXECUTION_DISARMED check on
// /plan and /work/start, and unconditionally on /work/complete.
// =============================================================================

describe('VTID-01170 deprecation guard', () => {
  it('blocks POST /tasks/:vtid/plan with 400 DEPRECATED when the bypass header is absent', async () => {
    const res = await request(app).post('/api/v1/autopilot/tasks/VTID-01234/plan').send(validPlan);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VTID-01170-DEPRECATED');
    expect(res.body.canonical_path).toBe('POST /api/v1/worker/orchestrator/route');
    // The deprecation guard runs BEFORE the governance gate — a blocked
    // deprecated call must never reach (and therefore never depend on)
    // isAutopilotExecutionArmed().
    expect(isAutopilotExecutionArmed).not.toHaveBeenCalled();
    expect(submitPlan).not.toHaveBeenCalled();
  });

  it('blocks POST /tasks/:vtid/work/complete with 400 DEPRECATED regardless of bypass', async () => {
    // work/complete has NO governance gate of its own — the deprecation
    // guard is its only defense. Confirm it still blocks without the header.
    const res = await request(app)
      .post('/api/v1/autopilot/tasks/VTID-01234/work/complete')
      .send({ step_id: 's1', step_index: 0, status: 'completed' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VTID-01170-DEPRECATED');
    expect(completeWork).not.toHaveBeenCalled();
  });

  it('allows POST /tasks/:vtid/plan through when X-BYPASS-ORCHESTRATOR: EMERGENCY-BYPASS is set', async () => {
    (submitPlan as jest.Mock).mockResolvedValue({ ok: true, vtid: 'VTID-01234', status: 'planned', planSteps: 1 });
    const res = await request(app)
      .post('/api/v1/autopilot/tasks/VTID-01234/plan')
      .set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS')
      .send(validPlan);
    expect(res.status).toBe(200);
    expect(submitPlan).toHaveBeenCalled();
  });

  it('does NOT bypass on a near-miss header value', async () => {
    const res = await request(app)
      .post('/api/v1/autopilot/tasks/VTID-01234/plan')
      .set('X-BYPASS-ORCHESTRATOR', 'emergency-bypass') // wrong case
      .send(validPlan);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VTID-01170-DEPRECATED');
  });
});

// =============================================================================
// VTID-01187: EXECUTION_DISARMED governance gate — call site #1: POST /tasks/:vtid/plan
// =============================================================================

describe('EXECUTION_DISARMED gate — POST /tasks/:vtid/plan', () => {
  const send = () =>
    request(app)
      .post('/api/v1/autopilot/tasks/VTID-01234/plan')
      .set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS')
      .send(validPlan);

  it('BLOCKS plan submission with 403 + error_code EXECUTION_DISARMED when disarmed', async () => {
    (isAutopilotExecutionArmed as jest.Mock).mockResolvedValue(false);
    const res = await send();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      ok: false,
      error_code: 'EXECUTION_DISARMED',
      vtid: 'VTID-01187',
    });
    expect(submitPlan).not.toHaveBeenCalled();
  });

  it('PROCEEDS to submit the plan when armed', async () => {
    (isAutopilotExecutionArmed as jest.Mock).mockResolvedValue(true);
    (submitPlan as jest.Mock).mockResolvedValue({ ok: true, vtid: 'VTID-01234', status: 'planned', planSteps: 1 });
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, vtid: 'VTID-01234', status: 'planned', planSteps: 1 });
    expect(submitPlan).toHaveBeenCalledWith(
      'VTID-01234',
      validPlan.plan,
      expect.objectContaining({ plannerModel: 'gemini-pro', plannerRole: 'PLANNER' }),
    );
  });

  it('checks the governance gate before validating the request body (gate is checked first)', async () => {
    (isAutopilotExecutionArmed as jest.Mock).mockResolvedValue(false);
    const res = await request(app)
      .post('/api/v1/autopilot/tasks/VTID-01234/plan')
      .set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS')
      .send({}); // also invalid body — disarmed should win with 403, not 400
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('EXECUTION_DISARMED');
  });
});

// =============================================================================
// VTID-01187: EXECUTION_DISARMED governance gate — call site #2: POST /tasks/:vtid/work/start
// =============================================================================

describe('EXECUTION_DISARMED gate — POST /tasks/:vtid/work/start', () => {
  const send = () =>
    request(app)
      .post('/api/v1/autopilot/tasks/VTID-01234/work/start')
      .set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS')
      .send(validWorkStart);

  it('BLOCKS work start with 403 + error_code EXECUTION_DISARMED when disarmed', async () => {
    (isAutopilotExecutionArmed as jest.Mock).mockResolvedValue(false);
    const res = await send();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      ok: false,
      error_code: 'EXECUTION_DISARMED',
      vtid: 'VTID-01187',
    });
    expect(startWork).not.toHaveBeenCalled();
  });

  it('PROCEEDS to start work when armed', async () => {
    (isAutopilotExecutionArmed as jest.Mock).mockResolvedValue(true);
    (startWork as jest.Mock).mockResolvedValue({
      ok: true,
      eventId: 'evt-1',
      state: { overall_status: 'in_progress', steps: [] },
    });
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, eventId: 'evt-1' });
    expect(startWork).toHaveBeenCalledWith('VTID-01234', expect.objectContaining({ step_id: 'step-1' }));
  });
});

// =============================================================================
// Adversarial: work/complete has NO EXECUTION_DISARMED check in the current
// source — only the deprecation guard gates it. Document this explicitly:
// with the emergency-bypass header set, a disarmed system's in-flight step
// can still be marked complete. This is a real gap worth flagging (see report).
// =============================================================================

describe('POST /tasks/:vtid/work/complete — no governance gate present', () => {
  it('completes work even when isAutopilotExecutionArmed() would report disarmed', async () => {
    (isAutopilotExecutionArmed as jest.Mock).mockResolvedValue(false);
    (completeWork as jest.Mock).mockResolvedValue({
      ok: true,
      eventId: 'evt-2',
      state: { overall_status: 'completed', steps: [] },
    });
    const res = await request(app)
      .post('/api/v1/autopilot/tasks/VTID-01234/work/complete')
      .set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS')
      .send({ step_id: 'step-1', step_index: 0, status: 'completed', agent: 'Gemini-Worker' });
    expect(res.status).toBe(200);
    expect(completeWork).toHaveBeenCalled();
    // isAutopilotExecutionArmed was never even consulted for this route.
    expect(isAutopilotExecutionArmed).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Request-body validation — POST /tasks/:vtid/plan
// =============================================================================

describe('POST /tasks/:vtid/plan — request validation (armed)', () => {
  const withBypass = () =>
    request(app).post('/api/v1/autopilot/tasks/VTID-01234/plan').set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS');

  it('400s on a missing plan object', async () => {
    const res = await withBypass().send({ metadata: validPlan.metadata });
    expect(res.status).toBe(400);
  });

  it('400s on a missing plan.summary', async () => {
    const res = await withBypass().send({ plan: { steps: [] }, metadata: validPlan.metadata });
    expect(res.status).toBe(400);
  });

  it('400s when plan.steps is not an array', async () => {
    const res = await withBypass().send({ plan: { summary: 'x', steps: 'nope' }, metadata: validPlan.metadata });
    expect(res.status).toBe(400);
  });

  it('400s on a missing metadata object', async () => {
    const res = await withBypass().send({ plan: validPlan.plan });
    expect(res.status).toBe(400);
  });

  it('400s on a missing metadata.plannerModel', async () => {
    const res = await withBypass().send({ plan: validPlan.plan, metadata: { plannerRole: 'PLANNER' } });
    expect(res.status).toBe(400);
  });

  it('defaults plannerRole to PLANNER when omitted', async () => {
    (submitPlan as jest.Mock).mockResolvedValue({ ok: true, vtid: 'VTID-01234', status: 'planned', planSteps: 1 });
    await withBypass().send({ plan: validPlan.plan, metadata: { plannerModel: 'gemini-pro' } });
    expect(submitPlan).toHaveBeenCalledWith('VTID-01234', validPlan.plan, expect.objectContaining({ plannerRole: 'PLANNER' }));
  });

  it('surfaces a submitPlan ok:false result as 400', async () => {
    (submitPlan as jest.Mock).mockResolvedValue({ ok: false, error: 'already planned' });
    const res = await withBypass().send(validPlan);
    expect(res.status).toBe(400);
  });

  it('returns 500 when submitPlan throws', async () => {
    (submitPlan as jest.Mock).mockRejectedValue(new Error('db down'));
    const res = await withBypass().send(validPlan);
    expect(res.status).toBe(500);
  });
});

// =============================================================================
// Request-body validation — POST /tasks/:vtid/work/start
// =============================================================================

describe('POST /tasks/:vtid/work/start — request validation (armed)', () => {
  const withBypass = () =>
    request(app).post('/api/v1/autopilot/tasks/VTID-01234/work/start').set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS');

  it.each([
    ['step_id', { ...validWorkStart, step_id: undefined }],
    ['step_index', { ...validWorkStart, step_index: 'zero' }],
    ['label', { ...validWorkStart, label: undefined }],
    ['agent', { ...validWorkStart, agent: undefined }],
    ['executor_type', { ...validWorkStart, executor_type: undefined }],
  ])('400s when %s is missing/invalid', async (_field, body) => {
    const res = await withBypass().send(body);
    expect(res.status).toBe(400);
  });

  it('maps worker.invalid_transition errors to 409', async () => {
    (startWork as jest.Mock).mockResolvedValue({
      ok: false,
      error: { code: 'worker.invalid_transition', message: 'step not pending' },
    });
    const res = await withBypass().send(validWorkStart);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('worker.invalid_transition');
  });

  it('maps other worker errors (e.g. worker.step_not_found) to 400', async () => {
    (startWork as jest.Mock).mockResolvedValue({
      ok: false,
      error: { code: 'worker.step_not_found', message: 'unknown step' },
    });
    const res = await withBypass().send(validWorkStart);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('worker.step_not_found');
  });

  it('returns 500 when startWork throws', async () => {
    (startWork as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await withBypass().send(validWorkStart);
    expect(res.status).toBe(500);
  });
});

// =============================================================================
// POST /tasks/:vtid/work/complete — validation + status mapping
// =============================================================================

describe('POST /tasks/:vtid/work/complete — request validation', () => {
  const withBypass = () =>
    request(app).post('/api/v1/autopilot/tasks/VTID-01234/work/complete').set('X-BYPASS-ORCHESTRATOR', 'EMERGENCY-BYPASS');

  it('400s on an invalid status value', async () => {
    const res = await withBypass().send({ step_id: 's1', step_index: 0, status: 'done' });
    expect(res.status).toBe(400);
  });

  it('accepts status=failed', async () => {
    (completeWork as jest.Mock).mockResolvedValue({ ok: true, eventId: 'e1', state: {} });
    const res = await withBypass().send({ step_id: 's1', step_index: 0, status: 'failed', error: 'oops' });
    expect(res.status).toBe(200);
  });

  it('maps worker.invalid_transition to 409', async () => {
    (completeWork as jest.Mock).mockResolvedValue({
      ok: false,
      error: { code: 'worker.invalid_transition', message: 'not in progress' },
    });
    const res = await withBypass().send({ step_id: 's1', step_index: 0, status: 'completed' });
    expect(res.status).toBe(409);
  });
});

// =============================================================================
// POST /tasks/:vtid/validate, GET /tasks/:vtid/status — no deprecation guard,
// no EXECUTION_DISARMED gate (validation/status are read/governance-adjacent,
// not execution).
// =============================================================================

describe('POST /tasks/:vtid/validate', () => {
  it('defaults mode to auto and override to null', async () => {
    (runValidation as jest.Mock).mockResolvedValue({ ok: true, result: { final_status: 'success' } });
    const res = await request(app).post('/api/v1/autopilot/tasks/VTID-01234/validate').send({});
    expect(res.status).toBe(200);
    expect(runValidation).toHaveBeenCalledWith('VTID-01234', { mode: 'auto', override: null });
  });

  it('maps validator.internal_error to 500, other errors to 400', async () => {
    (runValidation as jest.Mock).mockResolvedValue({
      ok: false,
      error: { code: 'validator.plan_missing', message: 'no plan' },
    });
    const res1 = await request(app).post('/api/v1/autopilot/tasks/VTID-01234/validate').send({});
    expect(res1.status).toBe(400);

    (runValidation as jest.Mock).mockResolvedValue({
      ok: false,
      error: { code: 'validator.internal_error', message: 'crash' },
    });
    const res2 = await request(app).post('/api/v1/autopilot/tasks/VTID-01234/validate').send({});
    expect(res2.status).toBe(500);
  });

  it('is NOT blocked by the deprecation guard even without the bypass header', async () => {
    (runValidation as jest.Mock).mockResolvedValue({ ok: true, result: {} });
    const res = await request(app).post('/api/v1/autopilot/tasks/VTID-01234/validate').send({});
    expect(res.status).toBe(200);
  });
});

describe('GET /tasks/:vtid/status', () => {
  it('returns 404 when the task does not exist', async () => {
    (getAutopilotTaskStatus as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get('/api/v1/autopilot/tasks/VTID-01234/status');
    expect(res.status).toBe(404);
  });

  it('merges planner/worker/validator sections when found', async () => {
    (getAutopilotTaskStatus as jest.Mock).mockResolvedValue({
      vtid: 'VTID-01234',
      status: 'planned',
      planSteps: 2,
      title: 'Some task',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
    (getWorkerState as jest.Mock).mockResolvedValue({ ok: true, state: { overall_status: 'in_progress', steps: [] } });
    (getValidatorState as jest.Mock).mockResolvedValue({ final_status: 'pending', summary: '', rules_checked: [], violations: [] });

    const res = await request(app).get('/api/v1/autopilot/tasks/VTID-01234/status');
    expect(res.status).toBe(200);
    expect(res.body.status.planner.status).toBe('planned');
    expect(res.body.status.worker.overall_status).toBe('in_progress');
    expect(res.body.status.validator.final_status).toBe('pending');
    expect(res.body.validationStatus).toBe('pending');
  });

  it('falls back to a pending worker state when getWorkerState reports not-ok', async () => {
    (getAutopilotTaskStatus as jest.Mock).mockResolvedValue({ vtid: 'VTID-01234', status: 'scheduled' });
    (getWorkerState as jest.Mock).mockResolvedValue({ ok: false });
    (getValidatorState as jest.Mock).mockResolvedValue({ final_status: 'pending' });

    const res = await request(app).get('/api/v1/autopilot/tasks/VTID-01234/status');
    expect(res.status).toBe(200);
    expect(res.body.status.worker).toEqual({ overall_status: 'pending', steps: [] });
  });
});

// =============================================================================
// GET /tasks/pending-plan
// =============================================================================

describe('GET /tasks/pending-plan', () => {
  it('returns the pending plan tasks', async () => {
    (getPendingPlanTasks as jest.Mock).mockResolvedValue([{ vtid: 'VTID-1' }]);
    const res = await request(app).get('/api/v1/autopilot/tasks/pending-plan');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ vtid: 'VTID-1' }]);
  });

  it('returns 500 when the service throws', async () => {
    (getPendingPlanTasks as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/api/v1/autopilot/tasks/pending-plan');
    expect(res.status).toBe(500);
  });
});

// =============================================================================
// VTID-01178: Autopilot Controller endpoints — VTID format validation
// =============================================================================

describe('Controller endpoints — VTID format validation', () => {
  const badVtids = ['not-a-vtid', 'VTID-1', 'vtid-01234', ''];

  it.each(badVtids)('GET /controller/runs/:vtid 400s on "%s"', async (vtid) => {
    const res = await request(app).get(`/api/v1/autopilot/controller/runs/${encodeURIComponent(vtid || 'x')}`);
    // Empty-string vtid can't be routed distinctly, so only assert for
    // syntactically-present-but-invalid ids.
    if (vtid) expect(res.status).toBe(400);
  });

  it('GET /controller/runs/:vtid 404s when no run exists for a well-formed VTID', async () => {
    (getAutopilotRun as jest.Mock).mockReturnValue(null);
    const res = await request(app).get('/api/v1/autopilot/controller/runs/VTID-01234');
    expect(res.status).toBe(404);
  });

  it('GET /controller/runs/:vtid 200s with the run for a well-formed VTID', async () => {
    (getAutopilotRun as jest.Mock).mockReturnValue({ id: 'run-1', vtid: 'VTID-01234' });
    const res = await request(app).get('/api/v1/autopilot/controller/runs/VTID-01234');
    expect(res.status).toBe(200);
    expect(res.body.run).toEqual({ id: 'run-1', vtid: 'VTID-01234' });
  });

  it('POST /controller/runs/:vtid/start requires title and spec_content', async () => {
    const res = await request(app).post('/api/v1/autopilot/controller/runs/VTID-01234/start').send({ title: 'x' });
    expect(res.status).toBe(400);
  });

  it('POST /controller/runs/:vtid/start 201s on success', async () => {
    (startAutopilotRun as jest.Mock).mockResolvedValue({
      id: 'run-1',
      state: 'planning',
      started_at: '2026-01-01T00:00:00Z',
      spec_snapshot: { id: 'snap-1' },
    });
    const res = await request(app)
      .post('/api/v1/autopilot/controller/runs/VTID-01234/start')
      .send({ title: 'Task', spec_content: '# spec' });
    expect(res.status).toBe(201);
    expect(res.body.run_id).toBe('run-1');
  });

  it('POST /controller/runs/:vtid/verify requires service', async () => {
    const res = await request(app).post('/api/v1/autopilot/controller/runs/VTID-01234/verify').send({});
    expect(res.status).toBe(400);
  });

  it('POST /controller/runs/:vtid/verify returns 422 when verification fails', async () => {
    (runVerification as jest.Mock).mockResolvedValue({ ok: true, passed: false, result: { reason: 'health check failed' } });
    const res = await request(app)
      .post('/api/v1/autopilot/controller/runs/VTID-01234/verify')
      .send({ service: 'gateway' });
    expect(res.status).toBe(422);
  });

  it('POST /controller/runs/:vtid/verify returns 200 when verification passes', async () => {
    (runVerification as jest.Mock).mockResolvedValue({ ok: true, passed: true, result: {} });
    const res = await request(app)
      .post('/api/v1/autopilot/controller/runs/VTID-01234/verify')
      .send({ service: 'gateway' });
    expect(res.status).toBe(200);
  });

  it('POST /controller/runs/:vtid/validate requires pr_number', async () => {
    const res = await request(app).post('/api/v1/autopilot/controller/runs/VTID-01234/validate').send({});
    expect(res.status).toBe(400);
  });

  it('POST /controller/runs/:vtid/validate returns 422 when the merge check fails', async () => {
    (validateForMerge as jest.Mock).mockResolvedValue({ ok: true, passed: false, result: {} });
    const res = await request(app)
      .post('/api/v1/autopilot/controller/runs/VTID-01234/validate')
      .send({ pr_number: 42 });
    expect(res.status).toBe(422);
  });

  it('GET /spec/:vtid 404s when no snapshot exists', async () => {
    (getSpecSnapshot as jest.Mock).mockReturnValue(null);
    const res = await request(app).get('/api/v1/autopilot/spec/VTID-01234');
    expect(res.status).toBe(404);
  });

  it('GET /spec/:vtid 200s with integrity_valid computed', async () => {
    (getSpecSnapshot as jest.Mock).mockReturnValue({ id: 'snap-1', content: '# spec' });
    (verifySpecIntegrity as jest.Mock).mockReturnValue(true);
    const res = await request(app).get('/api/v1/autopilot/spec/VTID-01234');
    expect(res.status).toBe(200);
    expect(res.body.integrity_valid).toBe(true);
  });

  it('GET /validation/:vtid 404s when no result exists', async () => {
    (getValidationResult as jest.Mock).mockReturnValue(null);
    const res = await request(app).get('/api/v1/autopilot/validation/VTID-01234');
    expect(res.status).toBe(404);
  });
});

describe('GET /controller/status, GET /controller/runs', () => {
  it('returns controller status', async () => {
    (getAutopilotStatus as jest.Mock).mockReturnValue({ status: 'idle', active_runs: 0 });
    const res = await request(app).get('/api/v1/autopilot/controller/status');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('autopilot-controller');
  });

  it('lists active runs with only the summarized fields', async () => {
    (getActiveRuns as jest.Mock).mockReturnValue([
      { id: 'r1', vtid: 'VTID-01234', state: 'executing', started_at: 't1', updated_at: 't2', pr_number: 5, retry_count: 0, internal_secret: 'nope' },
    ]);
    const res = await request(app).get('/api/v1/autopilot/controller/runs');
    expect(res.status).toBe(200);
    expect(res.body.runs[0]).not.toHaveProperty('internal_secret');
    expect(res.body.count).toBe(1);
  });
});

// =============================================================================
// VTID-01179: Event Loop endpoints
// =============================================================================

describe('Event loop endpoints', () => {
  it('GET /loop/status forwards the service result', async () => {
    (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: true, poll_ms: 5000 });
    const res = await request(app).get('/api/v1/autopilot/loop/status');
    expect(res.status).toBe(200);
    expect(res.body.is_running).toBe(true);
  });

  it('POST /loop/start reports started:false when disabled by config (not an error)', async () => {
    (startEventLoop as jest.Mock).mockResolvedValue(false);
    const res = await request(app).post('/api/v1/autopilot/loop/start');
    expect(res.status).toBe(200);
    expect(res.body.started).toBe(false);
  });

  it('POST /loop/stop 200s', async () => {
    (stopEventLoop as jest.Mock).mockResolvedValue(undefined);
    const res = await request(app).post('/api/v1/autopilot/loop/stop');
    expect(res.status).toBe(200);
  });

  it('GET /loop/history clamps limit between 1 and 500', async () => {
    (getEventLoopHistory as jest.Mock).mockResolvedValue([]);
    await request(app).get('/api/v1/autopilot/loop/history?limit=999999');
    expect(getEventLoopHistory).toHaveBeenCalledWith(500);

    await request(app).get('/api/v1/autopilot/loop/history?limit=-5');
    expect(getEventLoopHistory).toHaveBeenCalledWith(1);
  });

  it('POST /loop/cursor/reset requires a timestamp', async () => {
    const res = await request(app).post('/api/v1/autopilot/loop/cursor/reset').send({});
    expect(res.status).toBe(400);
  });

  it('POST /loop/cursor/reset accepts "now" without Date.parse validation', async () => {
    (resetEventLoopCursor as jest.Mock).mockResolvedValue({ ok: true });
    const res = await request(app).post('/api/v1/autopilot/loop/cursor/reset').send({ timestamp: 'now' });
    expect(res.status).toBe(200);
    expect(resetEventLoopCursor).toHaveBeenCalledWith('now', 'manual-reset-via-api');
  });

  it('POST /loop/cursor/reset rejects an unparsable timestamp', async () => {
    const res = await request(app).post('/api/v1/autopilot/loop/cursor/reset').send({ timestamp: 'not-a-date' });
    expect(res.status).toBe(400);
  });

  it('POST /loop/cursor/reset accepts a valid ISO timestamp with a custom reason', async () => {
    (resetEventLoopCursor as jest.Mock).mockResolvedValue({ ok: true });
    const res = await request(app)
      .post('/api/v1/autopilot/loop/cursor/reset')
      .send({ timestamp: '2026-01-16T00:00:00Z', reason: 'post-incident recovery' });
    expect(res.status).toBe(200);
    expect(resetEventLoopCursor).toHaveBeenCalledWith('2026-01-16T00:00:00Z', 'post-incident recovery');
  });
});

// =============================================================================
// GET /health — derived health status
// =============================================================================

describe('GET /health', () => {
  it('reports healthy when the loop is running with no errors', async () => {
    (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: true, ok: true });
    const res = await request(app).get('/api/v1/autopilot/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.ok).toBe(true);
  });

  it('reports degraded (still HTTP 200) when the loop is enabled but not running', async () => {
    // VTID-03401: degraded is reserved for a genuine stall — enabled but not
    // running. A config-disarmed loop reports ok_governance_limited instead.
    (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: false, ok: true, config: { enabled: true } });
    const res = await request(app).get('/api/v1/autopilot/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toMatch(/not running/);
  });

  it('reports ok_governance_limited (ok:true) when the loop is disarmed by config', async () => {
    (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: false, ok: true, config: { enabled: false } });
    const res = await request(app).get('/api/v1/autopilot/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok_governance_limited');
    expect(res.body.ok).toBe(true);
    expect(res.body.note).toMatch(/idle by design/);
  });

  it('reports error status with the loop error message when the loop IS running but unhealthy', async () => {
    // The route's reason logic checks `!loopRunning` first — a not-running
    // loop always reports the "not running" message regardless of `error`.
    // To see loopStatus.error surfaced, the loop must be running but ok:false.
    (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: true, ok: false, error: 'db unreachable' });
    const res = await request(app).get('/api/v1/autopilot/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect(res.body.reason).toBe('db unreachable');
  });

  it('reports "not running" as the reason even when both is_running=false AND error is set', async () => {
    (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: false, ok: false, error: 'db unreachable' });
    const res = await request(app).get('/api/v1/autopilot/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect(res.body.reason).toBe('Event loop is enabled but not running — autopilot may have stalled');
  });

  it('degrades gracefully (does not 500) when getEventLoopStatus throws', async () => {
    (getEventLoopStatus as jest.Mock).mockRejectedValue(new Error('unreachable'));
    const res = await request(app).get('/api/v1/autopilot/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });
});

// =============================================================================
// GET /pipeline/health, GET /pipeline/summary — raw-fetch Supabase queries
// =============================================================================

describe('GET /pipeline/health', () => {
  it('returns 500 when Supabase env vars are missing', async () => {
    delete process.env.SUPABASE_URL;
    const res = await request(app).get('/api/v1/autopilot/pipeline/health');
    expect(res.status).toBe(500);
    process.env.SUPABASE_URL = 'http://localhost:54321';
  });

  it('aggregates loop status, task counts, and stuck tasks', async () => {
    (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: true, execution_armed: true, config: {}, stats: {} });
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('count_tasks_by_status')) {
        return Promise.resolve(jsonRes(200, [{ status: 'in_progress', count: 3 }]));
      }
      if (url.includes('vtid_ledger') && url.includes('updated_at=lt')) {
        return Promise.resolve(jsonRes(200, [{ vtid: 'VTID-1', title: 'Stuck', updated_at: new Date(Date.now() - 7200000).toISOString() }]));
      }
      if (url.includes('oasis_events')) {
        return Promise.resolve(jsonRes(200, [{ id: 'evt-1' }]));
      }
      return Promise.resolve(jsonRes(200, []));
    });
    const res = await request(app).get('/api/v1/autopilot/pipeline/health');
    expect(res.status).toBe(200);
    expect(res.body.tasks.in_progress).toBe(3);
    expect(res.body.stuck_count).toBe(1);
    expect(res.body.workers_active).toBe(true);
  });
});

describe('GET /pipeline/summary', () => {
  it('returns 500 when Supabase env vars are missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE;
    const res = await request(app).get('/api/v1/autopilot/pipeline/summary');
    expect(res.status).toBe(500);
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
  });

  it('computes a funnel + success rate from the aggregated queries', async () => {
    (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: true, execution_armed: true });
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('status=eq.completed') && url.includes('updated_at=gt')) {
        return Promise.resolve(jsonRes(200, [{ vtid: 'VTID-1' }, { vtid: 'VTID-2' }]));
      }
      if (url.includes('status=in.(rejected,voided)')) {
        return Promise.resolve(jsonRes(200, [{ vtid: 'VTID-3' }]));
      }
      if (url.includes('status=eq.completed')) {
        return Promise.resolve(jsonRes(200, [{ vtid: 'VTID-1' }, { vtid: 'VTID-2' }]));
      }
      if (url.includes('status=eq.in_progress')) {
        return Promise.resolve(jsonRes(200, []));
      }
      if (url.includes('status=in.(scheduled,pending)') && url.includes('spec_status.is.null')) {
        return Promise.resolve(jsonRes(200, [])); // blocked
      }
      if (url.includes('status=in.(scheduled,pending)') && url.includes('spec_status=eq.validated')) {
        return Promise.resolve(jsonRes(200, [])); // new/ready
      }
      if (url.includes('status=in.(scheduled,pending)')) {
        return Promise.resolve(jsonRes(200, []));
      }
      if (url.includes('autopilot_recommendations')) {
        return Promise.resolve(jsonRes(200, []));
      }
      return Promise.resolve(jsonRes(200, []));
    });
    const res = await request(app).get('/api/v1/autopilot/pipeline/summary');
    expect(res.status).toBe(200);
    expect(res.body.funnel.completed).toBe(2);
    // 2 completed / (2 completed + 1 failed + 0 broken) = 67%
    expect(res.body.success_rate).toBe(67);
    expect(res.body.execution_armed).toBe(true);
  });
});
