/**
 * VTID-04875 — Overview Phase 1a: characterization of
 * GET /api/v1/admin/health/summary across the extraction of its inline
 * handler into services/health-summary-builder.ts (buildHealthSummary).
 *
 * The "route" block was written FIRST and run against the old inline
 * handler. Its snapshots record, per scenario: status, content-type, the
 * exact JSON text, and every loopback probe request (URL + headers) — so the
 * loopback self-probe ("as seen from the serving task"), the forwarded
 * Authorization header and the 30s cache/single-flight semantics provably did
 * not change. After the refactor the block is re-run with `--ci`.
 *
 * Date is frozen (only Date, real timers) so checked_at and every
 * latency_ms are deterministic. global.fetch is a jest mock — no network.
 */

import request from 'supertest';
import express from 'express';
import { SERVICE_HEALTH_REGISTRY } from '../src/constants/service-health-registry';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

function buildApp() {
  jest.resetModules();
  jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
    requireAdminAuth: (req: any, res: any, next: any) =>
      req.headers.authorization === 'Bearer admin' || req.headers.authorization === 'Bearer admin2'
        ? next()
        : res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' }),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../src/routes/admin-health');
  mod.resetHealthSummaryCacheForTests();
  const app = express();
  app.use('/api/v1/admin', mod.default);
  return { app, mod };
}

/** Deterministic, mixed probe outcomes keyed on the registry URL. */
function mixedFetch() {
  return jest.fn(async (url: string) => {
    const i = SERVICE_HEALTH_REGISTRY.findIndex((e) => url.endsWith(e.url));
    await new Promise((r) => setTimeout(r, 2));
    switch (i % 5) {
      case 0: return { status: 200, json: async () => ({ ok: true, status: 'healthy' }) };
      case 1: return { status: 503, json: async () => ({ ok: false, error: 'db down' }) };
      case 2: return { status: 401, json: async () => ({ ok: false, error: 'UNAUTHENTICATED' }) };
      case 3: return { status: 200, json: async () => { throw new Error('not json'); } };
      default: throw new Error('ECONNREFUSED');
    }
  });
}

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

const realFetch = global.fetch;
let errSpy: jest.SpyInstance;
beforeEach(() => {
  jest.setSystemTime(NOW);
  delete process.env.PORT;
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  errSpy.mockRestore();
  (global as any).fetch = realFetch;
});

const snap = (res: request.Response) => ({ status: res.status, content_type: res.headers['content-type'], body_text: res.text });
const probeCalls = () => ((global.fetch as jest.Mock).mock.calls as any[]).map(([url, init]) => ({ url, headers: init?.headers }));

describe('VTID-04875 GET /admin/health/summary — characterization (old handler == new wrapper)', () => {
  it('route: first call probes over loopback with the caller token, mixed outcomes', async () => {
    (global as any).fetch = mixedFetch();
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin');
    expect({ ...snap(res), probes: probeCalls() }).toMatchSnapshot();
  });

  it('route: PORT env overrides the loopback port; a different admin token is forwarded verbatim', async () => {
    process.env.PORT = '9191';
    (global as any).fetch = mixedFetch();
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin2');
    expect({ ...snap(res), first_probe: probeCalls()[0], probe_count: probeCalls().length }).toMatchSnapshot();
  });

  it('route: concurrent callers share one run; a later call within 30s is served from cache; after 30s re-probes', async () => {
    (global as any).fetch = mixedFetch();
    const { app } = buildApp();
    const [r1, r2] = await Promise.all([
      request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin'),
      request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin2'),
    ]);
    const afterFirst = probeCalls().length;
    jest.setSystemTime(NOW + 29_999);
    const r3 = await request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin2');
    const afterCacheHit = probeCalls().length;
    jest.setSystemTime(NOW + 30_000);
    const r4 = await request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin2');
    expect({
      r1: snap(r1),
      r2: snap(r2),
      r3: snap(r3),
      r4: snap(r4),
      probes_after_first: afterFirst,
      probes_after_cache_hit: afterCacheHit,
      probes_after_expiry: probeCalls().length,
      r4_first_probe_headers: probeCalls()[afterCacheHit]?.headers,
    }).toMatchSnapshot();
  });

  it('route: unauthenticated caller → 401, nothing probed', async () => {
    (global as any).fetch = mixedFetch();
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/admin/health/summary');
    expect({ ...snap(res), probes: probeCalls().length }).toMatchSnapshot();
  });

  it('route: a probe run that rejects → 500 summary_failed, and the next call retries', async () => {
    jest.resetModules();
    jest.doMock('../src/services/service-health-probe', () => {
      const actual = jest.requireActual('../src/services/service-health-probe');
      let n = 0;
      return {
        ...actual,
        probeAllHealthEndpoints: jest.fn(async (...a: any[]) => {
          n++;
          if (n === 1) throw new Error('probe engine down');
          return actual.probeAllHealthEndpoints(...a);
        }),
      };
    });
    (global as any).fetch = mixedFetch();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      requireAdminAuth: (_req: any, _res: any, next: any) => next(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../src/routes/admin-health');
    mod.resetHealthSummaryCacheForTests();
    const app = express();
    app.use('/api/v1/admin', mod.default);
    const r1 = await request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin');
    const r2 = await request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin');
    expect({
      r1: snap(r1),
      r2_status: r2.status,
      r2_cached: r2.body.cached,
      console_error: errSpy.mock.calls.map((c) => [c[0], String(c[1])]),
    }).toMatchSnapshot();
    jest.dontMock('../src/services/service-health-probe');
  });
});

describe('VTID-04875 buildHealthSummary() — in-process, no req/res', () => {
  it('returns exactly what the route serves and shares the route cache', async () => {
    (global as any).fetch = mixedFetch();
    const { app } = buildApp();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildHealthSummary } = require('../src/services/health-summary-builder');
    const direct = await buildHealthSummary({ authHeader: 'Bearer admin' });
    expect(direct.cached).toBe(false);
    const calls = probeCalls();
    expect(calls).toHaveLength(SERVICE_HEALTH_REGISTRY.length);
    expect(calls[0].url).toBe(`http://127.0.0.1:8080${SERVICE_HEALTH_REGISTRY[0].url}`);
    expect(calls[0].headers.Authorization).toBe('Bearer admin');

    const viaRoute = await request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin');
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.text).toBe(JSON.stringify({ ...direct, cached: true }));
    expect(probeCalls()).toHaveLength(SERVICE_HEALTH_REGISTRY.length); // served from the shared cache
  });

  it('without authHeader probes with no Authorization header', async () => {
    (global as any).fetch = mixedFetch();
    buildApp();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildHealthSummary } = require('../src/services/health-summary-builder');
    await buildHealthSummary();
    expect(probeCalls()[0].headers).toEqual({ Accept: 'application/json' });
  });

  it('`now` decides cache freshness: within 30s cached, at 30s re-probed', async () => {
    (global as any).fetch = mixedFetch();
    buildApp();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildHealthSummary } = require('../src/services/health-summary-builder');
    await buildHealthSummary({ authHeader: 'Bearer admin' });
    const n = probeCalls().length;
    expect((await buildHealthSummary({ now: NOW + 29_999 })).cached).toBe(true);
    expect(probeCalls()).toHaveLength(n);
    expect((await buildHealthSummary({ now: NOW + 30_000 })).cached).toBe(false);
    expect(probeCalls()).toHaveLength(2 * n);
  });

  it('the route module still exports resetHealthSummaryCacheForTests and it clears the builder cache', async () => {
    (global as any).fetch = mixedFetch();
    const { mod } = buildApp();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildHealthSummary } = require('../src/services/health-summary-builder');
    await buildHealthSummary();
    mod.resetHealthSummaryCacheForTests();
    expect((await buildHealthSummary()).cached).toBe(false);
  });
});
