/**
 * VTID-05019: POST /create-pr and /safe-merge (cicd router, mounted at
 * /api/v1/github, /api/v1/deploy and /api/v1/cicd) shipped with no auth, so
 * anyone reaching the gateway could open or merge PRs with the gateway's own
 * GitHub tokens. They now require the gateway service token or an exafy_admin
 * JWT (requireServiceOrAdmin). Every in-repo caller sends the service token.
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
const gh = {
  createPullRequest: jest.fn(async () => ({ number: 7, html_url: 'https://x/7' })),
  getPrStatus: jest.fn(async () => ({ pr: { state: 'open', base: { ref: 'main' }, head: { ref: 'b' }, title: 'VTID-05019: x' }, checks: [], allPassed: true })),
  evaluateGovernance: jest.fn(async () => ({ decision: 'approved', files_touched: [], services_impacted: [], blocked_reasons: [] })),
  mergePullRequest: jest.fn(async () => ({ sha: 'm', merged: true, message: 'ok' })),
  detectServiceFromFiles: jest.fn(() => null),
};
jest.mock('../src/services/github-service', () => {
  const actual = jest.requireActual('../src/services/github-service');
  return { __esModule: true, ...actual, default: { ...actual.default, ...gh } };
});

import cicdRouter from '../src/routes/cicd';
import { gatewayServiceAuthHeader } from '../src/middleware/require-service-or-admin';

const app = express();
app.use(express.json());
for (const prefix of ['/api/v1/github', '/api/v1/deploy', '/api/v1/cicd']) app.use(prefix, cicdRouter);

const PR = { vtid: 'VTID-05019', title: 'VTID-05019: x', body: 'b', head: 'kiro/abc/x' };
const MERGE = { vtid: 'VTID-05019', pr_number: 7 };
const ENV0 = { ...process.env };

beforeEach(() => {
  process.env = { ...ENV0, GATEWAY_SERVICE_TOKEN: 'svc-token-test' };
  identity = null;
  for (const f of Object.values(gh)) (f as jest.Mock).mockClear();
});
afterAll(() => { process.env = ENV0; });

describe.each([
  ['create-pr', PR, () => gh.createPullRequest],
  ['safe-merge', MERGE, () => gh.mergePullRequest],
] as const)('POST /%s', (route, body, sideEffect) => {
  it('no bearer → 401, nothing done', async () => {
    const r = await request(app).post(`/api/v1/github/${route}`).send(body);
    expect(r.status).toBe(401);
    expect(sideEffect()).not.toHaveBeenCalled();
  });
  it('a wrong bearer → 401 (an empty body is never validated first)', async () => {
    const r = await request(app).post(`/api/v1/github/${route}`).set('Authorization', 'Bearer not-the-token').send({});
    expect(r.status).toBe(401);
  });
  it('a signed-in non-admin → 403', async () => {
    identity = { user_id: 'u1', exafy_admin: false };
    const r = await request(app).post(`/api/v1/github/${route}`).set('Authorization', 'Bearer some.jwt.value').send(body);
    expect(r.status).toBe(403);
    expect(sideEffect()).not.toHaveBeenCalled();
  });
  it('the gateway service token → the handler runs', async () => {
    const r = await request(app).post(`/api/v1/github/${route}`).set('Authorization', 'Bearer svc-token-test').send(body);
    expect([200, 201]).toContain(r.status);
    expect(sideEffect()).toHaveBeenCalledTimes(1);
  });
  it('an exafy_admin session → the handler runs', async () => {
    identity = { user_id: 'admin', exafy_admin: true };
    const r = await request(app).post(`/api/v1/github/${route}`).set('Authorization', 'Bearer admin.jwt.value').send(body);
    expect([200, 201]).toContain(r.status);
  });
  it('the same gate on the other mount prefixes', async () => {
    for (const prefix of ['/api/v1/deploy', '/api/v1/cicd']) {
      expect((await request(app).post(`${prefix}/${route}`).send(body)).status).toBe(401);
    }
  });
  it('no GATEWAY_SERVICE_TOKEN configured: even a bearer equal to "" cannot pass', async () => {
    delete process.env.GATEWAY_SERVICE_TOKEN;
    expect((await request(app).post(`/api/v1/github/${route}`).set('Authorization', 'Bearer ').send(body)).status).toBe(401);
  });
});

describe('callers send the service token', () => {
  it('gatewayServiceAuthHeader: bearer when set, nothing when unset', () => {
    expect(gatewayServiceAuthHeader({ GATEWAY_SERVICE_TOKEN: 't' } as any)).toEqual({ Authorization: 'Bearer t' });
    expect(gatewayServiceAuthHeader({} as any)).toEqual({});
  });

  const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', p), 'utf8');
  const near = (s: string, marker: string, needle: string) => {
    const i = s.indexOf(marker);
    expect(i).toBeGreaterThan(-1);
    return s.slice(i, i + 400).includes(needle);
  };

  it('Operator / Kiro executors (and no Supabase key on the self-call)', () => {
    const s = src('services/gateway/src/services/gemini-operator.ts');
    for (const m of ['/api/v1/github/create-pr', '/api/v1/github/safe-merge']) {
      expect(near(s, m, 'gatewayServiceAuthHeader()')).toBe(true);
      expect(near(s, m, 'apikey: SUPABASE_SERVICE_ROLE')).toBe(false);
    }
  });
  it('autopilot event loop, ORB developer tools, openclaw-bridge', () => {
    expect(near(src('services/gateway/src/services/autopilot-event-loop.ts'), '/api/v1/cicd/safe-merge', 'gatewayServiceAuthHeader()')).toBe(true);
    const orb = src('services/gateway/src/services/orb-tools/cicd-pr-tools.ts');
    expect(near(orb, "gatewayApiCall('/api/v1/github/create-pr'", 'gatewayServiceAuthHeader()')).toBe(true);
    expect(near(orb, "gatewayApiCall('/api/v1/github/safe-merge'", 'gatewayServiceAuthHeader()')).toBe(true);
    const oc = src('services/openclaw-bridge/src/skills/vitana-cicd.ts');
    // VTID-05047: prRouteAuth now sends the token on every gateway call (no path allowlist).
    expect(oc).toMatch(/return t \? \{ Authorization: `Bearer \$\{t\}` \} : \{\};/);
    expect(oc).toContain('...prRouteAuth(path)');
  });
  it('both routes are mounted behind requireServiceOrAdmin', () => {
    const s = src('services/gateway/src/routes/cicd.ts');
    expect(s).toContain("router.post('/create-pr', requireServiceOrAdmin,");
    expect(s).toContain("router.post('/safe-merge', requireServiceOrAdmin,");
  });
});
