/**
 * VTID-04875 — Overview Phase 1a: characterization of
 * GET /api/v1/autopilot/pipeline/summary across the extraction of its inline
 * handler into services/pipeline-summary-builder.ts.
 *
 * The "route" describe block was written FIRST and run against the old
 * inline handler; its snapshots (__snapshots__/vtid-04875-pipeline-summary-
 * builder.test.ts.snap) record exactly what the old handler returned —
 * status, content-type and JSON body — plus every Supabase request it made
 * (URL + headers, in order). After the refactor the same block is re-run
 * with `--ci` (snapshots may not be rewritten): any byte of drift fails.
 *
 * The "builder" block proves the in-process builder returns the identical
 * status/body without a req/res, which is what the Phase 1 /ops/attention
 * adapters will call (plan REVISION 2 F3: no HTTP self-calls).
 *
 * Date is frozen (only Date — real timers, so supertest still works) so the
 * body's `timestamp` and every `stuck_minutes` is deterministic. No network:
 * global.fetch is the jest mock from test/__mocks__/setup-tests.ts.
 */

import supertestBase from 'supertest';
import express from 'express';

process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';

jest.mock('../src/services/system-controls-service', () => ({ isAutopilotExecutionArmed: jest.fn() }));
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
jest.mock('../src/services/validator-core-service', () => ({ runValidation: jest.fn(), getValidatorState: jest.fn() }));
jest.mock('../src/services/autopilot-controller', () => ({
  startAutopilotRun: jest.fn(),
  getAutopilotRun: jest.fn(),
  getActiveRuns: jest.fn(),
  getSpecSnapshot: jest.fn(),
  verifySpecIntegrity: jest.fn(),
  getAutopilotStatus: jest.fn(),
}));
jest.mock('../src/services/autopilot-verification', () => ({ runVerification: jest.fn() }));
jest.mock('../src/services/autopilot-validator', () => ({ validateForMerge: jest.fn(), getValidationResult: jest.fn() }));
jest.mock('../src/services/autopilot-event-loop', () => ({
  startEventLoop: jest.fn(),
  stopEventLoop: jest.fn(),
  getEventLoopStatus: jest.fn(),
  getEventLoopHistory: jest.fn(),
  resetEventLoopCursor: jest.fn(),
}));

import { getEventLoopStatus } from '../src/services/autopilot-event-loop';
import router from '../src/routes/autopilot';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const app = express();
app.use(express.json());
app.use('/api/v1/autopilot', router);

function jsonRes(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A realistic Supabase: each query family answers with its own rows. */
function realisticSupabase(url: string) {
  if (url.includes('vtid_ledger') && url.includes('status=in.(scheduled,pending)&select=vtid&limit=500')) {
    return jsonRes(200, [{ vtid: 'VTID-1' }, { vtid: 'VTID-2' }, { vtid: 'VTID-3' }]);
  }
  if (url.includes('status=eq.in_progress&select=vtid&limit=500')) return jsonRes(200, [{ vtid: 'VTID-4' }, { vtid: 'VTID-5' }]);
  if (url.includes('status=eq.completed&select=vtid&limit=500')) return jsonRes(200, [{ vtid: 'VTID-6' }]);
  if (url.includes('status=eq.rejected&select=vtid&limit=500')) return jsonRes(200, []);
  if (url.includes('status=eq.in_progress&updated_at=lt.')) {
    return jsonRes(200, [
      { vtid: 'VTID-10', title: 'Long stall', updated_at: minsAgo(185), spec_status: 'approved' },
      { vtid: 'VTID-11', title: null, updated_at: minsAgo(75), spec_status: 'approved' },
    ]);
  }
  if (url.includes('or=(spec_status.is.null,spec_status.eq.missing)')) {
    return jsonRes(200, [{ vtid: 'VTID-20', title: 'No spec', updated_at: minsAgo(30), spec_status: null }]);
  }
  if (url.includes('spec_status=eq.validated')) {
    return jsonRes(200, [{ vtid: 'VTID-30', title: 'Ready', updated_at: minsAgo(5), spec_status: 'validated' }]);
  }
  if (url.includes('oasis_events') && url.includes('topic=in.(')) {
    return jsonRes(200, [
      { source: 'email-intake', vtid: 'VTID-40' },
      { source: 'ORB-voice', vtid: 'VTID-41' },
      { source: 'operator-console', vtid: 'VTID-42' },
      { source: 'command-hub', vtid: 'VTID-43' },
      { source: 'CommandHub', vtid: 'VTID-44' },
      { source: 'task-intake', vtid: 'VTID-45' },
      { source: null, vtid: 'VTID-46' },
    ]);
  }
  if (url.includes('autopilot_recommendations')) {
    return jsonRes(200, [{ id: 'r1', title: 'Rec', summary: 's', domain: 'd', risk_level: 'low', impact_score: 9, status: 'pending', created_at: minsAgo(60), source_type: 'scanner' }]);
  }
  if (url.includes('worker_orchestrator.heartbeat')) return jsonRes(200, [{ id: 'hb' }]);
  if (url.includes('status=eq.completed&updated_at=gt.')) return jsonRes(200, [{ vtid: 'a' }, { vtid: 'b' }, { vtid: 'c' }]);
  if (url.includes('status=in.(rejected,voided)&updated_at=gt.')) return jsonRes(200, [{ vtid: 'd' }]);
  return jsonRes(200, []);
}

type Scenario = { name: string; setup: () => void };

const SCENARIOS: Scenario[] = [
  {
    name: 'realistic data',
    setup: () => {
      (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: true, execution_armed: false });
      (global.fetch as jest.Mock).mockImplementation(async (url: string) => realisticSupabase(url));
    },
  },
  {
    name: 'every Supabase query non-ok',
    setup: () => {
      (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: false, execution_armed: true });
      (global.fetch as jest.Mock).mockImplementation(async () => jsonRes(503, { message: 'down' }));
    },
  },
  {
    name: 'every Supabase query rejects (network error)',
    setup: () => {
      (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: false, execution_armed: false });
      (global.fetch as jest.Mock).mockImplementation(async () => {
        throw new Error('ECONNREFUSED');
      });
    },
  },
  {
    name: 'event loop status throws',
    setup: () => {
      (getEventLoopStatus as jest.Mock).mockRejectedValue(new Error('loop exploded'));
      (global.fetch as jest.Mock).mockImplementation(async (url: string) => realisticSupabase(url));
    },
  },
  {
    name: 'Supabase env missing',
    setup: () => {
      delete process.env.SUPABASE_SERVICE_ROLE;
      (getEventLoopStatus as jest.Mock).mockResolvedValue({ is_running: true, execution_armed: true });
    },
  },
];

beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
      'clearInterval', 'setTimeout', 'clearTimeout',
    ],
  });
});
afterAll(() => jest.useRealTimers());

let errSpy: jest.SpyInstance;
beforeEach(() => {
  jest.setSystemTime(NOW);
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
  (global.fetch as jest.Mock).mockReset();
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => errSpy.mockRestore());

function fetchCalls() {
  return (global.fetch as jest.Mock).mock.calls.map(([url, init]) => ({ url, headers: init?.headers }));
}

describe('VTID-04875 GET /pipeline/summary — characterization (old handler == new wrapper)', () => {
  for (const sc of SCENARIOS) {
    it(`route: ${sc.name}`, async () => {
      sc.setup();
      const res = await supertestBase(app)
        .get('/api/v1/autopilot/pipeline/summary')
        .set('Authorization', 'Bearer test-service-token');
      expect({
        status: res.status,
        content_type: res.headers['content-type'],
        body_text: res.text,
        supabase_requests: fetchCalls(),
        console_error_tags: errSpy.mock.calls.map((c) => c[0]),
      }).toMatchSnapshot();
    });
  }
});

describe('VTID-04875 buildPipelineSummary() — in-process, no req/res', () => {
  for (const sc of SCENARIOS) {
    it(`builder returns exactly what the route serves: ${sc.name}`, async () => {
      sc.setup();
      const viaRoute = await supertestBase(app)
        .get('/api/v1/autopilot/pipeline/summary')
        .set('Authorization', 'Bearer test-service-token');
      const routeCalls = fetchCalls();

      (global.fetch as jest.Mock).mockClear();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildPipelineSummary } = require('../src/services/pipeline-summary-builder');
      const out = await buildPipelineSummary();

      expect(out.status).toBe(viaRoute.status);
      expect(JSON.stringify(out.body)).toBe(viaRoute.text);
      expect(fetchCalls()).toEqual(routeCalls);
    });
  }

  it('accepts injected fetch / env / loop status (no globals touched)', async () => {
    const injectedFetch = jest.fn(async (url: string) => realisticSupabase(url));
    const loop = jest.fn(async () => ({ is_running: true, execution_armed: true }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildPipelineSummary } = require('../src/services/pipeline-summary-builder');
    const out = await buildPipelineSummary({
      fetchImpl: injectedFetch,
      getEventLoopStatus: loop,
      supabaseUrl: 'http://injected:1',
      serviceRoleKey: 'injected-key',
    });
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(loop).toHaveBeenCalledTimes(1);
    expect(injectedFetch).toHaveBeenCalledTimes(13);
    expect(injectedFetch.mock.calls.every(([u]) => String(u).startsWith('http://injected:1/rest/v1/'))).toBe(true);
  });
});
