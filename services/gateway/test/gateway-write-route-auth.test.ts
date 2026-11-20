/**
 * VTID-05697 (gateway-write-route-auth/route-auth): SB-CON-22.
 *
 * Six gateway write routes (the five of SB-CON-22 plus POST /llm/routing-policy) ran with no authentication: no global /api/v1 gate exists (index.ts:598-640) and
 * the routers had no router.use. Each now carries an existing control-plane gate as its first middleware:
 *   PATCH /api/v1/specs/:vtid                        requireServiceOrAdmin
 *   POST  /api/v1/agents/triage/investigate          requireAdminOnly
 *   PUT   /api/v1/ai-personality/:surface_key        requireAdminOnly
 *   POST  /api/v1/ai-personality/:surface_key/reset  requireAdminOnly
 *   POST  /api/v1/llm/routing-policy                 requireServiceOrAdmin
 *   POST  /api/v1/llm/routing-policy/reset           requireServiceOrAdmin
 * and the llm routes no longer take the actor from x-actor-role / x-actor-id.
 *
 * For every route: no token -> 401, a non-admin JWT -> 403, x-actor-role: admin alone -> 401, an exafy_admin JWT
 * reaches the handler; the service token reaches the handler only where requireServiceOrAdmin is used. On 401/403
 * no write function (and no outbound fetch) is called.
 */
import express from 'express';
import request from 'supertest';

// JWT leg: 'admin-jwt' is an exafy_admin, 'user-jwt' a signed-in non-admin, anything else is not a valid JWT.
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (req: any, _res: any, next: () => void) => {
    const h = String(req.headers.authorization || '');
    if (h === 'Bearer admin-jwt') req.identity = { user_id: 'u-admin', exafy_admin: true, role: 'authenticated' };
    else if (h === 'Bearer user-jwt') req.identity = { user_id: 'u-user', exafy_admin: false, role: 'authenticated' };
    else if (h === 'Bearer admin-no-id-jwt') req.identity = { user_id: '', exafy_admin: true, role: 'authenticated' };
    next();
  },
  requireAdminAuth: (_req: any, res: any) => res.status(401).json({ ok: false }),
  requireAuth: (_req: any, res: any) => res.status(401).json({ ok: false }),
}));

const mockUpdatePersonality = jest.fn();
const mockResetPersonality = jest.fn();
jest.mock('../src/services/ai-personality-service', () => ({
  VALID_SURFACE_KEYS: ['voice_live', 'text_chat'],
  getAllPersonalityConfigs: jest.fn(async () => []),
  getPersonalityConfig: jest.fn(async (k: string) => ({ surface_key: k })),
  updatePersonalityConfig: (...a: unknown[]) => mockUpdatePersonality(...a),
  resetPersonalityConfig: (...a: unknown[]) => mockResetPersonality(...a),
}));

const mockUpdatePolicy = jest.fn();
const mockResetPolicy = jest.fn();
jest.mock('../src/services/llm-routing-policy-service', () => ({
  getRoutingPolicyResponse: jest.fn(),
  updateRoutingPolicy: (...a: unknown[]) => mockUpdatePolicy(...a),
  resetToDefaults: (...a: unknown[]) => mockResetPolicy(...a),
  getPolicyAuditHistory: jest.fn(),
  getActivePolicy: jest.fn(async () => null),
}));
jest.mock('../src/services/llm-telemetry-service', () => ({ queryLLMTelemetry: jest.fn(), getLLMTelemetrySummary: jest.fn() }));
const mockCallViaRouter = jest.fn();
jest.mock('../src/services/llm-router', () => ({ verifyProvider: jest.fn(), callViaRouter: (...a: unknown[]) => mockCallViaRouter(...a) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import aiPersonalityRouter from '../src/routes/ai-personality';
import llmRouter from '../src/routes/llm';
import { specsRouter } from '../src/routes/specs';
import { triageAgentRouter } from '../src/routes/triage-agent';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/specs', specsRouter);
  app.use('/api/v1/llm', llmRouter);
  app.use('/api/v1/agents/triage', triageAgentRouter);
  app.use('/api/v1/ai-personality', aiPersonalityRouter);
  return app;
}

type Method = 'patch' | 'post' | 'put';
interface RouteCase {
  name: string;
  method: Method;
  path: string;
  body: Record<string, unknown>;
  serviceToken: boolean; // requireServiceOrAdmin accepts the service token
  writes: () => jest.Mock[]; // write functions that must not run on 401/403
}

const STAGE = { primary_provider: 'anthropic', primary_model: 'claude-x', fallback_provider: null, fallback_model: null };
const VALID_POLICY = { planner: STAGE, worker: STAGE, validator: STAGE, operator: STAGE, memory: STAGE, triage: STAGE };

const ROUTES: RouteCase[] = [
  { name: 'PATCH /api/v1/specs/:vtid', method: 'patch', path: '/api/v1/specs/VTID-00001',
    body: { spec_markdown: 'short' }, serviceToken: true, writes: () => [] },
  { name: 'POST /api/v1/agents/triage/investigate', method: 'post', path: '/api/v1/agents/triage/investigate',
    body: {}, serviceToken: false, writes: () => [mockCallViaRouter] },
  { name: 'PUT /api/v1/ai-personality/:surface_key', method: 'put', path: '/api/v1/ai-personality/voice_live',
    body: { config: { tone: 'x' }, reason: 'test' }, serviceToken: false, writes: () => [mockUpdatePersonality] },
  { name: 'POST /api/v1/ai-personality/:surface_key/reset', method: 'post', path: '/api/v1/ai-personality/voice_live/reset',
    body: { reason: 'test' }, serviceToken: false, writes: () => [mockResetPersonality] },
  { name: 'POST /api/v1/llm/routing-policy', method: 'post', path: '/api/v1/llm/routing-policy',
    body: { policy: VALID_POLICY, reason: 'test' }, serviceToken: true, writes: () => [mockUpdatePolicy] },
  { name: 'POST /api/v1/llm/routing-policy/reset', method: 'post', path: '/api/v1/llm/routing-policy/reset',
    body: { reason: 'test' }, serviceToken: true, writes: () => [mockResetPolicy] },
];

function send(c: RouteCase, headers: Record<string, string>) {
  let r = request(buildApp())[c.method](c.path);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(c.body);
}

describe('VTID-05697 gateway write routes require the existing control-plane gates', () => {
  const ORIGINAL_TOKEN = process.env.GATEWAY_SERVICE_TOKEN;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';
    for (const m of [mockUpdatePersonality, mockResetPersonality, mockUpdatePolicy, mockResetPolicy, mockCallViaRouter]) m.mockReset();
    mockUpdatePersonality.mockResolvedValue({ ok: true });
    mockResetPersonality.mockResolvedValue({ ok: true });
    mockUpdatePolicy.mockResolvedValue({ ok: true, policy: { version: 2 } });
    mockResetPolicy.mockResolvedValue({ ok: true, policy: { version: 3 } });
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no network in tests'));
  });

  afterEach(() => fetchSpy.mockRestore());

  afterAll(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.GATEWAY_SERVICE_TOKEN;
    else process.env.GATEWAY_SERVICE_TOKEN = ORIGINAL_TOKEN;
  });

  function expectNoWrite(c: RouteCase) {
    for (const m of c.writes()) expect(m).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  }

  describe.each(ROUTES)('$name', (c) => {
    it('rejects a request with no token (401) and writes nothing', async () => {
      const res = await send(c, {});
      expect(res.status).toBe(401);
      expectNoWrite(c);
    });

    it('rejects x-actor-role: admin without a token (401): a caller header cannot grant privilege', async () => {
      const res = await send(c, { 'x-actor-role': 'admin', 'x-actor-id': 'attacker' });
      expect(res.status).toBe(401);
      expectNoWrite(c);
    });

    it('rejects a token that is neither the service token nor a valid JWT (401)', async () => {
      const res = await send(c, { Authorization: 'Bearer forged' });
      expect(res.status).toBe(401);
      expectNoWrite(c);
    });

    it('rejects a signed-in non-admin who also sends x-actor-role: admin (403)', async () => {
      const res = await send(c, { Authorization: 'Bearer user-jwt', 'x-actor-role': 'admin', 'x-actor-id': 'attacker' });
      expect(res.status).toBe(403);
      expectNoWrite(c);
    });

    it('rejects a signed-in user without exafy_admin (403) and writes nothing', async () => {
      const res = await send(c, { Authorization: 'Bearer user-jwt' });
      expect(res.status).toBe(403);
      expectNoWrite(c);
    });

    it('lets an exafy_admin JWT reach the handler', async () => {
      const res = await send(c, { Authorization: 'Bearer admin-jwt' });
      expect([401, 403]).not.toContain(res.status);
    });

    it(c.serviceToken ? 'lets the service token reach the handler' : 'rejects the service token (admin only)', async () => {
      const res = await send(c, { Authorization: 'Bearer test-service-token' });
      if (c.serviceToken) {
        expect([401, 403]).not.toContain(res.status);
      } else {
        expect([401, 403]).toContain(res.status);
        expectNoWrite(c);
      }
    });
  });

  it('the handlers ran for an admin: specs and triage reach their own validation (400), the writes are called', async () => {
    const specs = await send(ROUTES[0], { Authorization: 'Bearer admin-jwt' });
    expect(specs.status).toBe(400);
    expect(specs.body.error).toMatch(/spec_markdown required/);
    const triage = await send(ROUTES[1], { Authorization: 'Bearer admin-jwt' });
    expect(triage.status).toBe(400);
    expect(triage.body.error).toMatch(/session_id is required/);
    for (const c of ROUTES.slice(2)) {
      const res = await send(c, { Authorization: 'Bearer admin-jwt' });
      expect(res.status).toBe(200);
      for (const m of c.writes()) expect(m).toHaveBeenCalledTimes(1);
    }
  });

  it('audit actor comes from the gate: admin JWT -> user id + exafy_admin; service token -> internal + service', async () => {
    await send(ROUTES[2], { Authorization: 'Bearer admin-jwt', 'x-actor-role': 'infra' });
    expect(mockUpdatePersonality).toHaveBeenCalledWith('voice_live', { tone: 'x' }, 'test', 'u-admin', 'exafy_admin');

    await send(ROUTES[5], { Authorization: 'Bearer test-service-token', 'x-actor-id': 'spoof', 'x-actor-role': 'admin' });
    expect(mockResetPolicy).toHaveBeenCalledWith({ actor_id: 'internal', actor_role: 'service', reason: 'test' }, 'DEV');

    await send(ROUTES[3], { Authorization: 'Bearer admin-jwt', 'x-actor-role': 'infra' });
    expect(mockResetPersonality).toHaveBeenCalledWith('voice_live', 'test', 'u-admin', 'exafy_admin');

    await send(ROUTES[2], { Authorization: 'Bearer admin-no-id-jwt' });
    expect(mockUpdatePersonality).toHaveBeenLastCalledWith('voice_live', { tone: 'x' }, 'test', 'unknown', 'exafy_admin');

    await send(ROUTES[4], { Authorization: 'Bearer admin-jwt', 'x-actor-id': 'spoof' });
    expect(mockUpdatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ actor_id: 'u-admin', actor_role: 'exafy_admin' }),
      'DEV',
    );
  });
});
