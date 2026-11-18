/**
 * gateway-critical-route-auth, lane worker-orchestrator-auth (VTID-05731).
 *
 * The 12 write routes of routes/worker-orchestrator.ts take
 * requireServiceOrAdmin; GET routes stay open. The two in-repo caller paths
 * (the autopilot event-loop dispatch and the ORB tools' gatewayApiCall) send
 * `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>`.
 *
 *   A. Each write route: no token → 401, wrong token → 401, service token →
 *      not 401/403 (the handler ran past the gate). GET routes: no token → not 401.
 *   B. Event loop: an armed dispatch POSTs /api/v1/worker/orchestrator/route
 *      with the service bearer (driven through startEventLoop under fake timers;
 *      triggerDispatch is module-private).
 *   C. gatewayApiCall: /api/v1/worker/* self-calls carry the service bearer;
 *      a caller-supplied Authorization wins; other paths get no service bearer.
 *   D. Self-healing reconciler: the redispatch POST to
 *      /api/v1/worker/orchestrator/route carries the service bearer. Driven
 *      through the exported startReconciler() under fake timers (the first
 *      cycle runs after 30 s): attemptRedispatch and runReconcileCycle are
 *      module-private, and the module reads SUPABASE_URL / GATEWAY_URL at load,
 *      so it is loaded with jest.isolateModules after the env is set. The
 *      probe is mocked as unhealthy so the cycle takes the redispatch path.
 */

import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Module mocks (shared by the router and the event loop)
// ---------------------------------------------------------------------------

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt' }),
}));

jest.mock('../src/services/system-controls-service', () => ({
  isAutopilotExecutionArmed: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/services/worker-orchestrator-service', () => ({
  routeWorkOrder: jest.fn().mockResolvedValue({ ok: true, domain: 'backend', run_id: 'run-1' }),
  markOrchestratorSuccess: jest.fn().mockResolvedValue(undefined),
  markOrchestratorFailed: jest.fn().mockResolvedValue(undefined),
  emitSubagentStart: jest.fn().mockResolvedValue(undefined),
  emitSubagentSuccess: jest.fn().mockResolvedValue(undefined),
  emitSubagentFailed: jest.fn().mockResolvedValue(undefined),
  completeSubagentWithVerification: jest.fn().mockResolvedValue({ ok: true }),
  completeOrchestratorWithVerification: jest.fn().mockResolvedValue({ ok: true }),
  completeSubagentAdvisory: jest.fn().mockResolvedValue({ ok: true }),
  completeOrchestratorAdvisory: jest.fn().mockResolvedValue({ ok: true }),
  VERIFICATION_MODE: 'advisory',
}));

jest.mock('../src/services/skills/preflight-runner', () => ({
  runPreflightChain: jest.fn().mockResolvedValue({ ok: true, results: [] }),
  listSkills: jest.fn().mockReturnValue([]),
  getPreflightChains: jest.fn().mockReturnValue({}),
}));

jest.mock('../src/routes/agents-registry', () => ({
  fetchServiceTierAgents: jest.fn().mockResolvedValue([]),
}));

// Deterministic JWT leg: a non-service bearer never resolves to an identity,
// so a wrong token is a 401 (same pattern as test/ai-bridge.test.ts).
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock('../src/services/autopilot-controller', () => ({
  markInProgress: jest.fn().mockResolvedValue(undefined),
  markBuilding: jest.fn(),
  markPrCreated: jest.fn(),
  markReviewing: jest.fn(),
  markValidated: jest.fn(),
  markMerged: jest.fn(),
  markDeploying: jest.fn(),
  markVerifying: jest.fn(),
  markCompleted: jest.fn(),
  markFailed: jest.fn(),
  getAutopilotRun: jest.fn(),
  startAutopilotRun: jest.fn().mockResolvedValue(undefined),
  hasValidatorPass: jest.fn(),
}));

jest.mock('../src/services/autopilot-loop-store', () => ({
  getLoopState: jest.fn(),
  setLoopRunning: jest.fn(),
  updateLoopCursor: jest.fn(),
  resetLoopCursor: jest.fn(),
  recordLoopError: jest.fn(),
  getLoopStats: jest.fn(),
  isEventProcessed: jest.fn(),
  recordProcessedEvent: jest.fn(),
  getProcessedEventHistory: jest.fn(),
  getRunState: jest.fn(),
  upsertRunState: jest.fn(),
  updateRunState: jest.fn(),
  transitionRunState: jest.fn(),
  acquireRunLock: jest.fn(),
  releaseRunLock: jest.fn(),
  incrementActionAttempt: jest.fn(),
  canAttemptAction: jest.fn(),
  setBackoffLock: jest.fn(),
  markRunFailed: jest.fn(),
  markRunCompleted: jest.fn(),
}));

jest.mock('../src/services/autopilot-event-mapper', () => ({
  normalizeEventType: jest.fn((e: any) => e.kind || e.type || 'unknown'),
  mapEventToTransition: jest.fn(),
  isAutopilotRelevantEvent: jest.fn(),
}));

// D. reconciler: the stale row's endpoint probes as still down → redispatch path.
// (self-healing-probe is not imported by the router, event loop or developer tools.)
jest.mock('../src/services/self-healing-probe', () => ({
  probeEndpoint: jest.fn().mockResolvedValue({ healthy: false, http_status: 503 }),
}));

import { workerOrchestratorRouter } from '../src/routes/worker-orchestrator';
import * as loopStore from '../src/services/autopilot-loop-store';
import * as eventMapper from '../src/services/autopilot-event-mapper';
import * as eventLoop from '../src/services/autopilot-event-loop';
import { gatewayApiCall } from '../src/services/orb-tools/developer-tools';

const SERVICE_TOKEN = 'svc-token-worker-orchestrator-test';
const mockFetch = global.fetch as jest.Mock;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(workerOrchestratorRouter);
  return app;
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.GATEWAY_SERVICE_TOKEN = SERVICE_TOKEN;
  mockFetch.mockReset();
  // Supabase / self-calls made by a handler that got past the gate: empty rows.
  mockFetch.mockImplementation(async () => jsonResponse(200, []));
});

afterEach(() => {
  process.env = originalEnv;
});

// ---------------------------------------------------------------------------
// A. The 12 write routes
// ---------------------------------------------------------------------------

// [method, path, body for the service-token leg]. The bodies are minimal and
// mostly invalid on purpose: a 400 from the handler's own validation proves
// the request got past requireServiceOrAdmin without touching real state.
const WRITE_ROUTES: Array<['post' | 'delete', string, Record<string, unknown>]> = [
  ['post', '/api/v1/worker/orchestrator/route', {}],
  ['post', '/api/v1/worker/subagent/start', {}],
  ['post', '/api/v1/worker/subagent/complete', {}],
  ['post', '/api/v1/worker/orchestrator/complete', {}],
  ['post', '/api/v1/worker/orchestrator/register', {}],
  ['delete', '/api/v1/worker/orchestrator/register/wk-test', {}],
  ['post', '/api/v1/worker/orchestrator/tasks/VTID-00000/claim', {}],
  ['post', '/api/v1/worker/orchestrator/tasks/VTID-00000/release', {}],
  ['post', '/api/v1/worker/orchestrator/tasks/VTID-00000/progress', {}],
  ['post', '/api/v1/worker/orchestrator/heartbeat', {}],
  // vtid missing → handler's own 400 (its own worker_id 401 is never reached).
  ['post', '/api/v1/worker/orchestrator/await-autopilot-execution', { worker_id: 'wk-test' }],
  ['post', '/api/v1/worker/orchestrator/cleanup', {}],
];

const GATE_ERRORS = new Set([
  'missing bearer token',
  'unauthorized — service token or exafy_admin JWT required',
]);

describe('worker orchestrator write routes require the service token or an exafy_admin JWT', () => {
  it('covers exactly 12 write routes', () => {
    expect(WRITE_ROUTES).toHaveLength(12);
  });

  describe.each(WRITE_ROUTES)('%s %s', (method, path, body) => {
    it('no token → 401 and the handler never runs', async () => {
      const res = await request(buildApp())[method](path).send(body);
      expect(res.status).toBe(401);
      expect(GATE_ERRORS.has(res.body.error)).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('wrong token → 401 and the handler never runs', async () => {
      const res = await request(buildApp())[method](path)
        .set('Authorization', 'Bearer not-the-service-token')
        .send(body);
      expect(res.status).toBe(401);
      expect(GATE_ERRORS.has(res.body.error)).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('service token → handler runs (not 401/403)', async () => {
      const res = await request(buildApp())[method](path)
        .set('Authorization', `Bearer ${SERVICE_TOKEN}`)
        .send(body);
      expect([401, 403]).not.toContain(res.status);
      expect(GATE_ERRORS.has(res.body?.error)).toBe(false);
    });
  });

  it.each([
    '/api/v1/worker/orchestrator/health',
    '/api/v1/worker/skills',
  ])('GET %s stays open (no token → not 401)', async (path) => {
    const res = await request(buildApp()).get(path);
    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// B. Event-loop dispatch sends the service bearer
// ---------------------------------------------------------------------------

describe('autopilot event loop dispatch to /api/v1/worker/orchestrator/route', () => {
  const ROUTE_URL = 'http://gw.test/api/v1/worker/orchestrator/route';

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.AUTOPILOT_LOOP_ENABLED = 'true';
    process.env.AUTOPILOT_LOOP_POLL_MS = '500';
    process.env.GATEWAY_URL = 'http://gw.test';

    (loopStore.getLoopState as jest.Mock).mockResolvedValue({ last_event_timestamp: null });
    (loopStore.setLoopRunning as jest.Mock).mockResolvedValue(true);
    (loopStore.updateLoopCursor as jest.Mock).mockResolvedValue(true);
    (loopStore.recordLoopError as jest.Mock).mockResolvedValue(true);
    (loopStore.isEventProcessed as jest.Mock).mockResolvedValue(false);
    (loopStore.recordProcessedEvent as jest.Mock).mockResolvedValue(true);
    (loopStore.getRunState as jest.Mock).mockResolvedValue({ vtid: 'VTID-LOOP-AUTH', state: 'allocated' });
    (loopStore.transitionRunState as jest.Mock).mockResolvedValue(true);
    (loopStore.acquireRunLock as jest.Mock).mockResolvedValue(true);
    (loopStore.releaseRunLock as jest.Mock).mockResolvedValue(true);
    (loopStore.canAttemptAction as jest.Mock).mockResolvedValue(true);
    (loopStore.incrementActionAttempt as jest.Mock).mockResolvedValue(1);
    (loopStore.setBackoffLock as jest.Mock).mockResolvedValue(true);
    (eventMapper.isAutopilotRelevantEvent as jest.Mock).mockReturnValue(true);
    (eventMapper.mapEventToTransition as jest.Mock).mockReturnValue({
      matched: true,
      toState: 'in_progress',
      triggerAction: 'dispatch',
    });

    mockFetch.mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('/rest/v1/oasis_events')) {
        return jsonResponse(200, [{
          id: 'evt-auth-1',
          created_at: '2026-01-01T00:00:00.000Z',
          vtid: 'VTID-LOOP-AUTH',
          kind: 'vtid.lifecycle.started',
        }]);
      }
      if (u === ROUTE_URL) return jsonResponse(200, { ok: true, domain: 'backend' });
      return jsonResponse(200, []);
    });
  });

  afterEach(async () => {
    await eventLoop.stopEventLoop();
    jest.useRealTimers();
  });

  function routeCalls() {
    return mockFetch.mock.calls.filter(([url]) => String(url) === ROUTE_URL);
  }

  it('sends Authorization: Bearer <GATEWAY_SERVICE_TOKEN>', async () => {
    await eventLoop.startEventLoop();
    await jest.advanceTimersByTimeAsync(500);

    const calls = routeCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const init = calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends no Authorization when GATEWAY_SERVICE_TOKEN is unset (route answers 401, loudly)', async () => {
    delete process.env.GATEWAY_SERVICE_TOKEN;
    await eventLoop.startEventLoop();
    await jest.advanceTimersByTimeAsync(500);

    const calls = routeCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect((calls[0][1] as RequestInit).headers as Record<string, string>).not.toHaveProperty('Authorization');
  });
});

// ---------------------------------------------------------------------------
// C. gatewayApiCall (ORB developer tools' gateway self-call)
// ---------------------------------------------------------------------------

describe('gatewayApiCall', () => {
  beforeEach(() => {
    process.env.GATEWAY_URL = 'http://gw.test';
    mockFetch.mockImplementation(async () => jsonResponse(200, { ok: true }));
  });

  function lastInit(): { url: string; headers: Record<string, string> } {
    const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    return { url: String(url), headers: (init as RequestInit).headers as Record<string, string> };
  }

  it.each([
    '/api/v1/worker/orchestrator/route',
    '/api/v1/worker/subagent/complete',
    '/api/v1/worker/orchestrator/tasks/VTID-00000/release',
    '/api/v1/worker/orchestrator/cleanup',
  ])('%s carries Authorization: Bearer <GATEWAY_SERVICE_TOKEN> to the gateway base URL', async (path) => {
    await gatewayApiCall(path, { method: 'POST', body: {} });
    const { url, headers } = lastInit();
    expect(url).toBe(`http://gw.test${path}`);
    expect(headers.Authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
  });

  it('a caller-supplied Authorization wins over the service bearer', async () => {
    await gatewayApiCall('/api/v1/worker/orchestrator/route', {
      method: 'POST',
      headers: { Authorization: 'Bearer caller-jwt' },
    });
    expect(lastInit().headers.Authorization).toBe('Bearer caller-jwt');
  });

  it.each([
    '/api/v1/self-healing/report',
    '/api/v1/governance/proposals',
    '/api/v1/approvals/feed',
  ])('%s (not a worker route) gets no service bearer', async (path) => {
    await gatewayApiCall(path, { method: 'POST', body: {} });
    expect(lastInit().headers).not.toHaveProperty('Authorization');
  });

  it.each([
    '/api/v1/worker/../self-healing/report',
    '/api/v1/worker/%2e%2e/self-healing/report',
  ])('%s (dot segment out of /api/v1/worker/) gets no service bearer', async (path) => {
    await gatewayApiCall(path, { method: 'POST', body: {} });
    expect(lastInit().headers).not.toHaveProperty('Authorization');
  });

  it('no Authorization on worker routes when GATEWAY_SERVICE_TOKEN is unset', async () => {
    delete process.env.GATEWAY_SERVICE_TOKEN;
    await gatewayApiCall('/api/v1/worker/orchestrator/route', { method: 'POST', body: {} });
    expect(lastInit().headers).not.toHaveProperty('Authorization');
  });
});

// ---------------------------------------------------------------------------
// D. Self-healing reconciler redispatch sends the service bearer
// ---------------------------------------------------------------------------

describe('self-healing reconciler redispatch to /api/v1/worker/orchestrator/route', () => {
  const ROUTE_URL = 'http://gw.test/api/v1/worker/orchestrator/route';
  type Reconciler = typeof import('../src/services/self-healing-reconciler');
  let reconciler: Reconciler;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
    process.env.GATEWAY_URL = 'http://gw.test';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      reconciler = require('../src/services/self-healing-reconciler');
    });

    mockFetch.mockImplementation(async (url: any) => {
      const u = String(url);
      // autopilot-linked scan: nothing linked
      if (u.includes('/rest/v1/vtid_ledger?metadata->>autopilot_execution_id')) return jsonResponse(200, []);
      // stale scan: one pending, non-voice row with no previous redispatch
      if (u.includes('/rest/v1/self_healing_log?select=')) {
        return jsonResponse(200, [{
          id: 'shl-1',
          vtid: 'VTID-RECON-AUTH',
          endpoint: '/api/v1/example/health',
          failure_class: 'http_5xx',
          created_at: '2026-01-01T00:00:00.000Z',
          diagnosis: {},
          attempt_number: 1,
        }]);
      }
      // spec lookup for the redispatch
      if (u.includes('/rest/v1/vtid_ledger?vtid=eq.')) {
        return jsonResponse(200, [{ title: 'SELF-HEAL: example', summary: 'fix the example endpoint' }]);
      }
      if (u === ROUTE_URL) return jsonResponse(200, { ok: true });
      return jsonResponse(200, []);
    });
  });

  afterEach(() => {
    reconciler.stopReconciler();
    jest.useRealTimers();
  });

  function routeCalls() {
    return mockFetch.mock.calls.filter(([url]) => String(url) === ROUTE_URL);
  }

  it('sends Authorization: Bearer <GATEWAY_SERVICE_TOKEN>', async () => {
    reconciler.startReconciler();
    await jest.advanceTimersByTimeAsync(30_000);

    const calls = routeCalls();
    expect(calls).toHaveLength(1);
    const init = calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toMatchObject({ vtid: 'VTID-RECON-AUTH', source: 'self-healing-reconciler' });
  });

  it('sends no Authorization when GATEWAY_SERVICE_TOKEN is unset (route answers 401, loudly)', async () => {
    delete process.env.GATEWAY_SERVICE_TOKEN;
    reconciler.startReconciler();
    await jest.advanceTimersByTimeAsync(30_000);

    const calls = routeCalls();
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as RequestInit).headers as Record<string, string>).not.toHaveProperty('Authorization');
  });

  it('logs one error per process when GATEWAY_SERVICE_TOKEN is unset (sparring R1-F2)', async () => {
    delete process.env.GATEWAY_SERVICE_TOKEN;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    reconciler.startReconciler();
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(routeCalls().length).toBeGreaterThanOrEqual(1);
    const warnings = errSpy.mock.calls.filter((c) => String(c[0]).includes('GATEWAY_SERVICE_TOKEN unset'));
    expect(warnings).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('logs no such error when the token is set', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    reconciler.startReconciler();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('GATEWAY_SERVICE_TOKEN unset'))).toBe(false);
    errSpy.mockRestore();
  });
});
