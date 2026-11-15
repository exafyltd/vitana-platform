/**
 * VTID-05800 — anyone may allocate a VTID (owner decision 2026-11-15).
 *
 * "allocating a vtid should be the easiest thing in the world, manually possible, single click possible, any way that
 * you can imagine should make it possible for any machine any human with any process to allocate a fresh vtid."
 *
 * Pins: the allocation routes accept every caller in every LEDGER_WRITE_AUTH_MODE (identified callers are recorded,
 * anonymous ones only rate limited); allocation is on by default; no sparring record is needed or nagged about; the
 * database gate is dropped by a migration; the hook and every "CI only / never by hand" rule text are gone; the
 * one-click workflow needs no input and no token. The Supabase REST API is a jest-mocked global fetch.
 */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

let optionalAuthImpl: (req: any, res: any, next: () => void) => unknown = (_req, _res, next) => next();
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (req: any, res: any, next: () => void) => optionalAuthImpl(req, res, next),
}));
const allocatorOn = jest.fn(async () => true);
jest.mock('../src/services/system-controls-service', () => {
  const actual = jest.requireActual('../src/services/system-controls-service');
  return { ...actual, isVtidAllocatorEnabled: () => allocatorOn() };
});
const emitOasisEvent = jest.fn(async () => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...a: unknown[]) => (emitOasisEvent as any)(...a),
}));

import {
  identifyVtidCaller, allowVtidAllocation, getVtidAllocActor, isReservedSource, mayUseReservedSource, anonClientKey,
} from '../src/middleware/vtid-allocation-access';
import { vtidRouter } from '../src/routes/vtid';
import { vtidAllocatorEnvSwitch } from '../src/lib/vtid-allocator-switch';

const REPO = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

function fakeReq(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: lower, header: (n: string) => lower[n.toLowerCase()] } as unknown as Request;
}

const ENV = { ...process.env };
const realFetch = (global as any).fetch;
let calls: Array<{ url: string; body?: string }> = [];

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/vtid', vtidRouter);
  return a;
}

beforeEach(() => {
  calls = [];
  optionalAuthImpl = (_req, _res, next) => next();
  allocatorOn.mockImplementation(async () => true);
  emitOasisEvent.mockClear();
  process.env.SUPABASE_URL = 'https://supabase.test.invalid';
  process.env.SUPABASE_SERVICE_ROLE = 'svc';
  process.env.GATEWAY_SERVICE_TOKEN = 'svc-token';
  process.env.LEDGER_WRITE_AUTH_MODE = 'enforce';
  delete process.env.VTID_ALLOC_SECRET;
  (global as any).fetch = jest.fn(async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init?.body });
    if (url.endsWith('/rest/v1/rpc/allocate_global_vtid')) {
      return { ok: true, status: 200, statusText: 'OK', json: async () => [{ vtid: 'VTID-05801', num: 5801, id: 'row-1' }], text: async () => '' };
    }
    return { ok: true, status: 204, statusText: 'No Content', json: async () => ({}), text: async () => '' };
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ENV };
  (global as any).fetch = realFetch;
  jest.restoreAllMocks();
});

describe('VTID-05800 who is allocating (never a 401)', () => {
  it('no credential, a wrong token and a verifier crash are all anonymous', async () => {
    expect(await identifyVtidCaller(fakeReq())).toBe('anonymous');
    expect(await identifyVtidCaller(fakeReq({ authorization: 'Bearer not-a-jwt' }))).toBe('anonymous');
    optionalAuthImpl = () => { throw new Error('jwks down'); };
    expect(await identifyVtidCaller(fakeReq({ authorization: 'Bearer x' }))).toBe('anonymous');
  });

  it('the service token, the alloc secret, an admin and a plain user are recorded', async () => {
    expect(await identifyVtidCaller(fakeReq({ authorization: 'Bearer svc-token' }))).toBe('service:internal');
    process.env.VTID_ALLOC_SECRET = 'sec';
    expect(await identifyVtidCaller(fakeReq({ 'x-vtid-alloc-secret': 'sec' }))).toBe('service:alloc-secret');
    optionalAuthImpl = (req, _res, next) => { req.identity = { user_id: 'u-1', exafy_admin: true }; next(); };
    expect(await identifyVtidCaller(fakeReq({ authorization: 'Bearer jwt' }))).toBe('admin:u-1');
    optionalAuthImpl = (req, _res, next) => { req.identity = { user_id: 'u-2', exafy_admin: false }; next(); };
    expect(await identifyVtidCaller(fakeReq({ authorization: 'Bearer jwt' }))).toBe('user:u-2');
  });

  it('only the service, the alloc secret and an admin may use the self-healing source', () => {
    expect(isReservedSource('self-healing')).toBe(true);
    expect(isReservedSource(' Self-Healing ')).toBe(true);
    expect(isReservedSource('claude-code')).toBe(false);
    expect(mayUseReservedSource('service:internal')).toBe(true);
    expect(mayUseReservedSource('service:alloc-secret')).toBe(true);
    expect(mayUseReservedSource('admin:u-1')).toBe(true);
    expect(mayUseReservedSource('user:u-2')).toBe(false);
    expect(mayUseReservedSource('anonymous')).toBe(false);
  });

  it('the middleware always calls next and records the actor, even in enforce mode', async () => {
    const req = fakeReq();
    (req as any).ip = '10.0.0.1';
    (req as any).app = { get: () => false };
    const next = jest.fn();
    allowVtidAllocation(req, { setHeader: () => {}, getHeader: () => undefined, headersSent: false } as unknown as Response, next as NextFunction);
    await new Promise((r) => setTimeout(r, 20));
    expect(next).toHaveBeenCalled();
    expect(getVtidAllocActor(req)).toBe('anonymous');
  });
});

describe('VTID-05800 POST /api/v1/vtid/allocate is open to everyone', () => {
  it('allocates for an anonymous caller although LEDGER_WRITE_AUTH_MODE=enforce, and needs no sparring record', async () => {
    const r = await request(app()).post('/api/v1/vtid/allocate').send({ title: 'Gateway: anything', source: 'kiro' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, vtid: 'VTID-05801' });
    const rpc = calls.find((c) => c.url.endsWith('/rest/v1/rpc/allocate_global_vtid'))!;
    expect(JSON.parse(rpc.body!)).toEqual({ p_source: 'kiro', p_layer: 'DEV', p_module: 'TASK' });
    // A VTID without a sparring record is normal: no "missing" warning is emitted.
    await new Promise((r2) => setTimeout(r2, 10));
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });

  it('allocates for a wrong token and for any signed-in user too', async () => {
    expect((await request(app()).post('/api/v1/vtid/allocate').set('Authorization', 'Bearer wrong').send({})).status).toBe(201);
    optionalAuthImpl = (req, _res, next) => { req.identity = { user_id: 'member-1', exafy_admin: false }; next(); };
    expect((await request(app()).post('/api/v1/vtid/allocate').set('Authorization', 'Bearer member-jwt').send({})).status).toBe(201);
  });

  it('/allocate-internal no longer needs its secret', async () => {
    const r = await request(app()).post('/api/v1/vtid/allocate-internal').send({ source: 'claude-code' });
    expect(r.status).toBe(201);
    expect(r.body.vtid).toBe('VTID-05801');
  });

  it('refuses the self-healing source from an anonymous caller, allows it with the service token', async () => {
    const anon = await request(app()).post('/api/v1/vtid/allocate').send({ source: 'self-healing' });
    expect(anon.status).toBe(403);
    expect(anon.body.error).toBe('reserved_source');
    const svc = await request(app()).post('/api/v1/vtid/allocate').set('Authorization', 'Bearer svc-token').send({ source: 'self-healing' });
    expect(svc.status).toBe(201);
  });

  it('a deliberate off switch is the only refusal (409)', async () => {
    allocatorOn.mockImplementation(async () => false);
    const r = await request(app()).post('/api/v1/vtid/allocate').send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('allocator_disabled');
  });

  it('the status endpoint says allocation is open and lists the paths', async () => {
    const r = await request(app()).get('/api/v1/vtid/allocator/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ allocation_access: 'open', sparring_required: false });
    expect(r.body.allocation_paths.join(' ')).toContain('new-vtid.mjs');
  });

  it('anonymous callers are rate limited per client; identified callers are not', async () => {
    process.env.VTID_ALLOC_ANON_PER_MINUTE = '2';
    let fresh: express.Router | null = null;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      fresh = require('../src/routes/vtid').vtidRouter;
    });
    const a = express();
    a.use(express.json());
    a.use('/api/v1/vtid', fresh!);
    expect((await request(a).post('/api/v1/vtid/allocate').send({})).status).toBe(201);
    expect((await request(a).post('/api/v1/vtid/allocate').send({})).status).toBe(201);
    const third = await request(a).post('/api/v1/vtid/allocate').send({});
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('rate_limited');
    expect((await request(a).post('/api/v1/vtid/allocate').set('Authorization', 'Bearer svc-token').send({})).status).toBe(201);
  });

  it('behind the ALB each client has its own bucket, keyed on the hop the ALB appended (a forged first hop does not help)', async () => {
    process.env.VTID_ALLOC_ANON_PER_MINUTE = '1';
    let fresh: express.Router | null = null;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      fresh = require('../src/routes/vtid').vtidRouter;
    });
    const a = express();
    a.use(express.json());
    a.use('/api/v1/vtid', fresh!);
    const from = (xff: string) => request(a).post('/api/v1/vtid/allocate').set('X-Forwarded-For', xff).send({});
    expect((await from('203.0.113.7')).status).toBe(201);
    expect((await from('203.0.113.7')).status).toBe(429);
    expect((await from('1.2.3.4, 203.0.113.7')).status).toBe(429);
    expect((await from('198.51.100.9')).status).toBe(201);
  });

  it('anonClientKey: the last X-Forwarded-For hop, else the socket address', () => {
    const req = (xff: string | undefined, ip = '10.0.0.5') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, ip }) as unknown as Request;
    expect(anonClientKey(req('9.9.9.9, 203.0.113.7'))).toBe('ip:203.0.113.7');
    expect(anonClientKey(req('203.0.113.7'))).toBe('ip:203.0.113.7');
    expect(anonClientKey(req(undefined))).toBe('ip:10.0.0.5');
  });
});

describe('VTID-05800 allocation is on by default', () => {
  it('only VTID_ALLOCATOR_ENABLED=false switches it off; true forces it on; anything else defers', () => {
    expect(vtidAllocatorEnvSwitch(undefined)).toBeNull();
    expect(vtidAllocatorEnvSwitch('')).toBeNull();
    expect(vtidAllocatorEnvSwitch('yes')).toBeNull();
    expect(vtidAllocatorEnvSwitch('false')).toBe(false);
    expect(vtidAllocatorEnvSwitch(' TRUE ')).toBe(true);
  });

  it('a missing control row and an expired arming mean on; an explicit disable means off', async () => {
    const run = async (rows: unknown[], env?: string) => {
      if (env === undefined) delete process.env.VTID_ALLOCATOR_ENABLED;
      else process.env.VTID_ALLOCATOR_ENABLED = env;
      (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => rows, text: async () => '' }));
      let real: { isVtidAllocatorEnabled: () => Promise<boolean> } | null = null;
      jest.isolateModules(() => {
        real = jest.requireActual('../src/services/system-controls-service');
      });
      return real!.isVtidAllocatorEnabled();
    };
    expect(await run([])).toBe(true);
    expect(await run([{ key: 'vtid_allocator_enabled', enabled: true, expires_at: null }])).toBe(true);
    expect(await run([{ key: 'vtid_allocator_enabled', enabled: true, expires_at: '2020-01-01T00:00:00Z' }])).toBe(true);
    expect(await run([{ key: 'vtid_allocator_enabled', enabled: false, expires_at: null }])).toBe(false);
    expect(await run([{ key: 'vtid_allocator_enabled', enabled: false, expires_at: null }], 'true')).toBe(true);
    expect(await run([], 'false')).toBe(false);
  });
});

describe('VTID-05800 the gate is gone everywhere', () => {
  it('a migration drops the vtid_ledger sparring trigger and index and turns the gate off', () => {
    const sql = read('supabase/migrations/20261115090000_vtid_05800_plan_sparring_gate_off.sql');
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_plan_sparring_check ON public.vtid_ledger;');
    expect(sql).toContain("UPDATE public.plan_sparring_config SET mode = 'off'");
    expect(sql).toContain('DROP INDEX IF EXISTS public.vtid_ledger_sparring_id_unique;');
    expect(fs.existsSync(path.join(REPO, 'docs/validation/VTID-05800/rollback-20261115090000.sql'))).toBe(true);
  });

  it('no rule file limits allocation to CI or forbids allocating by hand', () => {
    const files = [
      'CLAUDE.md', 'AGENTS.md', '.claude/rules/collaboration.md', '.claude/skills/plan-sparring/SKILL.md',
      '.kiro/steering/vitana-pipeline.md', '.kiro/steering/vitana-kiro-notes.md', '.kiro/steering/vitana-owner-autonomy.md',
      '.kiro/pipeline/README.md', '.kiro/pipeline/common-rules.md', '.kiro/pipeline/driver.md', '.kiro/pipeline/lane-code.md',
      '.kiro/pipeline/lane-review.md', '.kiro/pipeline/planning.md', '.kiro/agents/vitana-lane-reviewer.md',
      '.kiro/automations/exafy.md', '.kiro/automations/exafyltd.md', '.kiro/automations/jtadic.md',
      '.kiro/workflows/vitana-pipeline.workflow.json', 'scripts/collab/routine-prompt.md',
    ];
    const bans = [
      /VTIDs? come only from CI/i, /hand-allocat/i, /allocate a VTID by hand/i, /never allocates? a VTID/i,
      /no hand VTID/i, /No VTID before convergence/i, /allocated only by CI/i, /never by hand/i,
      /allocated only after its plan is sparred/i, /Never allocate a VTID/i,
    ];
    for (const f of files) {
      const text = read(f);
      for (const re of bans) expect({ file: f, match: re.exec(text)?.[0] ?? null }).toEqual({ file: f, match: null });
    }
  });

  it('the one-click workflow needs no input and no token', () => {
    const wf = read('.github/workflows/VTID-ALLOCATE.yml');
    expect(wf).not.toMatch(/required: true/);
    expect(wf).not.toContain('GATEWAY_SERVICE_TOKEN secret is not set');
    expect(wf).toContain('VTID_RESULT=${vtid}');
    expect(wf).toContain('FALLBACK_GATEWAY_URL: https://gateway.vitanaland.com');
  });
});
