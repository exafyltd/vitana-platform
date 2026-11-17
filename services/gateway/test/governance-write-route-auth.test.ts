/**
 * Governance write-route authentication (strategy MR !8 follow-up, live exposure B3 / SB-CON-22).
 *
 * Before this change eight write routes in four routers accepted anonymous requests from the
 * public internet: specs generate/PATCH/validate/quality-check, triage investigate, ai-personality
 * PUT and reset, and llm routing-policy POST and reset. Each must now refuse a missing or wrong
 * bearer and must pass the guard with the gateway service token or an exafy_admin session.
 *
 * Also pins two caller rules: internal callers present the gateway service token (never the
 * Supabase service key), and the routing-policy audit actor comes from the verified guard identity,
 * never from the spoofable x-actor-role / x-actor-id headers.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

let identity: Record<string, unknown> | null = null;
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    optionalAuth: (req: any, _res: any, next: () => void) => { if (identity) req.identity = identity; next(); },
    requireAdminAuth: (req: any, res: any, next: () => void) => {
      if (identity && identity.exafy_admin) { req.identity = identity; return next(); }
      return res.status(identity ? 403 : 401).json({ ok: false, error: 'admin required' });
    },
  };
});
jest.mock('../src/services/oasis-event-service', () => {
  const ev = new Proxy({}, { get: () => jest.fn(async () => ({ ok: true })) });
  return { __esModule: true, default: ev, emitOasisEvent: jest.fn(async () => ({ ok: true })), recommendationSyncEvents: {} };
});
const reached = jest.fn();
const fetchMock = jest.fn(async () => { throw new Error('no network in test'); });
(global as any).fetch = fetchMock;

// Handler reached = the guard passed. Routes may then fail for lack of a database; the test only
// asserts the guard decision, so every mocked service throws and the route answers 5xx.
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));

type Mount = { prefix: string; router: express.Router; routes: Array<['get' | 'post' | 'put' | 'patch', string]> };

const specsRouter = require('../src/routes/specs').specsRouter as express.Router;
const triageAgentRouter = require('../src/routes/triage-agent').triageAgentRouter as express.Router;
const aiPersonalityRouter = require('../src/routes/ai-personality').default as express.Router;
const llmRouter = require('../src/routes/llm').default as express.Router;

const MOUNTS: Mount[] = [
  { prefix: '/api/v1/specs', router: specsRouter, routes: [['post', '/VTID-00001/generate'], ['patch', '/VTID-00001'], ['post', '/VTID-00001/validate'], ['post', '/VTID-00001/quality-check']] },
  { prefix: '/api/v1/agents/triage', router: triageAgentRouter, routes: [['post', '/investigate']] },
  { prefix: '/api/v1/ai-personality', router: aiPersonalityRouter, routes: [['put', '/general'], ['post', '/general/reset']] },
  { prefix: '/api/v1/llm', router: llmRouter, routes: [['post', '/routing-policy'], ['post', '/routing-policy/reset']] },
];

const app = express();
app.use(express.json());
for (const m of MOUNTS) app.use(m.prefix, m.router);

const ENV0 = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV0, GATEWAY_SERVICE_TOKEN: 'svc-token-governance' };
  identity = null;
  reached.mockClear();
  fetchMock.mockClear();
});
afterAll(() => { process.env = ENV0; });

const cases = MOUNTS.flatMap((m) => m.routes.map(([verb, route]) => ({ url: `${m.prefix}${route}`, verb })));
const call = (verb: string, url: string) => (request(app) as any)[verb](url).send({ reason: 'test', config: {}, policy: {} });

describe.each(cases)('$verb $url', ({ verb, url }) => {
  it('no bearer → 401', async () => {
    expect((await call(verb, url)).status).toBe(401);
  });
  it('wrong bearer → 401', async () => {
    expect((await call(verb, url).set('Authorization', 'Bearer not-the-token'))).toMatchObject({ status: 401 });
  });
  it('signed-in non-admin JWT → 403', async () => {
    identity = { user_id: 'u1', exafy_admin: false };
    expect((await call(verb, url).set('Authorization', 'Bearer some.jwt')).status).toBe(403);
  });
  it('gateway service token passes the guard (not 401/403)', async () => {
    const r = await call(verb, url).set('Authorization', 'Bearer svc-token-governance');
    expect([401, 403]).not.toContain(r.status);
  });
  it('exafy_admin session passes the guard (not 401/403)', async () => {
    identity = { user_id: 'admin-1', exafy_admin: true };
    const r = await call(verb, url).set('Authorization', 'Bearer admin.jwt');
    expect([401, 403]).not.toContain(r.status);
  });
  it('no GATEWAY_SERVICE_TOKEN configured → an empty bearer cannot pass', async () => {
    delete process.env.GATEWAY_SERVICE_TOKEN;
    expect((await call(verb, url).set('Authorization', 'Bearer ')).status).toBe(401);
  });
});

describe('caller and audit-actor rules (static)', () => {
  const SRC = path.join(__dirname, '..', 'src');
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

  it.each([
    'services/operator-planner.ts',
    'services/gemini-operator.ts',
    'services/task-intake-service.ts',
    'routes/email-intake.ts',
  ])('%s: calls to /api/v1/specs send the gateway token, not the Supabase service key', (rel) => {
    const src = read(rel);
    const specsCalls = src.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => /\/api\/v1\/specs\//.test(l));
    expect(specsCalls.length).toBeGreaterThan(0);
    for (const { i } of specsCalls) {
      const window = src.split('\n').slice(i, i + 8).join('\n');
      expect(window).not.toMatch(/Bearer \$\{SUPABASE_SERVICE_ROLE/);
    }
    expect(src).toMatch(/gatewayServiceAuthHeader/);
  });

  it('llm routing-policy takes its actor from the verified guard identity, not headers', () => {
    const src = read('routes/llm.ts');
    expect(src).not.toMatch(/req\.headers\['x-actor-role'\]/);
    expect(src).not.toMatch(/req\.headers\['x-actor-id'\]/);
    expect(src.match(/getControlPlaneActor\(req\)/g)?.length).toBe(2);
  });

  it('command hub: ai-personality and routing-policy saves send the admin session headers', () => {
    const app = fs.readFileSync(path.join(SRC, 'frontend', 'command-hub', 'app.js'), 'utf8');
    expect(app).not.toMatch(/'x-actor-role': 'developer'/);
    expect(app).toMatch(/fetch\('\/api\/v1\/ai-personality\/' \+ surfaceKey, \{[\s\S]{0,200}buildContextHeaders/);
    expect(app).toMatch(/fetch\('\/api\/v1\/ai-personality\/' \+ surfaceKey \+ '\/reset', \{[\s\S]{0,200}buildContextHeaders/);
    expect(app).toMatch(/fetch\('\/api\/v1\/llm\/routing-policy\?environment=DEV', \{[\s\S]{0,200}buildContextHeaders/);
  });
});

describe('production publish stays human-only (IF-THEN 22, DEC-058)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'operator.ts'), 'utf8');
  it('POST /publish is guarded by requireAdminAuth (exafy_admin session), never by the service token', () => {
    expect(src).toMatch(/router\.post\('\/publish', requireAdminAuth,/);
    expect(src).not.toMatch(/router\.post\('\/publish', requireServiceOrAdmin/);
  });
});
