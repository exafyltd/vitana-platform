/**
 * VTID-05268 (mt-jobs, lane jobs-community-scan-tenant): the community scan
 * and the memory-embedding backfill loop run per active tenant under
 * MT_RESOLUTION_V2; off, both are exactly today's.
 *
 * - runCommunityScan({ tenantId }) scans only members whose PRIMARY tenant is
 *   that tenant (each member once), with the tenant's timezone as the final
 *   default of the per-member clock.
 * - /community-scan loops active tenants and emits ONE
 *   community_autopilot.scan.completed event per tick: today's six top-level
 *   fields (counts summed) plus per_tenant. Off ⇒ the payload is today's.
 * - The backfill loop's tenant source is activeTenantIds() when the master is
 *   on and the env list is empty; the env list stays the override.
 */
process.env.NODE_ENV = 'test';

const mockExcluded = jest.fn(async () => new Set<string>());
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIds: () => mockExcluded(),
}));
jest.mock('../src/i18n/server-locale', () => ({
  bulkGetUserLocales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((id) => [id, 'de']))),
  getUserLocale: jest.fn(async () => 'de'),
}));
const mockEmitOasisEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...a: unknown[]) => mockEmitOasisEvent(...a),
}));
let mockSb: any = null;
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockSb,
}));

import express from 'express';
import request from 'supertest';
import { runCommunityScan, runCommunityScanForTenants } from '../src/services/community-autopilot/scan-runner';
import {
  backfillTenantsForTick,
  resolveBackfillLoopConfig,
} from '../src/services/memory-embedding-backfill-loop';

const NOW = new Date('2026-09-24T05:10:00Z'); // 07:10 Europe/Berlin, 01:10 New York
const TENANT_A = 'aaaa0000-0000-4000-8000-00000000000a';
const TENANT_B = 'bbbb0000-0000-4000-8000-00000000000b';
const PLATFORM = 'ffff0000-0000-4000-8000-00000000000f';
const INACTIVE = 'eeee0000-0000-4000-8000-00000000000e';
const M_A = '11111111-1111-4111-8111-111111111111'; // primary A, secondary B
const M_B = '22222222-2222-4222-8222-222222222222'; // primary B
const M_P = '33333333-3333-4333-8333-333333333333'; // primary platform tenant
const M_I = '44444444-4444-4444-8444-444444444444'; // primary inactive tenant

function fakeSb(tables: Record<string, any[]>) {
  const inserted: any[] = [];
  const sb: any = {
    inserted,
    from(table: string) {
      let data = [...(tables[table] ?? [])];
      const q: any = {
        select: () => q, order: () => q, limit: () => q, gte: () => q, lte: () => q, not: () => q, is: () => q, like: () => q,
        eq: (c: string, v: any) => { data = data.filter((r) => r[c] === undefined || r[c] === v); return q; },
        in: (c: string, vs: any[]) => { data = data.filter((r) => r[c] === undefined || vs.includes(r[c])); return q; },
        insert: async (rows: any[]) => { inserted.push(...rows); return { error: null }; },
        update: () => q,
        then: (res: any, rej: any) => Promise.resolve({ data, error: null }).then(res, rej),
      };
      return q;
    },
  };
  return sb;
}

const tables = () => ({
  user_tenants: [
    { user_id: M_A, tenant_id: TENANT_A, is_primary: true },
    { user_id: M_A, tenant_id: TENANT_B, is_primary: false },
    { user_id: M_B, tenant_id: TENANT_B, is_primary: true },
    { user_id: M_P, tenant_id: PLATFORM, is_primary: true },
    { user_id: M_I, tenant_id: INACTIVE, is_primary: true },
  ],
  tenants: [
    { tenant_id: TENANT_A, is_active: true, is_platform: false },
    { tenant_id: TENANT_B, is_active: true, is_platform: false },
    { tenant_id: PLATFORM, is_active: true, is_platform: true },
    { tenant_id: INACTIVE, is_active: false, is_platform: false },
  ],
  tenant_settings: [
    { tenant_id: TENANT_A, timezone: 'Europe/Berlin', feature_flags: { mt: { jobs_tenant_loop: true } } },
    { tenant_id: TENANT_B, timezone: 'Europe/Berlin', feature_flags: { mt: { jobs_tenant_loop: true } } },
  ],
});

const scanned = (s: { results: Array<{ user_id: string }> }) => s.results.map((r) => r.user_id).sort();

beforeEach(() => {
  delete process.env.COMMUNITY_AUTOPILOT_SCAN_ENABLED;
  delete process.env.MT_RESOLUTION_V2;
  delete process.env.DEFAULT_TENANT_ID;
  mockEmitOasisEvent.mockClear();
});

describe('C1 runCommunityScan({ tenantId })', () => {
  it('without a tenant: platform-wide primary members, as today', async () => {
    const s = await runCommunityScan(fakeSb(tables()), { now: NOW });
    expect(scanned(s)).toEqual([M_A, M_B, M_P, M_I].sort());
  });

  it('a member primary in A and secondary in B is scanned only in A\'s pass', async () => {
    const sb = fakeSb(tables());
    expect(scanned(await runCommunityScan(sb, { now: NOW, tenantId: TENANT_A }))).toEqual([M_A]);
    expect(scanned(await runCommunityScan(sb, { now: NOW, tenantId: TENANT_B }))).toEqual([M_B]);
  });

  it('the tenant timezone is the final default of the member clock', async () => {
    const sb = fakeSb(tables());
    // 01:10 in New York: no member of A is due.
    const ny = await runCommunityScan(sb, { now: NOW, tenantId: TENANT_A, tenantTimezone: 'America/New_York' });
    expect(ny.members_considered).toBe(1);
    expect(ny.members_due).toBe(0);
    // A remembered member timezone still wins over the tenant default.
    const withFact = fakeSb({ ...tables(), memory_facts: [{ user_id: M_A, fact_key: 'timezone', fact_value: 'Europe/Berlin' }] });
    const own = await runCommunityScan(withFact, { now: NOW, tenantId: TENANT_A, tenantTimezone: 'America/New_York' });
    expect(own.members_due).toBe(1);
    // 'UTC' counts as unknown, so the tenant default applies (today: the platform default).
    const utc = fakeSb({ ...tables(), memory_facts: [{ user_id: M_A, fact_key: 'timezone', fact_value: 'UTC' }] });
    expect((await runCommunityScan(utc, { now: NOW, tenantId: TENANT_A, tenantTimezone: 'America/New_York' })).members_due).toBe(0);
  });
});

describe('C1/C1b runCommunityScanForTenants', () => {
  it('two tenants: each member once, totals summed, per_tenant added', async () => {
    const s = await runCommunityScanForTenants(fakeSb(tables()), [
      { tenantId: TENANT_A, timezone: 'Europe/Berlin' },
      { tenantId: TENANT_B, timezone: 'Europe/Berlin' },
    ], { now: NOW });
    expect(scanned(s)).toEqual([M_A, M_B].sort());
    expect(s.members_considered).toBe(2);
    expect(s.members_scanned).toBe(2);
    expect(s.dry_run).toBe(true);
    expect(s.per_tenant).toEqual([
      { tenant_id: TENANT_A, members_considered: 1, members_due: 1, members_scanned: 1, rows_inserted: 0 },
      { tenant_id: TENANT_B, members_considered: 1, members_due: 1, members_scanned: 1, rows_inserted: 0 },
    ]);
  });

  it('no tenants: an empty tick with today\'s top-level fields', async () => {
    const s = await runCommunityScanForTenants(fakeSb(tables()), [], { now: NOW });
    expect(s).toMatchObject({ enabled: false, dry_run: true, members_considered: 0, members_due: 0, members_scanned: 0, rows_inserted: 0, per_tenant: [] });
  });
});

describe('C1b /community-scan route: one event per tick', () => {
  const TOKEN = 'internal-token-05268';
  const mount = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/routes/autopilot-recommendations').default;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/autopilot/recommendations', router);
    return app;
  };
  const post = (app: express.Express) =>
    request(app).post('/api/v1/autopilot/recommendations/community-scan').set('X-Gateway-Internal', TOKEN).send({ dry_run: true });

  // The route module is large; its first require can take several seconds.
  jest.setTimeout(60_000);

  // The route scans at the real "now". Give every member a remembered
  // timezone (a whole-hour Etc/GMT zone) in which it is 07:xx right now, so
  // each one is due whatever the wall clock says.
  const dueZone = (): string => {
    for (let off = -12; off <= 14; off++) {
      const zone = off === 0 ? 'Etc/GMT' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
      const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hour12: false }).format(new Date())) % 24;
      if (h === 7) return zone;
    }
    throw new Error('no whole-hour zone at 07');
  };

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_TOKEN = TOKEN;
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
    const zone = dueZone();
    mockSb = fakeSb({
      ...tables(),
      memory_facts: [M_A, M_B, M_P, M_I].map((user_id) => ({ user_id, fact_key: 'timezone', fact_value: zone })),
    });
  });

  it('flag off: one platform-wide run, payload identical to today (no per_tenant)', async () => {
    const res = await post(mount());
    expect(res.status).toBe(200);
    expect(res.body.per_tenant).toBeUndefined();
    expect(res.body.members_scanned).toBe(4);
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitOasisEvent.mock.calls[0][0]).toMatchObject({ type: 'community_autopilot.scan.completed' });
    expect(mockEmitOasisEvent.mock.calls[0][0].payload).toEqual({
      enabled: false, dry_run: true, members_considered: 4, members_due: 4, members_scanned: 4, rows_inserted: 0,
    });
  });

  it('flag on: active non-platform tenants only, ONE event with summed totals + per_tenant', async () => {
    process.env.MT_RESOLUTION_V2 = 'true';
    const res = await post(mount());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, dry_run: true, members_considered: 2, members_scanned: 2 });
    // Platform-tenant and inactive-tenant members are in no pass.
    expect(res.body.results.map((r: any) => r.user_id).sort()).toEqual([M_A, M_B].sort());
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    const payload = mockEmitOasisEvent.mock.calls[0][0].payload;
    expect(payload).toEqual({
      enabled: false, dry_run: true, members_considered: 2, members_due: 2, members_scanned: 2, rows_inserted: 0,
      per_tenant: [
        { tenant_id: TENANT_A, members_considered: 1, members_due: 1, members_scanned: 1, rows_inserted: 0 },
        { tenant_id: TENANT_B, members_considered: 1, members_due: 1, members_scanned: 1, rows_inserted: 0 },
      ],
    });
  });

  it('flag on with user_id: the single-member operator check stays one run', async () => {
    process.env.MT_RESOLUTION_V2 = 'true';
    const res = await request(mount())
      .post('/api/v1/autopilot/recommendations/community-scan')
      .set('X-Gateway-Internal', TOKEN)
      .send({ dry_run: true, user_id: M_P });
    expect(res.status).toBe(200);
    expect(res.body.per_tenant).toBeUndefined();
    expect(res.body.results.map((r: any) => r.user_id)).toEqual([M_P]);
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
  });
});

describe('C2 backfill loop tenant source', () => {
  const ON = { MEMORY_EMBEDDING_BACKFILL_LOOP_ENABLED: 'true', AUTOMATIONS_DELIVERY_MODE: 'live' };
  const loadActive = jest.fn(async () => [TENANT_A, TENANT_B]);

  beforeEach(() => loadActive.mockClear());

  it('master off: the env list, as today (no env list ⇒ not started)', async () => {
    const cfg = resolveBackfillLoopConfig({ ...ON, MEMORY_EMBEDDING_BACKFILL_TENANT_IDS: TENANT_A });
    expect(cfg).toEqual({ enabled: true, tenantIds: [TENANT_A] });
    expect(await backfillTenantsForTick(cfg, loadActive)).toEqual([TENANT_A]);
    expect(loadActive).not.toHaveBeenCalled();
    expect(resolveBackfillLoopConfig(ON).enabled).toBe(false);
  });

  it('master on, no env list: activeTenantIds() on every tick', async () => {
    const cfg = resolveBackfillLoopConfig({ ...ON, MT_RESOLUTION_V2: 'true' });
    expect(cfg).toEqual({ enabled: true, tenantIds: [], source: 'db' });
    expect(await backfillTenantsForTick(cfg, loadActive)).toEqual([TENANT_A, TENANT_B]);
    expect(loadActive).toHaveBeenCalledTimes(1);
  });

  it('master on with an env list: the env list stays the pinned override', async () => {
    const cfg = resolveBackfillLoopConfig({ ...ON, MT_RESOLUTION_V2: 'true', MEMORY_EMBEDDING_BACKFILL_TENANT_IDS: TENANT_B });
    expect(cfg).toEqual({ enabled: true, tenantIds: [TENANT_B] });
    expect(await backfillTenantsForTick(cfg, loadActive)).toEqual([TENANT_B]);
    expect(loadActive).not.toHaveBeenCalled();
  });

  it('master on never starts the writing loop in shadow mode', () => {
    const cfg = resolveBackfillLoopConfig({ ...ON, MT_RESOLUTION_V2: 'true', AUTOMATIONS_DELIVERY_MODE: 'shadow' });
    expect(cfg.enabled).toBe(false);
    expect(cfg.reason).toMatch(/shadow/);
  });
});
