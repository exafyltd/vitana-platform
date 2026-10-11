/**
 * VTID-05063 — the VTID ledger's READ routes require the gateway service
 * token or an exafy_admin JWT (same credential rule as the VTID-04727 write
 * gate, which this gate reuses).
 *
 * These tests pin the gate in all three rollout modes, the log-line hygiene
 * (sanitising, dedupe, caps), the boot line, that every Tier 1 read route
 * carries the gate per route (never router.use), that health routes stay
 * open, and the staging workflow wiring for step A (strip list only).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Request, Response, NextFunction } from 'express';
import * as yaml from 'js-yaml';

let optionalAuthImpl: (req: any, res: any, next: () => void) => unknown = (_req, _res, next) => next();
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (req: any, res: any, next: () => void) => optionalAuthImpl(req, res, next),
}));

import {
  requireLedgerReadAuth,
  resolveLedgerReadAuthMode,
  getLedgerReadActor,
  sanitizeLogField,
  logLedgerReadAuthBoot,
  __resetLedgerReadAuthLogState,
  __ledgerReadAuthDedupeSize,
  LEDGER_READ_LOG_MAX_KEYS,
  LEDGER_READ_LOG_MAX_LINES_PER_MINUTE,
} from '../src/middleware/ledger-read-auth';

const REPO = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

function mockReq(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    method: 'GET',
    baseUrl: '/api/v1/vtid',
    route: { path: '/list' },
    originalUrl: '/api/v1/vtid/list?limit=5&tenant=secret-tenant',
    url: '/list?limit=5&tenant=secret-tenant',
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
function run(req: Request, res: ReturnType<typeof mockRes> = mockRes()): Promise<boolean> {
  return new Promise((resolve) => {
    const origJson = res.json;
    res.json = (body: any) => { origJson(body); resolve(false); return res; };
    requireLedgerReadAuth(req, res, (() => resolve(true)) as NextFunction);
  });
}

const wouldReject = (spy: jest.SpyInstance): string[] =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ledger read would be rejected'));

describe('VTID-05063 ledger read auth', () => {
  const ENV = { ...process.env };
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    optionalAuthImpl = (_req, _res, next) => next();
    process.env.GATEWAY_SERVICE_TOKEN = 'svc-token';
    delete process.env.LEDGER_READ_AUTH_MODE;
    __resetLedgerReadAuthLogState();
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
      expect(resolveLedgerReadAuthMode(undefined)).toBe('log');
      expect(resolveLedgerReadAuthMode('')).toBe('log');
      expect(resolveLedgerReadAuthMode('enforced')).toBe('log');
      expect(resolveLedgerReadAuthMode('log')).toBe('log');
      expect(resolveLedgerReadAuthMode('ENFORCE')).toBe('enforce');
      expect(resolveLedgerReadAuthMode(' off ')).toBe('off');
    });

    it('reads LEDGER_READ_AUTH_MODE, not the write switch', () => {
      process.env.LEDGER_WRITE_AUTH_MODE = 'enforce';
      expect(resolveLedgerReadAuthMode()).toBe('log');
      process.env.LEDGER_READ_AUTH_MODE = 'enforce';
      expect(resolveLedgerReadAuthMode()).toBe('enforce');
    });
  });

  describe('enforce', () => {
    beforeEach(() => { process.env.LEDGER_READ_AUTH_MODE = 'enforce'; });

    it('rejects an anonymous request with 401 and does not call next', async () => {
      const res = mockRes();
      expect(await run(mockReq(), res)).toBe(false);
      expect(res._status).toBe(401);
      expect(res._json).toEqual({ ok: false, error: 'missing bearer token' });
    });

    it('rejects a malformed (non-Bearer) header with 401', async () => {
      const res = mockRes();
      expect(await run(mockReq({ Authorization: 'Basic abc' }), res)).toBe(false);
      expect(res._status).toBe(401);
    });

    it('rejects a wrong bearer that is not a valid JWT with 401', async () => {
      const res = mockRes();
      expect(await run(mockReq({ Authorization: 'Bearer nope' }), res)).toBe(false);
      expect(res._status).toBe(401);
      expect(res._json.error).toBe('invalid or expired token');
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
      expect(await run(req)).toBe(true);
      expect(jwtTouched).toBe(false);
      expect(getLedgerReadActor(req)).toBe('service:internal');
    });

    it('accepts an exafy_admin JWT and records admin:<user_id>', async () => {
      optionalAuthImpl = (req, _res, next) => { req.identity = { user_id: 'admin-1', exafy_admin: true }; next(); };
      const req = mockReq({ Authorization: 'Bearer admin-jwt' });
      expect(await run(req)).toBe(true);
      expect(getLedgerReadActor(req)).toBe('admin:admin-1');
    });

    it('never authorises an empty or unset service token', async () => {
      delete process.env.GATEWAY_SERVICE_TOKEN;
      const res = mockRes();
      expect(await run(mockReq({ Authorization: 'Bearer ' }), res)).toBe(false);
      expect(res._status).toBe(401);

      process.env.GATEWAY_SERVICE_TOKEN = '';
      const res2 = mockRes();
      expect(await run(mockReq({ Authorization: 'Bearer ' }), res2)).toBe(false);
      expect(res2._status).toBe(401);
    });

    it('fails closed when JWT verification throws', async () => {
      optionalAuthImpl = () => Promise.reject(new Error('jwks down'));
      const res = mockRes();
      expect(await run(mockReq({ Authorization: 'Bearer some-jwt' }), res)).toBe(false);
      expect(res._status).toBe(401);
    });
  });

  describe('log (the default)', () => {
    it('lets an anonymous request through and logs one would-reject line', async () => {
      const req = mockReq();
      const res = mockRes();
      expect(await run(req, res)).toBe(true);
      expect(res._status).toBeNull();
      expect(getLedgerReadActor(req)).toBeNull();
      const lines = wouldReject(warn);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('[VTID-05063] ledger read would be rejected (mode=log): GET /api/v1/vtid/list ');
      expect(lines[0]).toContain('status=401');
      expect(lines[0]).toContain('reason="missing bearer token"');
    });

    it('logs the route template, never the query string', async () => {
      await run(mockReq());
      const line = wouldReject(warn)[0];
      expect(line).not.toContain('limit=5');
      expect(line).not.toContain('secret-tenant');
    });

    it('never logs the presented token', async () => {
      await run(mockReq({ Authorization: 'Bearer a-leaked-looking-jwt-value' }));
      const all = [...warn.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(' ')).join('\n');
      expect(all).toContain('invalid or expired token');
      expect(all).not.toContain('a-leaked-looking-jwt-value');
    });

    it('logs a valid non-admin JWT as 403, distinct from 401', async () => {
      optionalAuthImpl = (req, _res, next) => { req.identity = { user_id: 'u1', exafy_admin: false }; next(); };
      expect(await run(mockReq({ Authorization: 'Bearer user-jwt' }))).toBe(true);
      expect(wouldReject(warn)[0]).toContain('status=403');
    });

    it('still records the verified actor for a good caller, without logging', async () => {
      const req = mockReq({ Authorization: 'Bearer svc-token' });
      expect(await run(req)).toBe(true);
      expect(getLedgerReadActor(req)).toBe('service:internal');
      expect(wouldReject(warn)).toHaveLength(0);
    });

    it('lets the request through when the verifier crashes', async () => {
      optionalAuthImpl = () => Promise.reject(new Error('jwks down'));
      expect(await run(mockReq({ Authorization: 'Bearer some-jwt' }))).toBe(true);
    });
  });

  it('off skips the check entirely', async () => {
    process.env.LEDGER_READ_AUTH_MODE = 'off';
    let jwtTouched = false;
    optionalAuthImpl = (_req, _res, next) => { jwtTouched = true; next(); };
    expect(await run(mockReq({ Authorization: 'Bearer x' }))).toBe(true);
    expect(await run(mockReq())).toBe(true);
    expect(jwtTouched).toBe(false);
    expect(wouldReject(warn)).toHaveLength(0);
  });

  describe('log hygiene', () => {
    it('sanitizeLogField replaces control characters, quotes and backslashes with ?', () => {
      expect(sanitizeLogField('a"b\\c\nd\x07e\u00e9', 80)).toBe('a?b?c?d?e?');
      expect(sanitizeLogField('x'.repeat(200), 80)).toHaveLength(80);
      expect(sanitizeLogField(undefined, 80)).toBe('');
    });

    it('neutralises an attacker-supplied User-Agent and logs only the Origin host', async () => {
      await run(mockReq({
        'User-Agent': 'evil"\n[VTID-FAKE] injected',
        Origin: 'https://evil.example.com/some/path?q=1',
      }));
      const line = wouldReject(warn)[0];
      expect(line).not.toContain('\n');
      expect(line).toContain('ua="evil??[VTID-FAKE] injected"');
      expect(line).toContain('origin="evil.example.com"');
      expect(line).not.toContain('/some/path');
    });

    it('falls back to the Referer host when there is no Origin', async () => {
      await run(mockReq({ Referer: 'https://ref.example.org/page?x=1' }));
      expect(wouldReject(warn)[0]).toContain('origin="ref.example.org"');
    });

    it('1000 identical would-rejects in one window produce one line, and the next window reports suppressed=', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      for (let i = 0; i < 1000; i++) await run(mockReq({ 'User-Agent': 'poller' }));
      expect(wouldReject(warn)).toHaveLength(1);

      now.mockReturnValue(1_000_000 + 60_001);
      await run(mockReq({ 'User-Agent': 'poller' }));
      const lines = wouldReject(warn);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('suppressed=999');
      now.mockRestore();
    });

    it(`keeps at most ${LEDGER_READ_LOG_MAX_KEYS} dedupe keys (oldest evicted)`, async () => {
      jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
      for (let i = 0; i < LEDGER_READ_LOG_MAX_KEYS + 50; i++) await run(mockReq({ 'User-Agent': `ua-${i}` }));
      expect(__ledgerReadAuthDedupeSize()).toBe(LEDGER_READ_LOG_MAX_KEYS);
    });

    it(`emits at most ${LEDGER_READ_LOG_MAX_LINES_PER_MINUTE} lines per minute, then one cap line`, async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(3_000_000);
      for (let i = 0; i < LEDGER_READ_LOG_MAX_LINES_PER_MINUTE + 30; i++) await run(mockReq({ 'User-Agent': `ua-${i}` }));
      const all = warn.mock.calls.map((c) => String(c[0]));
      expect(wouldReject(warn)).toHaveLength(LEDGER_READ_LOG_MAX_LINES_PER_MINUTE);
      expect(all.filter((l) => l === '[ledger-read-auth] log cap reached, dropping')).toHaveLength(1);

      // A new minute opens a new budget.
      now.mockReturnValue(3_000_000 + 60_001);
      await run(mockReq({ 'User-Agent': 'fresh-caller' }));
      expect(wouldReject(warn)).toHaveLength(LEDGER_READ_LOG_MAX_LINES_PER_MINUTE + 1);
    });
  });

  describe('boot line', () => {
    it('logs the mode and service_token_configured=true, never the token value', () => {
      process.env.GATEWAY_SERVICE_TOKEN = 'very-secret-service-token-value';
      process.env.LEDGER_READ_AUTH_MODE = 'enforce';
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      logLedgerReadAuthBoot();
      expect(log).toHaveBeenCalledWith('[ledger-read-auth] mode=enforce service_token_configured=true');
      const all = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(' ')).join('\n');
      expect(all).not.toContain('very-secret-service-token-value');
      log.mockRestore();
    });

    it('reports service_token_configured=false when the token is unset or empty, and the log default', () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      delete process.env.GATEWAY_SERVICE_TOKEN;
      logLedgerReadAuthBoot();
      process.env.GATEWAY_SERVICE_TOKEN = '';
      logLedgerReadAuthBoot();
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        '[ledger-read-auth] mode=log service_token_configured=false',
        '[ledger-read-auth] mode=log service_token_configured=false',
      ]);
      log.mockRestore();
    });

    it('is called once from the app.listen callback in index.ts', () => {
      const index = read('services/gateway/src/index.ts');
      const call = "require('./middleware/ledger-read-auth').logLedgerReadAuthBoot();";
      expect(index.split(call).length - 1).toBe(1);
      const listen = index.indexOf('const server = app.listen(PORT');
      expect(listen).toBeGreaterThan(0);
      expect(index.indexOf(call)).toBeGreaterThan(listen);
    });
  });
});

describe('VTID-05063 wiring (per route, never router.use)', () => {
  const oasisTasks = read('services/gateway/src/routes/oasis-tasks.ts');
  const ledger = read('services/gateway/src/routes/oasis-vtid-ledger.ts');
  const vtid = read('services/gateway/src/routes/vtid.ts');
  const tasks = read('services/gateway/src/routes/tasks.ts');
  const board = read('services/gateway/src/routes/board-adapter.ts');
  const approvals = read('services/gateway/src/routes/approvals.ts');
  const terminalize = read('services/gateway/src/routes/vtid-terminalize.ts');

  it.each([
    [oasisTasks, "oasisTasksRouter.get('/api/v1/oasis/tasks/discover', requireLedgerReadAuth,"],
    [oasisTasks, "oasisTasksRouter.get('/api/v1/oasis/tasks', requireLedgerReadAuth,"],
    [oasisTasks, "oasisTasksRouter.get('/api/v1/oasis/tasks/:id', requireLedgerReadAuth,"],
    [ledger, "oasisVtidLedgerRouter.get('/api/v1/oasis/vtid-ledger', requireLedgerReadAuth,"],
    [vtid, 'router.get("/list", requireLedgerReadAuth,'],
    [vtid, 'router.get("/projection", requireLedgerReadAuth,'],
    [vtid, 'router.get("/:vtid", requireLedgerReadAuth,'],
    [vtid, 'router.get("/allocator/status", requireLedgerReadAuth,'],
    [tasks, "router.get('/api/v1/tasks', requireLedgerReadAuth,"],
    [tasks, "router.get('/api/v1/vtid/:vtid', requireLedgerReadAuth,"],
    [tasks, "router.get('/api/v1/vtid/:vtid/execution-status', requireLedgerReadAuth,"],
    [board, "router.get('/', cors(corsOptions), requireLedgerReadAuth,"],
    [approvals, "router.get('/count', requireLedgerReadAuth,"],
    [approvals, "router.get('/pending', requireLedgerReadAuth,"],
  ])('Tier 1 read route is gated: %#', (src, line) => {
    expect(src).toContain(line);
  });

  it('every GET on the oasis-tasks, vtid-ledger, tasks and board routers carries the gate', () => {
    const gets = [
      ...(oasisTasks.match(/oasisTasksRouter\.get\([^\n]*/g) ?? []),
      ...(ledger.match(/oasisVtidLedgerRouter\.get\([^\n]*/g) ?? []),
      ...(tasks.match(/router\.get\([^\n]*/g) ?? []),
      ...(board.match(/router\.get\([^\n]*/g) ?? []),
    ];
    expect(gets.length).toBe(8);
    for (const g of gets) expect(g).toContain('requireLedgerReadAuth');
  });

  it('on the vtid router every GET but /health carries the gate, and /health stays open', () => {
    const gets = vtid.match(/router\.get\([^\n]*/g) ?? [];
    const health = gets.filter((g) => g.startsWith('router.get("/health"'));
    expect(health).toHaveLength(1);
    expect(health[0]).not.toContain('requireLedgerReadAuth');
    const rest = gets.filter((g) => !g.startsWith('router.get("/health"'));
    expect(rest.length).toBe(4);
    for (const g of rest) expect(g).toContain('requireLedgerReadAuth');
  });

  it('approvals /feed (GitHub PR feed, not ledger data) stays open', () => {
    expect(approvals).toMatch(/router\.get\('\/feed', async/);
  });

  it('terminalize health stays open', () => {
    expect(terminalize).toContain("router.get('/api/v1/oasis/vtid/terminalize/health', async");
  });

  it('OPTIONS preflights stay ungated', () => {
    expect(ledger).toContain("oasisVtidLedgerRouter.options('/api/v1/oasis/vtid-ledger', (_req: Request, res: Response) => {");
    expect(vtid).toMatch(/router\.options\("\*", \(_req: Request, res: Response\) =>/);
    expect(board).toContain("router.options('/', cors(corsOptions));");
  });

  it('the board route runs cors BEFORE the gate', () => {
    const line = (board.match(/router\.get\('\/'[^\n]*/) ?? [''])[0];
    expect(line.indexOf('cors(corsOptions)')).toBeGreaterThan(0);
    expect(line.indexOf('cors(corsOptions)')).toBeLessThan(line.indexOf('requireLedgerReadAuth'));
  });

  it('no router.use / app.use of the read gate anywhere, and no mount-level gate in index.ts', () => {
    const srcRoot = path.join(REPO, 'services/gateway/src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'frontend') walk(p); continue; }
        if (!/\.ts$/.test(entry.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/\.use\([^)]*requireLedgerReadAuth/.test(src)) offenders.push(path.relative(REPO, p));
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
    expect(read('services/gateway/src/index.ts')).not.toContain('requireLedgerReadAuth');
  });

  it('reuses the write gate credential rule instead of a second copy', () => {
    const mw = read('services/gateway/src/middleware/ledger-read-auth.ts');
    expect(mw).toContain("import { evaluateLedgerWriteAuth, LedgerWriteAuthResult } from './ledger-write-auth';");
    expect(mw).toContain('evaluateLedgerWriteAuth(req)');
    expect(mw).not.toContain('GATEWAY_SERVICE_TOKEN ===');
  });
});

describe('VTID-05063 gateway self-calls (source)', () => {
  it('gemini-operator approvals pending/count send the gateway service token, not the Supabase key', () => {
    const src = read('services/gateway/src/services/gemini-operator.ts');
    for (const route of ['pending\\?limit=\\$\\{limit\\}', 'count']) {
      const re = new RegExp(
        'fetch\\(`http://localhost:\\$\\{gatewayPort\\}/api/v1/approvals/' + route + '`, \\{\\s*headers: serviceAuthHeaders\\(\\),\\s*\\}\\)',
      );
      expect(src).toMatch(re);
    }
    expect(src).toContain("import { serviceAuthHeaders } from '../middleware/ledger-write-auth';");
  });

  it('developer-tools imports serviceAuthHeaders from the write gate module', () => {
    expect(read('services/gateway/src/services/orb-tools/developer-tools.ts')).toContain(
      "import { serviceAuthHeaders } from '../../middleware/ledger-write-auth';",
    );
  });

  it('task-state-query-service keeps its default BASE_URL (not changed by this VTID)', () => {
    expect(read('services/gateway/src/services/task-state-query-service.ts')).toContain(
      "BASE_URL: process.env.GATEWAY_BASE_URL || 'http://localhost:3000',",
    );
  });
});

describe('VTID-05063 deploy workflows (step A: strip list only)', () => {
  const stage = read('.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml');
  const prod = read('.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml');

  it('staging strips LEDGER_READ_AUTH_MODE after SCHEDULED_NOTIFICATIONS_AUTH_MODE (04677 contiguity kept)', () => {
    expect(stage).toContain('"LEDGER_WRITE_AUTH_MODE","SCHEDULED_NOTIFICATIONS_AUTH_MODE","LEDGER_READ_AUTH_MODE",');
  });

  it('staging does not pin the read mode yet (step B), so it runs the log default', () => {
    expect(stage).not.toMatch(/\{name:"LEDGER_READ_AUTH_MODE", value:/);
  });

  it('production workflow does not mention LEDGER_READ_AUTH_MODE at all (it flips by env-only dispatch)', () => {
    expect(prod).not.toContain('LEDGER_READ_AUTH_MODE');
  });

  it('the staging register step stays at or below 19,900 characters (headroom for the step B pin)', () => {
    const doc = yaml.load(stage) as { jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }> };
    const steps = Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []);
    const register = steps.find((s) => s.name === 'Register task-definition revision + roll the service');
    expect(register).toBeDefined();
    expect(typeof register!.run).toBe('string');
    expect(register!.run!.length).toBeLessThanOrEqual(19_900);
    expect(register!.run).toContain('"LEDGER_READ_AUTH_MODE"');
  });
});
