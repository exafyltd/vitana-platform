/**
 * Canary target tests — PR-I (VTID-02949).
 *
 * Pre-created scaffold so PR-H's test-path derivation sees an existing
 * file (`existing: true` → `modify` verb). The autopilot LLM extends
 * THIS file with the assertion that proves its repair works (catching
 * CanaryArmedFault specifically and returning the degraded shape).
 *
 * Repair contract the LLM must satisfy:
 *   - Catch CanaryArmedFault specifically — NOT generic Error.
 *   - Return 200 with `{ ok: true, degraded: true, fault_class: 'CANARY_ARMED', ... }`
 *   - The `armed` operator flag stays the source of truth; only the
 *     500 → 200 transition changes.
 *
 * Baseline assertion below (disarmed path) MUST keep passing after the
 * repair lands.
 */

// Mock the live Supabase fetch the route uses to read system_config —
// keeps tests hermetic without overriding the route module itself.
import express from 'express';
import request from 'supertest';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true })
}));

const ORIGINAL_FETCH = global.fetch;

// Reload the route module fresh between tests so the in-module armed-state
// cache (5s TTL) doesn't leak armed/disarmed values across cases.
function freshRouter(): any {
  jest.resetModules();
  return require('../src/routes/canary-target').default;
}

function buildApp(router: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/canary-target', router);
  // Default error handler for tests: surface the thrown error as 500
  // with a JSON body so we can assert on shape if needed.
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ ok: false, error: err?.message, name: err?.name, code: err?.code });
  });
  return app;
}

function mockSupabaseConfig(armedValue: boolean) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/rest/v1/system_config') && url.includes('self_healing_canary_armed')) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ value: armedValue }]),
      };
    }
    return { ok: true, status: 200, json: () => Promise.resolve([]) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
  // Bust the route's 5-second cache between tests by jumping the clock.
  jest.useFakeTimers({ now: Date.now() + 60_000 });
  jest.useRealTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('canary-target — baseline (must keep passing after repair)', () => {
  it('disarmed → /health returns 200 with armed=false', async () => {
    mockSupabaseConfig(false);
    const res = await request(buildApp(freshRouter())).get('/api/v1/canary-target/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, armed: false });
  });

  it('disarmed → /status returns armed=false', async () => {
    mockSupabaseConfig(false);
    const res = await request(buildApp(freshRouter())).get('/api/v1/canary-target/status');
    expect(res.status).toBe(200);
    expect(res.body.armed).toBe(false);
    expect(res.body.config_key).toBe('self_healing_canary_armed');
  });
});

describe('canary-target — armed fault (current behavior; SELF-HEALING REPAIR TARGET)', () => {
  // PR-I (VTID-02949): the deliberate fault. The autopilot LLM should
  // ADD a test below this `describe` block that asserts the degraded
  // shape after the repair is applied. The LLM should NOT remove this
  // describe block — it documents the pre-repair behavior.
  it.skip('armed → /health throws CanaryArmedFault (handled as 500 by Express)', async () => {
    mockSupabaseConfig(true);
    const res = await request(buildApp(freshRouter())).get('/api/v1/canary-target/health');
    expect(res.status).toBe(500);
    expect(res.body.name).toBe('CanaryArmedFault');
    expect(res.body.code).toBe('CANARY_ARMED');
  });
});

describe('canary-target — armed fault (repaired behavior)', () => {
  it('armed → /health catches CanaryArmedFault and returns 200 with degraded state', async () => {
    mockSupabaseConfig(true);
    const res = await request(buildApp(freshRouter())).get('/api/v1/canary-target/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      degraded: true,
      fault_class: 'CANARY_ARMED',
      remediation: 'Canary armed fault handled gracefully.'
    });

    const { emitOasisEvent } = require('../src/services/oasis-event-service');
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'self-healing.fix.applied',
      vtid: 'VTID-02951'
    }));
  });
});