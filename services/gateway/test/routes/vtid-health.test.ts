// VTID-03964 — GET /api/v1/vtid/health regression tests.
//
// This route's two Supabase fetches (ledger read + next_vtid RPC probe) had
// no timeout and ran sequentially. Live staging measurement (during the
// VTID-03954 investigation into the Command Hub Service Health panel
// flapping other checks) caught this route taking as long as 14.7s on a
// single request — far past the panel's own 6s per-check client-side
// timeout. Fixed by bounding each fetch with its own independent
// AbortController and running them concurrently instead of sequentially.

import supertestBase from 'supertest';
import express from 'express';
import { vtidRouter as router } from '../../src/routes/vtid';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/vtid', router);
  return app;
}
const app = buildApp();

function jsonRes(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  (global.fetch as jest.Mock).mockReset();
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
});

describe('GET /health', () => {
  it('reports healthy when both checks succeed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonRes(200, []));

    const res = await supertestBase(app).get('/api/v1/vtid/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.ledger_read.ok).toBe(true);
    expect(res.body.checks.vtid_generator.ok).toBe(true);
  });

  it('gives each of the two fetches its own independent AbortSignal', async () => {
    const signals: AbortSignal[] = [];
    (global.fetch as jest.Mock).mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal) signals.push(init.signal);
      return Promise.resolve(jsonRes(200, []));
    });

    await supertestBase(app).get('/api/v1/vtid/health');

    expect(signals.length).toBe(2);
    expect(new Set(signals).size).toBe(2); // no two calls share the same AbortSignal instance
  });

  it('runs the two checks concurrently, not sequentially', async () => {
    // Asserted structurally (both fetches in flight at once), not by wall
    // clock: a 40 ms delay with a 1.8x threshold left 32 ms of margin for
    // supertest + CI load, and failed at 76 ms on a loaded runner.
    let inFlight = 0;
    let maxInFlight = 0;
    (global.fetch as jest.Mock).mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => setTimeout(() => { inFlight--; resolve(jsonRes(200, [])); }, 20));
    });

    await supertestBase(app).get('/api/v1/vtid/health');

    // Sequential would never have more than one fetch outstanding.
    expect(maxInFlight).toBe(2);
  });

  it('bounds a hanging fetch instead of hanging the route past its timeout budget', async () => {
    (global.fetch as jest.Mock).mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const res = await supertestBase(app).get('/api/v1/vtid/health');

    // Resolved (degraded, not hung) — this is the regression this test
    // guards: without the abort signals wired up, this would hang until the
    // surrounding jest test timeout instead of ever settling.
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.checks.ledger_read.ok).toBe(false);
    expect(res.body.checks.vtid_generator.ok).toBe(false);
  }, 10_000);

  it('degrades to 503 (not a thrown 500) when Supabase env vars are missing', async () => {
    delete process.env.SUPABASE_URL;

    const res = await supertestBase(app).get('/api/v1/vtid/health');

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});
