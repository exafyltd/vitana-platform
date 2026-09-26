/**
 * VTID-04661 — Service Health panel, Phase 0.
 *
 *  1. The panel drew only seven hardcoded groups, so 'Screen Load Time'
 *     ('Frontend & Performance') was counted in "54/55" but never shown.
 *  2. A 2xx `{ ok: false }` read as healthy; 401/403 read as degraded.
 *  3. Every check was probed from the browser; the gateway now serves one
 *     cached summary (GET /api/v1/admin/health/summary).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'vm';
import request from 'supertest';
import express from 'express';

import {
  SERVICE_HEALTH_REGISTRY,
  SERVICE_HEALTH_GROUPS,
} from '../src/constants/service-health-registry';
import { classifyHealthResponse, probeAllHealthEndpoints, summarize } from '../src/services/service-health-probe';

const APP_JS = readFileSync(join(__dirname, '../src/frontend/command-hub/app.js'), 'utf8');

/** Pull a top-level `var X = ...;` or `function X(...) {...}` out of app.js. */
function extract(name: string, kind: 'var' | 'function'): string {
  if (kind === 'var') {
    const start = APP_JS.indexOf(`var ${name} =`);
    if (start < 0) throw new Error(`var ${name} not found`);
    const end = APP_JS.indexOf('];', start);
    return APP_JS.slice(start, end + 2);
  }
  const m = APP_JS.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

function loadBrowserHelpers(): any {
  const src = [
    extract('FALLBACK_HEALTH_GROUPS', 'var'),
    extract('HEALTHY_PROBE_STATUSES', 'var'),
    extract('KNOWN_BAD_PROBE_STATUSES', 'var'),
    extract('FALLBACK_HEALTH_ENDPOINTS', 'var'),
    extract('orderedHealthGroups', 'function'),
    extract('classifyHealthProbe', 'function'),
    extract('serviceHealthCounts', 'function'),
    extract('serviceHealthDot', 'function'),
  ].join('\n');
  const ctx: any = {};
  vm.createContext(ctx);
  vm.runInContext(
    src +
      '\nthis.out = { FALLBACK_HEALTH_GROUPS, FALLBACK_HEALTH_ENDPOINTS, orderedHealthGroups, classifyHealthProbe, serviceHealthCounts, serviceHealthDot };',
    ctx,
  );
  return ctx.out;
}

const CASES: Array<[number | null, unknown, string, boolean]> = [
  [null, null, 'down', false],
  [200, { ok: true }, 'healthy', true],
  [200, null, 'healthy', true],
  [200, { status: 'ok' }, 'ok', true],
  [200, { status: 'healthy' }, 'healthy', true],
  [200, { status: 'ok_governance_limited' }, 'ok_governance_limited', true],
  [200, { status: 'down', reason: 'no_recent_runs' }, 'down', false],
  [200, { status: 'degraded' }, 'degraded', false],
  [200, { ok: false }, 'down', false],
  [200, { ok: false, error: 'x' }, 'down', false],
  [401, { ok: false }, 'no_access', false],
  [403, null, 'no_access', false],
  [404, null, 'down', false],
  [500, { ok: false }, 'down', false],
  [503, { status: 'degraded' }, 'degraded', false],
  [503, { status: 'healthy' }, 'down', false],
];

describe('classifyHealthResponse (server)', () => {
  it.each(CASES)('HTTP %s %j -> %s', (code, body, status, healthy) => {
    expect(classifyHealthResponse(code, body)).toEqual({ status, healthy });
  });
});

describe('classifyHealthProbe (browser copy) matches the server', () => {
  const b = loadBrowserHelpers();
  it.each(CASES)('HTTP %s %j -> %s', (code, body, status, healthy) => {
    expect(JSON.parse(JSON.stringify(b.classifyHealthProbe(code, body)))).toEqual({ status, healthy });
  });
});

describe('every check is drawn', () => {
  const b = loadBrowserHelpers();

  it('orderedHealthGroups never drops a group and keeps registry order first', () => {
    const items = [
      { group: 'Visual & VTID' },
      { group: 'Brand New Group' },
      { group: 'Core Infrastructure' },
      { group: 'Frontend & Performance' },
      {},
    ];
    const out = [...b.orderedHealthGroups(items, SERVICE_HEALTH_GROUPS)];
    expect(out).toEqual(['Core Infrastructure', 'Visual & VTID', 'Frontend & Performance', 'Brand New Group', 'Other']);
  });

  it('every group in the registry is drawn by the panel', () => {
    const out = [...b.orderedHealthGroups(SERVICE_HEALTH_REGISTRY, SERVICE_HEALTH_GROUPS)];
    const groups = new Set(SERVICE_HEALTH_REGISTRY.map((e) => e.group));
    for (const g of groups) expect(out).toContain(g);
    expect(out).toContain('Frontend & Performance');
  });

  it('every registry group is listed in SERVICE_HEALTH_GROUPS', () => {
    for (const e of SERVICE_HEALTH_REGISTRY) expect(SERVICE_HEALTH_GROUPS).toContain(e.group);
  });

  it('the browser fallback lists match the registry', () => {
    expect([...b.FALLBACK_HEALTH_GROUPS]).toEqual(SERVICE_HEALTH_GROUPS);
    const fb = b.FALLBACK_HEALTH_ENDPOINTS.map((e: any) => `${e.name}|${e.url}|${e.group}`).sort();
    const reg = SERVICE_HEALTH_REGISTRY.map((e) => `${e.name}|${e.url}|${e.group}`).sort();
    expect(fb).toEqual(reg);
  });

  it('the popup and the overview no longer carry a hardcoded group list', () => {
    expect(APP_JS).not.toMatch(/var groupOrder = \[/);
    expect(APP_JS.match(/orderedHealthGroups\(/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('no_access is grey and not counted as down', () => {
    const items = [
      { healthy: true, status: 'ok' },
      { healthy: false, status: 'no_access' },
      { healthy: false, status: 'down' },
      { healthy: false, status: 'degraded' },
    ];
    expect(JSON.parse(JSON.stringify(b.serviceHealthCounts(items)))).toEqual({ total: 4, healthy: 1, noAccess: 1, failing: 2 });
    expect(items.map((i) => b.serviceHealthDot(i))).toEqual(['green', 'grey', 'red', 'yellow']);
  });

  it('the yellow and grey dots have styles', () => {
    const css = readFileSync(join(__dirname, '../src/frontend/command-hub/styles.css'), 'utf8');
    expect(css).toMatch(/\.health-dot-yellow\s*\{/);
    expect(css).toMatch(/\.health-dot-grey\s*\{/);
  });

  it('fetchServiceHealth prefers the server summary and falls back to browser probing', () => {
    const m = APP_JS.match(/async function fetchServiceHealth\([^)]*\) \{[\s\S]*?\n\}/)!;
    const body = m[0];
    const iSummary = body.indexOf('/api/v1/admin/health/summary');
    const iRegistry = body.indexOf('/api/v1/admin/health-registry');
    expect(iSummary).toBeGreaterThan(-1);
    expect(iRegistry).toBeGreaterThan(iSummary);
    expect(body).toMatch(/probeHealthEndpointInBrowser/);
  });
});

describe('probeAllHealthEndpoints', () => {
  it('classifies each response, times out to down, and caps huge details', async () => {
    const big = { status: 'ok', blob: 'x'.repeat(20000) };
    const fetchImpl: any = jest.fn(async (url: string) => {
      if (url.endsWith('/a')) return { status: 200, json: async () => ({ ok: false }) };
      if (url.endsWith('/b')) return { status: 401, json: async () => ({}) };
      if (url.endsWith('/c')) return { status: 200, json: async () => big };
      throw new Error('ECONNREFUSED');
    });
    const out = await probeAllHealthEndpoints(
      [
        { name: 'A', url: '/a', group: 'G' },
        { name: 'B', url: '/b', group: 'G' },
        { name: 'C', url: '/c', group: 'G' },
        { name: 'D', url: '/d', group: 'G' },
      ],
      { baseUrl: 'http://x', fetchImpl, headers: { Authorization: 'Bearer t' } },
    );
    expect(out.map((o) => o.status)).toEqual(['down', 'no_access', 'ok', 'down']);
    expect(out[2].details).toEqual({ truncated: true, bytes: expect.any(Number) });
    expect(out[3].latency_ms).toBe(-1);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer t');
    const s = summarize(out, ['G'], 'now');
    expect(s).toMatchObject({ total: 4, healthy: 1, failing: 2, no_access: 1 });
  });
});

describe('GET /api/v1/admin/health/summary', () => {
  const realFetch = global.fetch;
  let calls = 0;

  function buildApp() {
    jest.resetModules();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      requireAdminAuth: (req: any, res: any, next: any) =>
        req.headers.authorization === 'Bearer admin'
          ? next()
          : res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../src/routes/admin-health');
    mod.resetHealthSummaryCacheForTests();
    const app = express();
    app.use('/api/v1/admin', mod.default);
    return app;
  }

  beforeEach(() => {
    calls = 0;
    (global as any).fetch = jest.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { status: 200, json: async () => ({ ok: true }) };
    });
  });
  afterAll(() => {
    (global as any).fetch = realFetch;
  });

  it('refuses a caller that is not an admin, without probing anything', async () => {
    const res = await request(buildApp()).get('/api/v1/admin/health/summary');
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  it('probes every registry entry once, forwards the token, and serves the cache after', async () => {
    const app = buildApp();
    const [r1, r2] = await Promise.all([
      request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin'),
      request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin'),
    ]);
    expect(r1.status).toBe(200);
    expect(r1.body.total).toBe(SERVICE_HEALTH_REGISTRY.length);
    expect(r1.body.groups).toEqual(SERVICE_HEALTH_GROUPS);
    expect(r1.body.items[0]).toMatchObject({ name: 'Gateway', status: 'healthy', healthy: true });
    expect(r2.body.total).toBe(SERVICE_HEALTH_REGISTRY.length);
    expect(calls).toBe(SERVICE_HEALTH_REGISTRY.length); // concurrent callers shared one run
    const firstCall = (global.fetch as jest.Mock).mock.calls[0];
    expect(firstCall[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/health$/);
    expect(firstCall[1].headers.Authorization).toBe('Bearer admin');

    const r3 = await request(app).get('/api/v1/admin/health/summary').set('Authorization', 'Bearer admin');
    expect(r3.body.cached).toBe(true);
    expect(calls).toBe(SERVICE_HEALTH_REGISTRY.length);
  });

  it('the registry route now also serves the group order', async () => {
    const res = await request(buildApp()).get('/api/v1/admin/health-registry');
    expect(res.body.groups).toEqual(SERVICE_HEALTH_GROUPS);
  });
});
