/**
 * VTID-04727 — the VTID ledger's write routes require the gateway service
 * token or an exafy_admin JWT.
 *
 * Before this, POST/PATCH/DELETE /api/v1/oasis/tasks…, the completion route,
 * and POST /api/v1/vtid/allocate|create accepted anonymous requests from the
 * public internet. These tests pin the gate in all three rollout modes, that
 * every write route carries it, that the read routes do not, and that every
 * in-repo caller of those routes sends credentials.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import * as yaml from 'js-yaml';

let optionalAuthImpl: (req: any, res: any, next: () => void) => unknown = (_req, _res, next) => next();
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (req: any, res: any, next: () => void) => optionalAuthImpl(req, res, next),
}));

import {
  requireLedgerWriteAuth,
  resolveLedgerWriteAuthMode,
  getLedgerWriteActor,
  serviceAuthHeaders,
} from '../src/middleware/ledger-write-auth';

const REPO = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

function mockReq(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    method: 'POST',
    originalUrl: '/api/v1/oasis/tasks/VTID-00001/complete',
    headers: lower,
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

function mockRes(): Response & { _status: number | null; _json: any } {
  const res: any = { _status: null, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (body: any) => { res._json = body; return res; };
  return res;
}

/** Runs the middleware and resolves once it has either called next() or responded. */
function run(req: Request, res: ReturnType<typeof mockRes>): Promise<boolean> {
  return new Promise((resolve) => {
    const origJson = res.json;
    res.json = (body: any) => { origJson(body); resolve(false); return res; };
    requireLedgerWriteAuth(req, res, (() => resolve(true)) as NextFunction);
  });
}

describe('VTID-04727 ledger write auth', () => {
  const ENV = { ...process.env };
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    optionalAuthImpl = (_req, _res, next) => next();
    process.env.GATEWAY_SERVICE_TOKEN = 'svc-token';
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...ENV };
    warn.mockRestore();
    error.mockRestore();
  });

  describe('mode resolution', () => {
    it('defaults to log, and only exact enforce/off select the others', () => {
      expect(resolveLedgerWriteAuthMode(undefined)).toBe('log');
      expect(resolveLedgerWriteAuthMode('')).toBe('log');
      expect(resolveLedgerWriteAuthMode('enforced')).toBe('log');
      expect(resolveLedgerWriteAuthMode('ENFORCE')).toBe('enforce');
      expect(resolveLedgerWriteAuthMode(' off ')).toBe('off');
    });
  });

  describe('enforce', () => {
    beforeEach(() => { process.env.LEDGER_WRITE_AUTH_MODE = 'enforce'; });

    it('rejects an anonymous request with 401 and does not call next', async () => {
      const res = mockRes();
      expect(await run(mockReq(), res)).toBe(false);
      expect(res._status).toBe(401);
    });

    it('rejects a wrong bearer that is not a valid JWT with 401', async () => {
      const res = mockRes();
      expect(await run(mockReq({ Authorization: 'Bearer nope' }), res)).toBe(false);
      expect(res._status).toBe(401);
    });

    it('rejects a valid non-admin JWT with 403', async () => {
      optionalAuthImpl = (req, _res, next) => { req.identity = { user_id: 'u1', exafy_admin: false }; next(); };
      const res = mockRes();
      expect(await run(mockReq({ Authorization: 'Bearer user-jwt' }), res)).toBe(false);
      expect(res._status).toBe(403);
    });

    it('accepts the service token and records the actor without JWT validation', async () => {
      let jwtTouched = false;
      optionalAuthImpl = (_req, _res, next) => { jwtTouched = true; next(); };
      const req = mockReq({ Authorization: 'Bearer svc-token' });
      expect(await run(req, mockRes())).toBe(true);
      expect(jwtTouched).toBe(false);
      expect(getLedgerWriteActor(req)).toBe('service:internal');
    });

    it('accepts an exafy_admin JWT and records admin:<user_id>', async () => {
      optionalAuthImpl = (req, _res, next) => { req.identity = { user_id: 'admin-1', exafy_admin: true }; next(); };
      const req = mockReq({ Authorization: 'Bearer admin-jwt' });
      expect(await run(req, mockRes())).toBe(true);
      expect(getLedgerWriteActor(req)).toBe('admin:admin-1');
    });

    it('never authorises an empty service token (unset env var)', async () => {
      delete process.env.GATEWAY_SERVICE_TOKEN;
      const res = mockRes();
      expect(await run(mockReq({ Authorization: 'Bearer ' }), res)).toBe(false);
      expect(res._status).toBe(401);
    });

    it('fails closed when JWT verification throws', async () => {
      optionalAuthImpl = () => Promise.reject(new Error('jwks down'));
      const res = mockRes();
      expect(await run(mockReq({ Authorization: 'Bearer some-jwt' }), res)).toBe(false);
      expect(res._status).toBe(401);
    });
  });

  describe('log (the default)', () => {
    beforeEach(() => { delete process.env.LEDGER_WRITE_AUTH_MODE; });

    it('lets an anonymous request through but logs that it would be rejected', async () => {
      const req = mockReq();
      const res = mockRes();
      expect(await run(req, res)).toBe(true);
      expect(res._status).toBeNull();
      expect(getLedgerWriteActor(req)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('would be rejected (mode=log)'));
    });

    it('still records the verified actor for a good caller, without logging', async () => {
      const req = mockReq({ Authorization: 'Bearer svc-token' });
      expect(await run(req, mockRes())).toBe(true);
      expect(getLedgerWriteActor(req)).toBe('service:internal');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('off skips the check entirely', async () => {
    process.env.LEDGER_WRITE_AUTH_MODE = 'off';
    let jwtTouched = false;
    optionalAuthImpl = (_req, _res, next) => { jwtTouched = true; next(); };
    expect(await run(mockReq({ Authorization: 'Bearer x' }), mockRes())).toBe(true);
    expect(jwtTouched).toBe(false);
  });

  it('serviceAuthHeaders carries the token only when it is set', () => {
    expect(serviceAuthHeaders()).toEqual({ Authorization: 'Bearer svc-token' });
    delete process.env.GATEWAY_SERVICE_TOKEN;
    expect(serviceAuthHeaders()).toEqual({});
  });
});

describe('VTID-04727 wiring', () => {
  const tasks = read('services/gateway/src/routes/oasis-tasks.ts');
  const vtid = read('services/gateway/src/routes/vtid.ts');

  it.each([
    [tasks, "oasisTasksRouter.post('/api/v1/oasis/tasks', requireLedgerWriteAuth,"],
    [tasks, "oasisTasksRouter.patch('/api/v1/oasis/tasks/:id', requireLedgerWriteAuth,"],
    [tasks, "oasisTasksRouter.delete('/api/v1/oasis/tasks/:id', requireLedgerWriteAuth,"],
    [tasks, "oasisTasksRouter.post('/api/v1/oasis/tasks/:vtid/complete', requireLedgerWriteAuth,"],
    [vtid, 'router.post("/allocate", requireLedgerWriteAuth,'],
    [vtid, 'router.post("/create", requireLedgerWriteAuth,'],
  ])('write route is gated: %#', (src, line) => {
    expect(src).toContain(line);
  });

  it('no write route on the tasks router is left ungated', () => {
    const writes = tasks.match(/oasisTasksRouter\.(post|patch|put|delete)\([^\n]*/g) ?? [];
    expect(writes.length).toBe(4);
    for (const w of writes) expect(w).toContain('requireLedgerWriteAuth');
  });

  it('read routes stay open (out of scope for this VTID)', () => {
    const reads = tasks.match(/oasisTasksRouter\.get\([^\n]*/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r).not.toContain('requireLedgerWriteAuth');
  });

  it('delete records the verified actor before the caller-supplied header', () => {
    expect(tasks).toMatch(/const deletedBy = getLedgerWriteActor\(req\) \|\| /);
  });

  it('the voice developer tools send the service token on every ledger write', () => {
    const tools = read('services/gateway/src/services/orb-tools/vtid-lifecycle-tools.ts');
    const writes = tools.match(/gatewayApiCall\([^)]*\/api\/v1\/(vtid\/(allocate|create)|oasis\/tasks)[\s\S]*?\}\)/g) ?? [];
    const writeCalls = writes.filter((c) => /method: '(POST|PATCH|DELETE)'/.test(c));
    expect(writeCalls.length).toBe(6);
    for (const c of writeCalls) expect(c).toContain('serviceAuthHeaders()');
  });

  it('the auto-close workflow passes the service token secret to the script', () => {
    expect(read('.github/workflows/VTID-AUTO-CLOSE.yml')).toContain(
      'GATEWAY_SERVICE_TOKEN: ${{ secrets.GATEWAY_SERVICE_TOKEN }}',
    );
  });

  it('the backlog conversion script sends the service token when allocating', () => {
    expect(read('services/gateway/scripts/autopilot/backlog-convert-row.ts')).toMatch(
      /vtid\/allocate[\s\S]{0,300}GATEWAY_SERVICE_TOKEN/,
    );
  });

  it('staging pins enforce; production takes the mode only from PROD_LEDGER_WRITE_AUTH_MODE, default log (VTID-05700)', () => {
    const stage = read('.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(stage).toContain('"LEDGER_WRITE_AUTH_MODE"');
    expect(stage).toContain('{name:"LEDGER_WRITE_AUTH_MODE", value:"enforce"}');
    const prod = read('.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml');
    expect(prod.match(/\{name:"LEDGER_WRITE_AUTH_MODE"/g)).toHaveLength(1);
    expect(prod).toContain('{name:"LEDGER_WRITE_AUTH_MODE", value:$LWA}');
    expect(prod).toContain('LWA="${PROD_LEDGER_WRITE_AUTH_MODE:-log}"');
    expect(prod.match(/vars\.PROD_LEDGER_WRITE_AUTH_MODE\b/g)).toHaveLength(1);
    expect(prod).not.toMatch(/LEDGER_WRITE_AUTH_MODE"\s*,\s*value:\s*"enforce"/);
  });
});

/**
 * VTID-05700 (plan privacy-ledger-auth, lane ledger-auth-enforce): production gets its mode from the repository
 * variable through the deploy step, never a hardcoded enforce. These tests run that step's own shell on a fixture task
 * definition, then send the resulting mode through the real `vtid` router. No database, no network, no live gateway.
 */
describe('VTID-05700 production ledger write mode', () => {
  const STEP = 'Build task-definition (ledger write auth mode)';
  const ENV = { ...process.env };
  afterEach(() => { process.env = { ...ENV }; });

  type Step = { name?: string; env?: Record<string, string>; run?: string };
  function prodStep(): Step {
    const doc = yaml.load(read('.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml')) as { jobs: Record<string, { steps?: Step[] }> };
    const steps = Object.values(doc.jobs).flatMap((j) => j.steps ?? []).filter((s) => s.name === STEP);
    expect(steps).toHaveLength(1);
    return steps[0];
  }

  /** Runs the step on a fixture task definition. `variable` is what Actions renders for `vars.X` (unset → ''). */
  function productionMode(variable: string | undefined): string {
    const step = prodStep();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05700-'));
    const def = path.join(dir, 'task-def.json');
    fs.writeFileSync(def, JSON.stringify({ containerDefinitions: [{ environment: [
      { name: 'OTHER_FLAG', value: 'kept' }, { name: 'LEDGER_WRITE_AUTH_MODE', value: 'stale' },
    ] }] }));
    const script = path.join(dir, 'step.sh');
    fs.writeFileSync(script, String(step.run).split('/tmp/vitana-new-task-def.json').join(def));
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    if (variable !== undefined) env.PROD_LEDGER_WRITE_AUTH_MODE = variable;
    try {
      execFileSync('bash', [script], { env, stdio: 'pipe' });
      const out = JSON.parse(fs.readFileSync(def, 'utf8')).containerDefinitions[0].environment as { name: string; value: string }[];
      expect(out.find((e) => e.name === 'OTHER_FLAG')?.value).toBe('kept');
      const hits = out.filter((e) => e.name === 'LEDGER_WRITE_AUTH_MODE');
      expect(hits).toHaveLength(1);
      return hits[0].value;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the step reads the repository variable and defaults the shell value to log', () => {
    const step = prodStep();
    expect(step.env).toEqual({ PROD_LEDGER_WRITE_AUTH_MODE: '${{ vars.PROD_LEDGER_WRITE_AUTH_MODE }}' });
    expect(step.run).toContain('LWA="${PROD_LEDGER_WRITE_AUTH_MODE:-log}"');
  });

  it('with the variable unset, production gets LEDGER_WRITE_AUTH_MODE=log, never an empty value', () => {
    for (const unset of [undefined, '']) {
      const mode = productionMode(unset);
      expect(mode).toBe('log');
      expect(resolveLedgerWriteAuthMode(mode)).toBe('log');
    }
  });

  it('with the variable enforce, an anonymous POST /api/v1/vtid/allocate answers 401 JSON and nothing is allocated', async () => {
    const mode = productionMode('enforce');
    expect(mode).toBe('enforce');
    process.env.LEDGER_WRITE_AUTH_MODE = mode;
    process.env.GATEWAY_SERVICE_TOKEN = 'svc-token';
    const allocatorGate = jest.fn(async () => true);
    const fetchMock = jest.fn();
    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchMock;
    let router: any;
    jest.isolateModules(() => {
      jest.doMock('../src/services/system-controls-service', () => ({ isVtidAllocatorEnabled: allocatorGate, getSystemControl: jest.fn() }));
      jest.doMock('../src/services/plan-sparring/plan-sparring-service', () => ({ emitAllocationSparringEvent: jest.fn() }));
      jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn() }));
      router = require('../src/routes/vtid').vtidRouter;
    });
    try {
      const app = express();
      app.use(express.json());
      app.use('/api/v1/vtid', router);
      const res = await request(app).post('/api/v1/vtid/allocate').send({ source: 'vtid-05700-test' });
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.body.ok).toBe(false);
      expect(allocatorGate).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});

/**
 * VTID-05700 (owner decision 2026-11-11): the STAGING-VERIFY rejected probe of this lane targets VTID-PROBE. The exact
 * request STAGING-VERIFY builds goes through the gateway's own middleware order (index.ts: setupCors, sseHeaders,
 * compression, express.json, delegatedTokenGuard) and the real tasks router, with the real optionalAuth. Every way out
 * of the process is watched: fetch (Supabase REST, OASIS), http/https.get (remote JWKS), the Supabase client, the OASIS
 * emitter and the active-day writer. It passes on the base too: it pins the handler order the probe relies on.
 */
describe('VTID-05700 staging probe safety (VTID-PROBE)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { httpRequestInit } = require('../../../scripts/ci/staging-verify/lib.cjs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('https');
  const PROBE = { kind: 'http', method: 'POST', path: '/api/v1/oasis/tasks/VTID-PROBE/complete', rejected_probe: true, expect_status: 401 };
  const ENV = { ...process.env };
  const net: string[] = [];
  const oasis = jest.fn();
  const activeDay = jest.fn();
  const supabaseCall = jest.fn();
  let app: any;
  let realOptionalAuth: typeof optionalAuthImpl;
  let classifyBearer: (token: string, s: unknown, env: NodeJS.ProcessEnv) => Promise<unknown>;
  let realFetch: unknown;

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('../src/lib/supabase', () => ({
        getSupabase: () => ({
          rpc: (...a: unknown[]) => { supabaseCall('rpc', ...a); return Promise.resolve({ data: null, error: null }); },
          from: (...a: unknown[]) => { supabaseCall('from', ...a); throw new Error('no database in this test'); },
        }),
      }));
      jest.doMock('../src/services/oasis-event-service', () => ({
        emitOasisEvent: (...a: unknown[]) => { oasis(...a); return Promise.resolve({ ok: true }); },
      }));
      jest.doMock('../src/services/guide/active-usage', () => ({
        upsertActiveDay: (...a: unknown[]) => { activeDay(...a); return Promise.resolve(); },
      }));
      realOptionalAuth = jest.requireActual('../src/middleware/auth-supabase-jwt').optionalAuth;
      const { setupCors, sseHeaders } = require('../src/middleware/cors');
      const guard = require('../src/services/delegation-guard');
      classifyBearer = guard.classifyBearer;
      const { oasisTasksRouter } = require('../src/routes/oasis-tasks');
      const compression = require('compression');
      app = express();
      setupCors(app);
      app.use(sseHeaders);
      app.use(compression());
      app.use(express.json({ limit: '2mb' }));
      app.use(guard.delegatedTokenGuard());
      app.use('/', oasisTasksRouter);
    });
  });

  beforeEach(() => {
    net.length = 0;
    oasis.mockReset();
    activeDay.mockReset();
    supabaseCall.mockReset();
    Object.assign(process.env, {
      SUPABASE_URL: 'https://project.example.supabase.co',
      SUPABASE_SERVICE_ROLE: 'svc-role',
      SUPABASE_JWT_SECRET: 'x'.repeat(40),
      SUPABASE_AUTH_JWKS_URL: 'https://project.example.supabase.co/auth/v1/.well-known/jwks.json',
      COGNITO_USER_POOL_ID: 'eu-central-1_TESTPOOL',
      GATEWAY_SERVICE_TOKEN: 'svc-token',
    });
    delete process.env.DELEGATION_GUARD; // default: enforce
    optionalAuthImpl = realOptionalAuth;
    realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = jest.fn(async (url: unknown, init?: { method?: string }) => {
      net.push(`fetch ${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(JSON.stringify([{ vtid: 'VTID-PROBE', status: 'scheduled', is_terminal: false }]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    for (const [name, mod] of [['http', http], ['https', https]] as const) {
      jest.spyOn(mod, 'get').mockImplementation(((u: unknown) => {
        net.push(`${name}.get ${String(u)}`);
        throw new Error('network blocked in this test');
      }) as any);
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    (globalThis as any).fetch = realFetch;
    jest.restoreAllMocks();
    optionalAuthImpl = (_req, _res, next) => next();
    process.env = { ...ENV };
  });

  it('sends exactly the request STAGING-VERIFY builds for this probe', () => {
    expect(httpRequestInit(PROBE)).toEqual({
      method: 'POST',
      headers: { accept: 'application/json, text/html;q=0.9', authorization: 'Bearer staging-verify.invalid.probe', 'content-type': 'application/json' },
      body: '{}',
    });
  });

  it('the delegation guard skips the probe bearer without a session lookup', async () => {
    const rpc = jest.fn();
    expect(await classifyBearer('staging-verify.invalid.probe', { rpc }, process.env)).toEqual({ verdict: 'skip', claims: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['enforce', 401, 'invalid or expired token'],
    ['log', 400, 'INVALID_VTID_FORMAT'],
    ['off', 400, 'INVALID_VTID_FORMAT'],
  ])('mode %s: answers %i before any call out of the process', async (mode, status, error) => {
    process.env.LEDGER_WRITE_AUTH_MODE = mode as string;
    const init = httpRequestInit(PROBE);
    let r = request(app).post(PROBE.path);
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) r = r.set(k, v);
    const res = await r.send(init.body);
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe(error);
    expect(net).toEqual([]);
    expect(supabaseCall).not.toHaveBeenCalled();
    expect(oasis).not.toHaveBeenCalled();
    expect(activeDay).not.toHaveBeenCalled();
  });

  it('control: a well-formed ES256 bearer does reach the JWKS download, so the watchers above see network calls', async () => {
    process.env.LEDGER_WRITE_AUTH_MODE = 'enforce';
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${b64({ alg: 'ES256', kid: 'k1', typ: 'JWT' })}.${b64({ sub: 'u1', role: 'authenticated' })}.c2ln`;
    const res = await request(app).post(PROBE.path).set('authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(401);
    expect(net.some((c) => c.startsWith('https.get https://project.example.supabase.co/auth/v1/.well-known/jwks.json'))).toBe(true);
  });
});
