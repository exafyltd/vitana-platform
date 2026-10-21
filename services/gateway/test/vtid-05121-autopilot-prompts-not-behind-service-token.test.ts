/**
 * VTID-05121: the /api/v1/autopilot service-token gate must not swallow the
 * member-facing autopilot-prompts router mounted after it at the same prefix
 * (/prefs, /prompts/*). From 2026-08-10 (#2867) until this fix every member
 * request there answered 401 "missing bearer token" / "invalid service token"
 * from the pipeline gate and never reached getUserContext. Same class of bug as
 * VTID-04530 (recommendations).
 *
 * Also pins the per-user rate limits (VTID-04904 pattern) on the three write
 * routes the hand-off re-opens: POST /prefs (30), POST /prompts/generate (10),
 * POST /prompts/:id/action (60), per 15 minutes. Identities are real HS256
 * JWTs verified by optionalAuth against a test secret; a forged token does not
 * verify and falls back to the X-Forwarded-For / IP bucket.
 */
import supertestBase from 'supertest';
import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';
import * as jose from 'jose';

const TEST_SECRET = 'test-supabase-jwt-secret-for-vtid-05121';
process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';
process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
delete process.env.LOVABLE_JWT_SECRET;
delete process.env.SUPABASE_AUTH_JWKS_URL;

// --- autopilot.ts (pipeline router) dependencies, as in the VTID-04530 suite ---
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

// --- autopilot-prompts.ts dependencies, as in test/routes/autopilot-prompts.test.ts ---
const mockRpc = jest.fn();
const mockGetUser = jest.fn();
jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: () => ({ rpc: mockRpc, auth: { getUser: mockGetUser } }),
}));
jest.mock('../src/services/dependency-probe', () => ({
  withDependencyHealth: async (_deps: unknown, body: unknown) => body,
}));
// No service-role client: optionalAuth's vitana_id / active-day side lookups
// and the primary-tenant fallback all short-circuit (nothing touches a DB).
jest.mock('../src/lib/supabase', () => ({
  ...jest.requireActual('../src/lib/supabase'),
  getSupabase: () => null,
}));
const mockGetPromptPrefs = jest.fn();
const mockUpdatePromptPrefs = jest.fn();
const mockGeneratePrompts = jest.fn();
const mockGetTodayPrompts = jest.fn();
const mockExecutePromptAction = jest.fn();
jest.mock('../src/services/autopilot-prompts-service', () => ({
  getPromptPrefs: (...a: any[]) => mockGetPromptPrefs(...a),
  updatePromptPrefs: (...a: any[]) => mockUpdatePromptPrefs(...a),
  generatePrompts: (...a: any[]) => mockGeneratePrompts(...a),
  getTodayPrompts: (...a: any[]) => mockGetTodayPrompts(...a),
  executePromptAction: (...a: any[]) => mockExecutePromptAction(...a),
}));

import autopilotRouter from '../src/routes/autopilot';
import autopilotPromptsRouter from '../src/routes/autopilot-prompts';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const MEMBER = 'Bearer member.jwt.token';
const PROMPT_ID = '11111111-1111-4111-8111-111111111111';

async function signMember(userId: string, secret = TEST_SECRET): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new jose.SignJWT({ aud: 'authenticated', role: 'authenticated', email: `${userId}@example.com` })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(secret));
  return `Bearer ${jwt}`;
}

/** Production order with a stub in place of the prompts router: isolates the gate. */
function buildGateApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/autopilot', autopilotRouter);
  const stub = Router();
  stub.all('*', (req, res) =>
    res.status(200).json({ ok: true, reached: 'prompts', path: req.path, auth: req.header('authorization') ?? null }),
  );
  app.use('/api/v1/autopilot', stub);
  return app;
}

/** Production order with the real prompts router (index.ts:881,884). */
function buildRealApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/autopilot', autopilotRouter);
  app.use('/api/v1/autopilot', autopilotPromptsRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  // The route trusts me_context, which the user-scoped client resolves from the
  // caller's own JWT in production; here it is a fixed member.
  mockRpc.mockResolvedValue({ data: { tenant_id: TENANT, user_id: 'member-from-me-context' }, error: null });
  mockGetPromptPrefs.mockResolvedValue({ ok: true, prefs: { enabled: true } });
  mockUpdatePromptPrefs.mockResolvedValue({ ok: true, prefs: { enabled: true } });
  mockGeneratePrompts.mockResolvedValue({ ok: true, generated: 0, prompts: [] });
  mockGetTodayPrompts.mockResolvedValue({ ok: true, prompts: [] });
  mockExecutePromptAction.mockResolvedValue({ ok: true, prompt_id: PROMPT_ID, action: 'not_now', new_state: 'dismissed' });
});

describe('VTID-05121 service-token gate vs the autopilot-prompts router', () => {
  const app = buildGateApp();

  it.each([
    ['GET', '/api/v1/autopilot/prefs'],
    ['POST', '/api/v1/autopilot/prefs'],
    ['GET', '/api/v1/autopilot/prompts/today'],
    ['POST', '/api/v1/autopilot/prompts/generate'],
    ['POST', '/api/v1/autopilot/prompts/abc/action'],
    ['GET', '/api/v1/autopilot/prefs/'],
  ])('%s %s with a member JWT reaches the prompts router, header untouched', async (method, url) => {
    const res = await (supertestBase(app) as any)[method.toLowerCase()](url).set('Authorization', MEMBER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reached: 'prompts', auth: MEMBER });
  });

  it('without a token the request still reaches the prompts router (it decides, not the pipeline gate)', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/prompts/today');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reached: 'prompts', auth: null });
  });

  it('pipeline routes keep the service-token gate', async () => {
    const a = await supertestBase(app).get('/api/v1/autopilot/tasks/pending-plan').set('Authorization', MEMBER);
    expect(a.status).toBe(401);
    expect(a.body.error).toBe('invalid service token');

    const b = await supertestBase(app).get('/api/v1/autopilot/controller/status');
    expect(b.status).toBe(401);
    expect(b.body).toEqual({ ok: false, error: 'missing bearer token' });

    const c = await supertestBase(app).post('/api/v1/autopilot/loop/start').set('Authorization', MEMBER);
    expect(c.status).toBe(401);
    expect(c.body.reached).toBeUndefined();
  });

  it.each(['/api/v1/autopilot/prefsX', '/api/v1/autopilot/promptsX', '/api/v1/autopilot/prompt/today'])(
    'look-alike path %s is not exempt',
    async (url) => {
      const res = await supertestBase(app).get(url).set('Authorization', MEMBER);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid service token');
    },
  );

  it('/prompts/health keeps its earlier health exemption', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/prompts/health');
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe('prompts');
  });
});

describe('VTID-05121 real autopilot-prompts router behind the pipeline router', () => {
  const app = buildRealApp();

  it('GET /prefs with a member JWT reaches getPromptPrefs and answers 200', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/prefs').set('Authorization', await signMember('e2e-user-1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, prefs: { enabled: true } });
    expect(mockGetPromptPrefs).toHaveBeenCalledWith(TENANT, 'member-from-me-context');
  });

  it('GET /prefs without a header answers the member gate 401 UNAUTHENTICATED, not the service-token gate', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/prefs');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    expect(mockGetPromptPrefs).not.toHaveBeenCalled();
  });

  it('GET /prompts/today without a header answers 401 UNAUTHENTICATED', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/prompts/today');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('a pipeline route on the same app still answers the service-token gate', async () => {
    const res = await supertestBase(app).get('/api/v1/autopilot/controller/status');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'missing bearer token' });
  });
});

describe('VTID-05121 per-user rate limits on the write routes', () => {
  const app = buildRealApp();

  async function hit(method: 'get' | 'post', url: string, auth: string | null, body: object = {}, xff?: string) {
    let r = (supertestBase(app) as any)[method](url);
    if (auth) r = r.set('Authorization', auth);
    if (xff) r = r.set('X-Forwarded-For', xff);
    return method === 'post' ? r.send(body) : r;
  }

  it('the 11th POST /prompts/generate from one user in the window is 429; another user is unaffected', async () => {
    const a = await signMember('rl-generate-user-a');
    for (let i = 0; i < 10; i++) {
      const res = await hit('post', '/api/v1/autopilot/prompts/generate', a);
      expect(res.status).toBe(200);
    }
    const over = await hit('post', '/api/v1/autopilot/prompts/generate', a);
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ ok: false, error: 'RATE_LIMIT_EXCEEDED' });
    expect(mockGeneratePrompts).toHaveBeenCalledTimes(10);

    const b = await hit('post', '/api/v1/autopilot/prompts/generate', await signMember('rl-generate-user-b'));
    expect(b.status).toBe(200);
    expect(mockGeneratePrompts).toHaveBeenCalledTimes(11);
  });

  it('the 61st POST /prompts/:id/action from one user is 429', async () => {
    const a = await signMember('rl-action-user-a');
    for (let i = 0; i < 60; i++) {
      const res = await hit('post', `/api/v1/autopilot/prompts/${PROMPT_ID}/action`, a, { action: 'not_now' });
      expect(res.status).toBe(200);
    }
    const over = await hit('post', `/api/v1/autopilot/prompts/${PROMPT_ID}/action`, a, { action: 'not_now' });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('RATE_LIMIT_EXCEEDED');
    const b = await hit('post', `/api/v1/autopilot/prompts/${PROMPT_ID}/action`, await signMember('rl-action-user-b'), { action: 'not_now' });
    expect(b.status).toBe(200);
  });

  it('the 31st POST /prefs from one user is 429', async () => {
    const a = await signMember('rl-prefs-user-a');
    for (let i = 0; i < 30; i++) {
      const res = await hit('post', '/api/v1/autopilot/prefs', a, { enabled: true });
      expect(res.status).toBe(200);
    }
    const over = await hit('post', '/api/v1/autopilot/prefs', a, { enabled: true });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('RATE_LIMIT_EXCEEDED');
    const b = await hit('post', '/api/v1/autopilot/prefs', await signMember('rl-prefs-user-b'), { enabled: true });
    expect(b.status).toBe(200);
  });

  it('GET /prefs and GET /prompts/today are never rate limited', async () => {
    const a = await signMember('rl-get-user-a');
    for (let i = 0; i < 40; i++) {
      expect((await hit('get', '/api/v1/autopilot/prefs', a)).status).toBe(200);
      expect((await hit('get', '/api/v1/autopilot/prompts/today', a)).status).toBe(200);
    }
  });

  it('a forged token gets no user bucket: it shares the X-Forwarded-For bucket', async () => {
    const xff = '203.0.113.7, 10.0.0.1';
    for (let i = 0; i < 10; i++) {
      // A different forged subject each time: if forged tokens minted their own
      // bucket, none of these would ever reach the limit.
      const forged = await signMember(`forged-${i}`, 'not-the-real-secret');
      expect((await hit('post', '/api/v1/autopilot/prompts/generate', forged, {}, xff)).status).toBe(200);
    }
    const over = await hit('post', '/api/v1/autopilot/prompts/generate', await signMember('forged-x', 'not-the-real-secret'), {}, xff);
    expect(over.status).toBe(429);

    // Another first hop is another bucket.
    const other = await hit('post', '/api/v1/autopilot/prompts/generate', await signMember('forged-y', 'not-the-real-secret'), {}, '198.51.100.9');
    expect(other.status).toBe(200);
  });
});

describe('VTID-05121 pins', () => {
  it('index.ts still mounts the pipeline router before the autopilot-prompts router', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    const a = idx.indexOf("mountRouterSync(app, '/api/v1/autopilot', autopilotRouter");
    const p = idx.indexOf("mountRouterSync(app, '/api/v1/autopilot', autopilotPromptsRouter");
    expect(a).toBeGreaterThan(-1);
    expect(p).toBeGreaterThan(a);
  });

  it('every non-health handler in autopilot-prompts.ts calls getUserContext (the hand-off opens nothing)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/autopilot-prompts.ts'), 'utf8');
    const routes = [...src.matchAll(/router\.(get|post)\('([^']+)'/g)].map((m) => m[2]);
    expect(routes.sort()).toEqual(['/prefs', '/prefs', '/prompts/:id/action', '/prompts/generate', '/prompts/health', '/prompts/today'].sort());
    const blocks = src.split(/(?=router\.(?:get|post)\(')/).slice(1);
    for (const block of blocks) {
      if (block.startsWith("router.get('/prompts/health'")) continue;
      expect(block).toMatch(/const context = await getUserContext\(req\);/);
    }
  });

  it('the three write routes run optionalAuth before their limiter', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/autopilot-prompts.ts'), 'utf8');
    expect(src).toMatch(/router\.post\('\/prefs', optionalAuth, prefsWriteLimiter,/);
    expect(src).toMatch(/router\.post\('\/prompts\/generate', optionalAuth, generateLimiter,/);
    expect(src).toMatch(/router\.post\('\/prompts\/:id\/action', optionalAuth, actionLimiter,/);
  });
});
