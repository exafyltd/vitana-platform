/**
 * VTID-05270 (mt-jobs, lane jobs-tenant-loop) — shared mt-flags + the
 * active-tenant loop for the heartbeat, the automation cron route and the
 * scheduled-notification routes.
 *
 * Pinned here:
 *   - the flag matrix (MT_RESOLUTION_V2 × feature_flags.mt.jobs_tenant_loop);
 *   - activeTenantIds: active non-platform tenants with the flag on, always
 *     DEFAULT_TENANT_ID, one query each, no DB read with the master off;
 *   - tenantTimezone fallback; resolveJobTenants precedence; the actor resolver;
 *   - heartbeat: registration gate, per-tick evaluation (a flag flipped off
 *     between two ticks stops the loop next tick), per-tenant clock;
 *   - /automations/cron/AP-0501: one pass off, one executeAutomation per tenant
 *     on, an explicit tenant runs once;
 *   - /scheduled-notifications: one DEFAULT_TENANT_ID pass off, two passes on;
 *     a nested /morning-briefing with a tenant runs once; a user already briefed
 *     in that tenant within 20 h is skipped.
 */
import express from 'express';
import request from 'supertest';

// ── Fake Supabase ───────────────────────────────────────────────────────────
type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
let queries: Array<{ table: string; ops: Array<[string, any[]]> }> = [];

function makeChain(table: string) {
  const ops: Array<[string, any[]]> = [];
  queries.push({ table, ops });
  const result = () => {
    let rows = [...(tables[table] || [])];
    for (const [op, args] of ops) {
      if (op === 'eq') rows = rows.filter((r) => r[args[0]] === args[1]);
      if (op === 'in') rows = rows.filter((r) => (args[1] as any[]).includes(r[args[0]]));
    }
    return { data: rows, error: null };
  };
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve({ data: null, error: null });
        return (...args: any[]) => {
          ops.push([prop, args]);
          return chain;
        };
      },
    },
  );
  return chain;
}
const fakeSb: any = { from: (table: string) => makeChain(table), rpc: () => Promise.resolve({ data: null, error: null }) };

jest.mock('@supabase/supabase-js', () => ({ createClient: () => fakeSb }));

// ── Collaborators the routes call ───────────────────────────────────────────
const notifyUserAsyncMock = jest.fn();
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUserAsync: (...args: any[]) => notifyUserAsyncMock(...args),
  sendPushToUser: jest.fn(),
  sendAppilixPush: jest.fn(),
  isSignedOutOnAllKnownDevices: jest.fn().mockResolvedValue(false),
  TYPE_META: {},
  newPushFanoutOutcome: jest.fn(),
  classifyPushOutcome: jest.fn(),
  recordPushOutcome: jest.fn(),
}));
jest.mock('../src/services/recommendation-engine', () => ({
  generatePersonalRecommendations: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn().mockResolvedValue('de'),
  bulkGetUserLocales: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const executeAutomationMock = jest.fn();
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (_req: any, res: any) => res.status(401).json({ ok: false }),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'service-role-key';
process.env.GATEWAY_INTERNAL_TOKEN = 'internal-token';

/* eslint-disable @typescript-eslint/no-var-requires */
const flags = require('../src/services/mt-flags');
const loop = require('../src/services/jobs/job-tenant-loop');
const tenancy = require('../src/services/tenancy/tenant-context');
/* eslint-enable @typescript-eslint/no-var-requires */

const DEFAULT = 'tenant-default';
const T_B = 'tenant-b';
const T_PLATFORM = 'tenant-platform';
const T_INACTIVE = 'tenant-inactive';
const T_UNFLAGGED = 'tenant-unflagged';

const ON = { mt: { jobs_tenant_loop: true } };

function seedTenants() {
  tables = {
    tenants: [
      { tenant_id: DEFAULT, is_active: true, is_platform: false },
      { tenant_id: T_B, is_active: true, is_platform: false },
      { tenant_id: T_PLATFORM, is_active: true, is_platform: true },
      { tenant_id: T_INACTIVE, is_active: false, is_platform: false },
      { tenant_id: T_UNFLAGGED, is_active: true, is_platform: false },
    ],
    tenant_settings: [
      { tenant_id: DEFAULT, timezone: 'Europe/Berlin', feature_flags: {} },
      { tenant_id: T_B, timezone: 'America/New_York', feature_flags: ON },
      { tenant_id: T_PLATFORM, timezone: 'UTC', feature_flags: ON },
      { tenant_id: T_INACTIVE, timezone: 'UTC', feature_flags: ON },
      { tenant_id: T_UNFLAGGED, timezone: 'UTC', feature_flags: {} },
    ],
  };
}

const ENV_SAVE = { ...process.env };
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  queries = [];
  seedTenants();
  setEnv({ MT_RESOLUTION_V2: undefined, DEFAULT_TENANT_ID: DEFAULT, AUTOPILOT_HEARTBEAT_ENABLED: undefined });
});
afterAll(() => {
  process.env = ENV_SAVE;
});

// ── mt-flags ────────────────────────────────────────────────────────────────
describe('isJobsTenantLoopEnabled', () => {
  test.each([
    [undefined, ON, false],
    ['false', ON, false],
    ['true', undefined, false],
    ['true', {}, false],
    ['true', { mt: {} }, false],
    ['true', { mt: { jobs_tenant_loop: false } }, false],
    ['true', ON, true],
  ])('MT_RESOLUTION_V2=%s flags=%j ⇒ %s', (master, ff, expected) => {
    expect(flags.isJobsTenantLoopEnabled({ MT_RESOLUTION_V2: master }, ff === undefined ? null : { feature_flags: ff })).toBe(expected);
  });
});

// ── activeTenantIds / timezone ──────────────────────────────────────────────
describe('activeTenantIds', () => {
  test('master off ⇒ [DEFAULT_TENANT_ID] with no DB read', async () => {
    expect(await loop.activeTenantIds(fakeSb, { DEFAULT_TENANT_ID: DEFAULT })).toEqual([DEFAULT]);
    expect(queries).toHaveLength(0);
  });

  test('master on ⇒ flagged active non-platform tenants ∪ DEFAULT, one query each', async () => {
    const ids = await loop.activeTenantIds(fakeSb, { MT_RESOLUTION_V2: 'true', DEFAULT_TENANT_ID: DEFAULT });
    expect(ids).toEqual([DEFAULT, T_B]);
    expect(ids).not.toContain(T_PLATFORM);
    expect(ids).not.toContain(T_INACTIVE);
    expect(ids).not.toContain(T_UNFLAGGED);
    expect(queries.map((q) => q.table)).toEqual(['tenants', 'tenant_settings']);
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([['select', ['tenant_id']], ['eq', ['is_active', true]], ['eq', ['is_platform', false]]]),
    );
  });

  test('DEFAULT_TENANT_ID stays in the list when its own flag is off or it is not in the active list', async () => {
    tables.tenants = tables.tenants.filter((t) => t.tenant_id !== DEFAULT);
    const ids = await loop.activeTenantIds(fakeSb, { MT_RESOLUTION_V2: 'true', DEFAULT_TENANT_ID: DEFAULT });
    expect(ids[0]).toBe(DEFAULT);
  });

  test('a failed tenant read degrades to [DEFAULT_TENANT_ID]', async () => {
    const broken: any = { from: () => ({ select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) };
    expect(await loop.activeTenantIds(broken, { MT_RESOLUTION_V2: 'true', DEFAULT_TENANT_ID: DEFAULT })).toEqual([DEFAULT]);
  });

  test('forEachActiveTenant gives each tenant its own context + timezone', async () => {
    const seen: any[] = [];
    await loop.forEachActiveTenant(fakeSb, async (ctx: any) => seen.push([ctx.tenantId, ctx.timezone]), {
      MT_RESOLUTION_V2: 'true',
      DEFAULT_TENANT_ID: DEFAULT,
    });
    expect(seen).toEqual([
      [DEFAULT, 'Europe/Berlin'],
      [T_B, 'America/New_York'],
    ]);
  });
});

describe('tenantTimezone', () => {
  test('uses the tenant setting, falls back to Europe/Berlin without a row or with a bad zone', () => {
    expect(loop.tenantTimezone({ timezone: 'Asia/Kathmandu' })).toBe('Asia/Kathmandu');
    expect(loop.tenantTimezone(null)).toBe('Europe/Berlin');
    expect(loop.tenantTimezone({ timezone: 'Not/AZone' })).toBe('Europe/Berlin');
  });
});

// ── resolveJobTenants / actor ───────────────────────────────────────────────
describe('resolveJobTenants', () => {
  const env = (on: boolean) => ({ MT_RESOLUTION_V2: on ? 'true' : undefined, DEFAULT_TENANT_ID: DEFAULT });
  test('identity tenant beats body tenant; either ⇒ exactly one, on both flag states', async () => {
    for (const on of [false, true]) {
      expect(await loop.resolveJobTenants({ identity: { tenant_id: 'id-t' }, body: { tenant_id: 'body-t' } }, fakeSb, env(on))).toEqual(['id-t']);
      expect(await loop.resolveJobTenants({ body: { tenant_id: 'body-t' } }, fakeSb, env(on))).toEqual(['body-t']);
    }
  });
  test('no tenant ⇒ DEFAULT off, active tenants on, [] off without a default', async () => {
    expect(await loop.resolveJobTenants({ body: {} }, fakeSb, env(false))).toEqual([DEFAULT]);
    expect(await loop.resolveJobTenants({ body: {} }, fakeSb, env(true))).toEqual([DEFAULT, T_B]);
    expect(await loop.resolveJobTenants({ body: {} }, fakeSb, {})).toEqual([]);
  });
});

describe('resolveActorTenant / jwtSubject', () => {
  afterEach(() => jest.restoreAllMocks());
  test('known tenant wins; else the primary tenant; unresolvable ⇒ null, never DEFAULT', async () => {
    const spy = jest.spyOn(tenancy, 'resolvePrimaryTenant');
    expect(await loop.resolveActorTenant({ tenantId: T_B, userId: 'u1' })).toBe(T_B);
    expect(spy).not.toHaveBeenCalled();
    spy.mockResolvedValueOnce({ status: 'found', tenantId: T_B, role: null, source: 'primary' } as any);
    expect(await loop.resolveActorTenant({ userId: 'u1' })).toBe(T_B);
    spy.mockResolvedValueOnce({ status: 'none' } as any);
    expect(await loop.resolveActorTenant({ userId: 'u1' })).toBeNull();
    spy.mockResolvedValueOnce({ status: 'unavailable' } as any);
    expect(await loop.resolveActorTenant({ userId: 'u1' })).toBeNull();
    expect(await loop.resolveActorTenant({})).toBeNull();
  });
  test('jwtSubject decodes sub, null on garbage', () => {
    const tok = `x.${Buffer.from(JSON.stringify({ sub: 'user-9' })).toString('base64')}.y`;
    expect(loop.jwtSubject(tok)).toBe('user-9');
    expect(loop.jwtSubject('garbage')).toBeNull();
    expect(loop.jwtSubject(null)).toBeNull();
  });
});

// ── Heartbeat ───────────────────────────────────────────────────────────────
describe('heartbeat loop', () => {
  test('registration gate: today without the master; also opens on MT_RESOLUTION_V2 without DEFAULT_TENANT_ID', () => {
    expect(loop.shouldRegisterHeartbeat({ AUTOPILOT_HEARTBEAT_ENABLED: 'true', DEFAULT_TENANT_ID: DEFAULT })).toBe(true);
    expect(loop.shouldRegisterHeartbeat({ AUTOPILOT_HEARTBEAT_ENABLED: 'true' })).toBe(false);
    expect(loop.shouldRegisterHeartbeat({ AUTOPILOT_HEARTBEAT_ENABLED: 'true', MT_RESOLUTION_V2: 'true' })).toBe(true);
    expect(loop.shouldRegisterHeartbeat({ MT_RESOLUTION_V2: 'true', DEFAULT_TENANT_ID: DEFAULT })).toBe(false);
  });

  test('master off ⇒ one DEFAULT_TENANT_ID cycle per tick, no DB read', async () => {
    const cycle = jest.fn().mockResolvedValue({ executed: [], skipped: [], failed: [] });
    await loop.runHeartbeatTick(cycle, fakeSb, { DEFAULT_TENANT_ID: DEFAULT });
    expect(cycle.mock.calls).toEqual([[DEFAULT]]);
    expect(queries).toHaveLength(0);
  });

  test('master on, no DEFAULT_TENANT_ID ⇒ loops the active flagged tenants', async () => {
    const cycle = jest.fn().mockResolvedValue({ executed: ['x'], skipped: [], failed: [] });
    const r = await loop.runHeartbeatTick(cycle, fakeSb, { MT_RESOLUTION_V2: 'true' });
    expect(cycle.mock.calls).toEqual([[T_B]]);
    expect(r.executed).toBe(1);
  });

  test('a tenant flag flipped off between two ticks stops that tenant on the next tick (no restart)', async () => {
    const cycle = jest.fn().mockResolvedValue({ executed: [], skipped: [], failed: [] });
    const env = { MT_RESOLUTION_V2: 'true', DEFAULT_TENANT_ID: DEFAULT };
    await loop.runHeartbeatTick(cycle, fakeSb, env);
    tables.tenant_settings.find((s) => s.tenant_id === T_B)!.feature_flags = { mt: { jobs_tenant_loop: false } };
    await loop.runHeartbeatTick(cycle, fakeSb, env);
    expect(cycle.mock.calls).toEqual([[DEFAULT], [T_B], [DEFAULT]]);
  });

  test('empty tenant list ⇒ no-op', async () => {
    const cycle = jest.fn();
    await loop.runHeartbeatTick(cycle, fakeSb, {});
    expect(cycle).not.toHaveBeenCalled();
  });
});

describe('runHeartbeatCycle per-tenant clock', () => {
  afterEach(() => jest.restoreAllMocks());
  test('two tenants both run a due heartbeat automation in one tick, then each waits its own interval', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const registry = require('../src/services/automation-registry');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runHeartbeatCycle } = require('../src/services/automation-executor');
    // An id the registry does not know: executeAutomation answers
    // "Unknown automation" (failed) without touching any handler — enough to
    // prove the cycle attempted it rather than skipping it on the clock.
    jest.spyOn(registry, 'getHeartbeatAutomations').mockReturnValue([
      { id: 'AP-TEST-05270', triggerType: 'heartbeat', triggerConfig: { intervalMinutes: 60 } },
    ]);
    const a1 = await runHeartbeatCycle('tenant-clock-a');
    const b1 = await runHeartbeatCycle('tenant-clock-b');
    expect(a1.failed).toEqual(['AP-TEST-05270']);
    expect(b1.failed).toEqual(['AP-TEST-05270']);
    const a2 = await runHeartbeatCycle('tenant-clock-a');
    const b2 = await runHeartbeatCycle('tenant-clock-b');
    expect(a2.skipped).toEqual(['AP-TEST-05270']);
    expect(b2.skipped).toEqual(['AP-TEST-05270']);
  });
});

// ── /automations/cron/:id ───────────────────────────────────────────────────
describe('/automations/cron/:id', () => {
  let app: express.Express;
  beforeAll(() => {
    jest.resetModules();
  });
  function buildApp() {
    jest.isolateModules(() => {
      jest.doMock('../src/services/automation-executor', () => ({
        executeAutomation: (...args: any[]) => executeAutomationMock(...args),
        runHeartbeatCycle: jest.fn(),
        dispatchEvent: jest.fn(),
        getRunHistory: jest.fn(),
        getActiveRuns: jest.fn(),
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const router = require('../src/routes/automations').default;
      app = express();
      app.use(express.json());
      app.use('/api/v1/automations', router);
    });
    return app;
  }
  beforeEach(() => {
    executeAutomationMock.mockResolvedValue({ ok: true, runId: 'r1' });
  });

  const post = (body: any) =>
    request(buildApp()).post('/api/v1/automations/cron/AP-0501').set('X-Gateway-Internal', 'internal-token').send(body);

  test('master off, no tenant ⇒ one DEFAULT_TENANT_ID pass, response unchanged', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, runId: 'r1' });
    expect(executeAutomationMock.mock.calls).toEqual([['AP-0501', DEFAULT, 'cron', 'cloud-scheduler']]);
  });

  test('master on, two active tenants, no tenant ⇒ one executeAutomation per tenant', async () => {
    process.env.MT_RESOLUTION_V2 = 'true';
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.body.fanout).toBe(true);
    expect(res.body.per_tenant.map((p: any) => p.tenant_id)).toEqual([DEFAULT, T_B]);
    expect(executeAutomationMock.mock.calls.map((c) => c[1])).toEqual([DEFAULT, T_B]);
  });

  test('master on, explicit body tenant ⇒ exactly one pass for it', async () => {
    process.env.MT_RESOLUTION_V2 = 'true';
    const res = await post({ tenant_id: T_B });
    expect(res.body).toEqual({ ok: true, runId: 'r1' });
    expect(executeAutomationMock.mock.calls.map((c) => c[1])).toEqual([T_B]);
  });

  test('no tenant anywhere ⇒ 400 as today', async () => {
    delete process.env.DEFAULT_TENANT_ID;
    const res = await post({});
    expect(res.status).toBe(400);
    expect(executeAutomationMock).not.toHaveBeenCalled();
  });
});

// ── /scheduled-notifications ────────────────────────────────────────────────
describe('/scheduled-notifications routes', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../src/routes/scheduled-notifications').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/scheduled-notifications', router);

  function seedMembers() {
    tables.user_tenants = [
      { user_id: 'u-default', tenant_id: DEFAULT, is_primary: true },
      { user_id: 'u-b', tenant_id: T_B, is_primary: true },
    ];
    tables.user_notifications = [];
  }
  const memberReads = () =>
    queries
      .filter((q) => q.table === 'user_tenants')
      .map((q) => q.ops.find(([op, a]) => op === 'eq' && a[0] === 'tenant_id')?.[1][1]);

  test('diary-reminder: master off ⇒ one DEFAULT_TENANT_ID pass, response unchanged', async () => {
    seedMembers();
    const res = await request(app).post('/api/v1/scheduled-notifications/diary-reminder').send({});
    expect(res.status).toBe(200);
    expect(res.body.fanout).toBeUndefined();
    expect(memberReads()).toEqual([DEFAULT]);
  });

  test('diary-reminder: master on, no tenant ⇒ two passes, one per tenant', async () => {
    seedMembers();
    process.env.MT_RESOLUTION_V2 = 'true';
    const res = await request(app).post('/api/v1/scheduled-notifications/diary-reminder').send({});
    expect(res.status).toBe(200);
    expect(res.body.per_tenant.map((p: any) => p.tenant_id)).toEqual([DEFAULT, T_B]);
    expect(memberReads()).toEqual([DEFAULT, T_B]);
  });

  test('nested /morning-briefing with a tenant (AP-0501) runs once for that tenant, flag on', async () => {
    seedMembers();
    process.env.MT_RESOLUTION_V2 = 'true';
    const res = await request(app).post('/api/v1/scheduled-notifications/morning-briefing').send({ tenant_id: T_B });
    expect(res.status).toBe(200);
    expect(res.body.fanout).toBeUndefined();
    expect(memberReads()).toEqual([T_B]);
    expect(notifyUserAsyncMock.mock.calls.map((c) => [c[0], c[1]])).toEqual([['u-b', T_B]]);
  });

  test('a user with a scheduler-written morning_briefing_ready row in that tenant within 20 h is skipped', async () => {
    seedMembers();
    process.env.MT_RESOLUTION_V2 = 'true';
    tables.user_notifications = [
      { user_id: 'u-b', tenant_id: T_B, type: 'morning_briefing_ready', created_at: new Date().toISOString() },
    ];
    const res = await request(app).post('/api/v1/scheduled-notifications/morning-briefing').send({ tenant_id: T_B });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, dispatched: 0, skipped_duplicate: 1 });
    expect(notifyUserAsyncMock).not.toHaveBeenCalled();
  });
});
