/**
 * VTID-05047: VTID-05019 gated only create-pr and safe-merge. The other
 * mutating and state-reading cicd routes now require the gateway service
 * token or an exafy_admin JWT too. GET /health stays public on purpose.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

let identity: Record<string, unknown> | null = null;
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return { ...actual, optionalAuth: (req: any, _res: any, next: () => void) => { if (identity) req.identity = identity; next(); } };
});
jest.mock('../src/services/oasis-event-service', () => {
  const ev = new Proxy({}, { get: () => jest.fn(async () => ({ ok: true })) });
  return { __esModule: true, default: ev, emitOasisEvent: jest.fn(async () => ({ ok: true })), recommendationSyncEvents: {} };
});
const ghCalls = jest.fn();
jest.mock('../src/services/github-service', () => {
  const actual = jest.requireActual('../src/services/github-service');
  const stub = new Proxy({}, { get: (_t, k) => (k in actual.default && typeof actual.default[k] !== 'function') ? actual.default[k] : jest.fn(async (...a: unknown[]) => { ghCalls(k, ...a); throw new Error('stub'); }) });
  return { __esModule: true, ...actual, default: stub };
});
const fetchMock = jest.fn(async () => { throw new Error('no network in test'); });
(global as any).fetch = fetchMock;

import cicdRouter from '../src/routes/cicd';

const app = express();
app.use(express.json());
for (const prefix of ['/api/v1/github', '/api/v1/deploy', '/api/v1/cicd']) app.use(prefix, cicdRouter);

const ROUTES: Array<['get' | 'post', string]> = [
  ['post', '/service'], ['post', '/merge'], ['post', '/deploy'], ['get', '/approvals'],
  ['post', '/approvals/12/approve'], ['post', '/approvals/12/deny'], ['post', '/autonomous-pr-merge'],
  ['get', '/lock-status'], ['post', '/lock-release'],
];
const ENV0 = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV0, GATEWAY_SERVICE_TOKEN: 'svc-token-05047' };
  identity = null;
  ghCalls.mockClear();
  fetchMock.mockClear();
});
afterAll(() => { process.env = ENV0; });

const call = (m: 'get' | 'post', url: string) => (m === 'get' ? request(app).get(url) : request(app).post(url).send({}));

describe.each(ROUTES)('%s %s', (method, route) => {
  it('no bearer → 401 on every mount, handler never reached', async () => {
    for (const prefix of ['/api/v1/github', '/api/v1/deploy', '/api/v1/cicd']) {
      expect((await call(method, `${prefix}${route}`)).status).toBe(401);
    }
    expect(ghCalls).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a wrong bearer → 401', async () => {
    expect((await call(method, `/api/v1/cicd${route}`).set('Authorization', 'Bearer not-the-token')).status).toBe(401);
  });
  it('a signed-in non-admin → 403', async () => {
    identity = { user_id: 'u1', exafy_admin: false };
    expect((await call(method, `/api/v1/cicd${route}`).set('Authorization', 'Bearer some.jwt.value')).status).toBe(403);
    expect(ghCalls).not.toHaveBeenCalled();
  });
  it('the gateway service token passes the gate', async () => {
    const r = await call(method, `/api/v1/cicd${route}`).set('Authorization', 'Bearer svc-token-05047');
    expect([401, 403]).not.toContain(r.status);
  });
  it('an exafy_admin session passes the gate', async () => {
    identity = { user_id: 'admin', exafy_admin: true };
    const r = await call(method, `/api/v1/cicd${route}`).set('Authorization', 'Bearer admin.jwt.value');
    expect([401, 403]).not.toContain(r.status);
  });
  it('no GATEWAY_SERVICE_TOKEN configured → an empty bearer cannot pass', async () => {
    delete process.env.GATEWAY_SERVICE_TOKEN;
    expect((await call(method, `/api/v1/cicd${route}`).set('Authorization', 'Bearer ')).status).toBe(401);
  });
});

describe('GET /health stays public', () => {
  it('no bearer → not 401/403', async () => {
    const r = await request(app).get('/api/v1/cicd/health');
    expect([401, 403]).not.toContain(r.status);
  });
});

describe('callers send the service token', () => {
  const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', p), 'utf8');
  const near = (s: string, marker: string, needle: string, from = 0) => {
    const i = s.indexOf(marker, from);
    expect(i).toBeGreaterThan(-1);
    return s.slice(i, i + 400).includes(needle);
  };
  it('approvals.ts and execute.ts self-calls of autonomous-pr-merge', () => {
    const a = src('services/gateway/src/routes/approvals.ts');
    const idx = [...a.matchAll(/autonomous-pr-merge`/g)].map(m => m.index!);
    expect(idx.length).toBeGreaterThanOrEqual(2);
    for (const i of idx) expect(a.slice(i, i + 400)).toContain('gatewayServiceAuthHeader()');
    expect(near(src('services/gateway/src/routes/execute.ts'), 'autonomous-pr-merge`', 'gatewayServiceAuthHeader()')).toBe(true);
  });
  it('gemini-operator: deploy/service and lock-status use the service token, not the Supabase key', () => {
    const s = src('services/gateway/src/services/gemini-operator.ts');
    for (const m of ['/api/v1/deploy/service', '/api/v1/cicd/lock-status']) {
      expect(near(s, m, 'gatewayServiceAuthHeader()')).toBe(true);
      expect(near(s, m, 'SUPABASE_SERVICE_ROLE')).toBe(false);
    }
  });
  it('ORB cicd tools: merge, lock-status, lock-release', () => {
    const s = src('services/gateway/src/services/orb-tools/cicd-pr-tools.ts');
    for (const m of ["'/api/v1/cicd/merge'", "'/api/v1/cicd/lock-status'", "'/api/v1/cicd/lock-release'"]) {
      expect(near(s, m, 'gatewayServiceAuthHeader()')).toBe(true);
    }
  });
  it('openclaw-bridge sends the token on every gateway call', () => {
    const s = src('services/openclaw-bridge/src/skills/vitana-cicd.ts');
    expect(s).not.toMatch(/path === '\//);
    expect(s).toContain('...prRouteAuth(path)');
  });
  it('every gated route is mounted behind requireServiceOrAdmin; /health is not', () => {
    const s = src('services/gateway/src/routes/cicd.ts');
    for (const [m, r] of [['post', '/service'], ['post', '/merge'], ['post', '/deploy'], ['get', '/approvals'],
      ['post', '/approvals/:id/approve'], ['post', '/approvals/:id/deny'], ['post', '/autonomous-pr-merge'],
      ['get', '/lock-status'], ['post', '/lock-release']]) {
      expect(s).toMatch(new RegExp(`router\\.${m}\\('${r.replace(/[/:]/g, c => '\\' + c)}', requireServiceOrAdmin,`));
    }
    expect(s).toMatch(/router\.get\('\/health', (async )?\(/);
  });
});
