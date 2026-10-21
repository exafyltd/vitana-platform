/**
 * VTID-04530: the /api/v1/autopilot service-token gate must not swallow the
 * member-facing recommendations router mounted after it at
 * /api/v1/autopilot/recommendations. From 2026-08-10 (#2867) until this fix,
 * every member request to the Autopilot popup (list, count, activate, draft)
 * returned 401 "invalid service token" because the routers were never tested
 * mounted together in production order.
 */
import supertestBase from 'supertest';
import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';

process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';

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


import autopilotRouter from '../src/routes/autopilot';

function buildApp() {
  const app = express();
  app.use(express.json());
  // Production order (index.ts): the pipeline router first, then the
  // recommendations router at its own sub-prefix.
  app.use('/api/v1/autopilot', autopilotRouter);
  const recs = Router();
  recs.all('*', (req, res) => res.status(200).json({ ok: true, reached: 'recommendations', path: req.path, auth: req.header('authorization') ?? null }));
  app.use('/api/v1/autopilot/recommendations', recs);
  return app;
}

const MEMBER = 'Bearer member.jwt.token';

describe('VTID-04530 service-token gate vs the recommendations router', () => {
  const app = buildApp();

  it.each([
    ['GET', '/api/v1/autopilot/recommendations'],
    ['GET', '/api/v1/autopilot/recommendations/count'],
    ['POST', '/api/v1/autopilot/recommendations/11111111-1111-4111-8111-111111111111/activate'],
    ['POST', '/api/v1/autopilot/recommendations/11111111-1111-4111-8111-111111111111/draft'],
  ])('%s %s with a member JWT reaches the recommendations router', async (method, url) => {
    const res = await (supertestBase(app) as any)[method.toLowerCase()](url).set('Authorization', MEMBER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reached: 'recommendations', auth: MEMBER });
  });

  it('the member request is handed on untouched even without a token (the recommendations router decides)', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/recommendations/count');
    expect(res.body.reached).toBe('recommendations');
  });

  it('pipeline routes still require the service token', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/tasks/pending-plan').set('Authorization', MEMBER);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid service token');
  });

  it('a look-alike prefix is not exempt', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/recommendationsX').set('Authorization', MEMBER);
    expect(res.status).toBe(401);
  });

  it('index.ts still mounts the pipeline router before the recommendations router (the order this guard exists for)', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    const a = idx.indexOf("mountRouterSync(app, '/api/v1/autopilot', autopilotRouter");
    const r = idx.indexOf("mountRouterSync(app, '/api/v1/autopilot/recommendations', autopilotRecommendationsRouter");
    expect(a).toBeGreaterThan(-1);
    expect(r).toBeGreaterThan(a);
  });

  it('the recommendations router verifies member identity itself (so the hand-off opens nothing)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/autopilot-recommendations.ts'), 'utf8');
    expect(src).toMatch(/router\.use\(optionalAuth\)/);
    expect(src).toMatch(/const OPEN_PATHS = new Set\(\['\/health'\]\)/);
    expect(src).toMatch(/status\(401\)\.json\(\{ ok: false, error: 'UNAUTHENTICATED' \}\)/);
  });
});
