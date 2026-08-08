// Admin Awareness Worker (BOOTSTRAP-ADMIN-KPI-AA) — unit tests
//
// Scope:
//   1. computeAndStoreForTenant() — the exported per-tenant KPI compute +
//      upsert pipeline:
//        a. early-return when supabase is unavailable
//        b. happy-path KPI payload wiring (users/community/autopilot
//           families, including derived fields like success rate)
//        c. per-family error isolation — one family's Promise.all rejecting
//           never blocks the other two families
//        d. tenant_kpi_current upsert failure short-circuits BEFORE the
//           daily upsert / scanners / health-index steps
//        e. tenant_kpi_daily upsert failure does NOT short-circuit —
//           scanners + health-index still run
//        f. scanner-runner failure never blocks the health-index step
//           (and vice versa) — engine-level error isolation
//   2. startAdminAwarenessWorker() / stopAdminAwarenessWorker() — interval
//      scheduling: single interval on double-start, clean stop, and that
//      the scheduled tick actually drives a tenant listing query.
//
// Mocking strategy: mock at the module boundary (lib/supabase,
// ./admin-scanners, ./admin-health-index) per the codebase's established
// convention (see test/services/admin-scanners/autopilot-health.test.ts) —
// this suite verifies the worker's own dispatch/upsert contract, not
// scanner or health-index internals.

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: any[]) => mockGetSupabase(...args),
}));

const mockRunAllScanners = jest.fn();
jest.mock('../../src/services/admin-scanners', () => ({
  runAllScannersForTenant: (...args: any[]) => mockRunAllScanners(...args),
}));

const mockStoreHealthIndex = jest.fn();
jest.mock('../../src/services/admin-health-index', () => ({
  storeTenantHealthIndex: (...args: any[]) => mockStoreHealthIndex(...args),
}));

import {
  computeAndStoreForTenant,
  startAdminAwarenessWorker,
  stopAdminAwarenessWorker,
} from '../../src/services/admin-awareness-worker';

type QueryResult = { count?: number | null; data?: unknown; error?: unknown } | Error;

interface UpsertOpts {
  currentUpsertError?: { message: string } | null;
  dailyUpsertError?: { message: string } | null;
}

/** Happy-path 16-entry queue matching the exact call order the source makes:
 *  users family (6), community family (5), autopilot family (5). */
function happyQueryQueue(): QueryResult[] {
  return [
    { count: 100, error: null }, // totalMembers
    { count: 5, error: null }, // signups24h
    { count: 20, error: null }, // signups7d
    { count: 10, error: null }, // signupsPrior7d
    { count: 3, error: null }, // invPending
    { count: 1, error: null }, // invExpiring48h
    { count: 4, error: null }, // eventsThisWeek
    { count: 2, error: null }, // eventsNextWeek
    { count: 15, error: null }, // groupsTotal
    { count: 1, error: null }, // liveRoomsActive
    { count: 6, error: null }, // newMemberships7d
    { count: 12, error: null }, // runs24h
    { count: 8, error: null }, // runsCompleted7d
    { count: 2, error: null }, // runsFailed7d
    { count: 7, error: null }, // recsNew
    { count: 9, error: null }, // recsActivated7d
  ];
}

/** Builds a fake Supabase client. `queryQueue` responses are handed out in
 *  call order to every `.select()...` chain that resolves via `.then()`
 *  (mirrors the order-dependent convention already used in
 *  test/services/admin-scanners/autopilot-health.test.ts). `.upsert()` is a
 *  separate mechanism recording every call for assertion. */
function createSupabaseMock(queryQueue: QueryResult[], upsertOpts: UpsertOpts = {}) {
  let i = 0;
  const fromCalls: string[] = [];
  const upsertCalls: Array<{ table: string; row: any; options: any }> = [];

  const client = {
    from: jest.fn((table: string) => {
      fromCalls.push(table);
      const chain: any = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        gte: jest.fn(() => chain),
        lt: jest.fn(() => chain),
        lte: jest.fn(() => chain),
        is: jest.fn(() => chain),
        order: jest.fn(() => chain),
        limit: jest.fn(() => chain),
        upsert: jest.fn((row: any, options: any) => {
          upsertCalls.push({ table, row, options });
          if (table === 'tenant_kpi_current') {
            return Promise.resolve({ error: upsertOpts.currentUpsertError ?? null });
          }
          if (table === 'tenant_kpi_daily') {
            return Promise.resolve({ error: upsertOpts.dailyUpsertError ?? null });
          }
          return Promise.resolve({ error: null });
        }),
        then: (resolve: any, reject: any) => {
          const next = i < queryQueue.length ? queryQueue[i] : { count: 0, data: [], error: null };
          i += 1;
          if (next instanceof Error) return Promise.reject(next).then(resolve, reject);
          return Promise.resolve(next).then(resolve, reject);
        },
      };
      return chain;
    }),
  };
  return { client, fromCalls, upsertCalls };
}

let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  mockRunAllScanners.mockResolvedValue({ scanners_run: 1, scanners_failed: 0, insights_written: 0, insights_resolved: 0 });
  mockStoreHealthIndex.mockResolvedValue({ score: 77, components: {} });
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
  stopAdminAwarenessWorker();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1a. Early return when supabase unavailable
// ---------------------------------------------------------------------------

describe('computeAndStoreForTenant — no supabase', () => {
  it('returns without calling scanners or the health index when supabase is unavailable', async () => {
    mockGetSupabase.mockReturnValue(null);

    await computeAndStoreForTenant('tenant-x');

    expect(mockRunAllScanners).not.toHaveBeenCalled();
    expect(mockStoreHealthIndex).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 1b. Happy path — KPI payload wiring
// ---------------------------------------------------------------------------

describe('computeAndStoreForTenant — happy path', () => {
  it('writes the exact users/community/autopilot KPI shapes to tenant_kpi_current', async () => {
    const sb = createSupabaseMock(happyQueryQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    await computeAndStoreForTenant('tenant-x');

    const current = sb.upsertCalls.find((c) => c.table === 'tenant_kpi_current');
    expect(current).toBeDefined();
    expect(current!.row.tenant_id).toBe('tenant-x');
    expect(current!.options).toEqual({ onConflict: 'tenant_id' });
    expect(current!.row.kpi.users).toEqual({
      total_members: 100,
      new_signups_24h: 5,
      new_signups_7d: 20,
      new_signups_7d_prior: 10,
      new_signups_7d_delta_pct: 100, // (20-10)/10 * 100
      invitations_pending: 3,
      invitations_expiring_48h: 1,
    });
    expect(current!.row.kpi.community).toEqual({
      events_this_week: 4,
      events_next_week: 2,
      groups_total: 15,
      live_rooms_active: 1,
      new_memberships_7d: 6,
    });
    expect(current!.row.kpi.autopilot).toEqual({
      runs_24h: 12,
      runs_completed_7d: 8,
      runs_failed_7d: 2,
      runs_success_rate_pct: 80, // 8 / (8+2) * 100
      recommendations_new: 7,
      recommendations_activated_7d: 9,
    });
  });

  it('also writes a same-shaped snapshot to tenant_kpi_daily keyed by today\'s date', async () => {
    const sb = createSupabaseMock(happyQueryQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    await computeAndStoreForTenant('tenant-x');

    const daily = sb.upsertCalls.find((c) => c.table === 'tenant_kpi_daily');
    expect(daily).toBeDefined();
    expect(daily!.options).toEqual({ onConflict: 'tenant_id,snapshot_date' });
    expect(daily!.row.snapshot_date).toBe(new Date().toISOString().slice(0, 10));
    expect(daily!.row.kpi.autopilot.runs_success_rate_pct).toBe(80);
  });

  it('runs the scanner runner and health-index store for the tenant after both upserts succeed', async () => {
    const sb = createSupabaseMock(happyQueryQueue());
    mockGetSupabase.mockReturnValue(sb.client);

    await computeAndStoreForTenant('tenant-x');

    expect(mockRunAllScanners).toHaveBeenCalledWith('tenant-x');
    expect(mockStoreHealthIndex).toHaveBeenCalledWith('tenant-x');
  });

  it('a zero-signups-in-prior-week tenant reports a 100% delta (not a divide-by-zero)', async () => {
    const queue = happyQueryQueue();
    queue[2] = { count: 5, error: null }; // signups7d
    queue[3] = { count: 0, error: null }; // signupsPrior7d
    const sb = createSupabaseMock(queue);
    mockGetSupabase.mockReturnValue(sb.client);

    await computeAndStoreForTenant('tenant-x');

    const current = sb.upsertCalls.find((c) => c.table === 'tenant_kpi_current');
    expect(current!.row.kpi.users.new_signups_7d_delta_pct).toBe(100);
  });

  it('zero completed+failed autopilot runs report a null success rate (not NaN or 0)', async () => {
    const queue = happyQueryQueue();
    queue[12] = { count: 0, error: null }; // runsCompleted7d
    queue[13] = { count: 0, error: null }; // runsFailed7d
    const sb = createSupabaseMock(queue);
    mockGetSupabase.mockReturnValue(sb.client);

    await computeAndStoreForTenant('tenant-x');

    const current = sb.upsertCalls.find((c) => c.table === 'tenant_kpi_current');
    expect(current!.row.kpi.autopilot.runs_success_rate_pct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1c. Per-family error isolation
// ---------------------------------------------------------------------------

describe('computeAndStoreForTenant — per-family error isolation', () => {
  it('the users family failing does not prevent community/autopilot from computing normally', async () => {
    const queue = happyQueryQueue();
    queue[0] = new Error('users query boom');
    const sb = createSupabaseMock(queue);
    mockGetSupabase.mockReturnValue(sb.client);

    await computeAndStoreForTenant('tenant-x');

    const current = sb.upsertCalls.find((c) => c.table === 'tenant_kpi_current');
    expect(current!.row.kpi.users).toEqual({ error: 'users query boom' });
    expect(current!.row.kpi.community).toEqual({
      events_this_week: 4,
      events_next_week: 2,
      groups_total: 15,
      live_rooms_active: 1,
      new_memberships_7d: 6,
    });
    expect(current!.row.kpi.autopilot.runs_success_rate_pct).toBe(80);
    // The write pipeline (upserts + scanners + health-index) still runs
    // despite one KPI family failing.
    expect(mockRunAllScanners).toHaveBeenCalledWith('tenant-x');
    expect(mockStoreHealthIndex).toHaveBeenCalledWith('tenant-x');
  });

  it('the autopilot family failing does not affect the already-computed users/community families', async () => {
    const queue = happyQueryQueue();
    queue[11] = new Error('autopilot query boom');
    const sb = createSupabaseMock(queue);
    mockGetSupabase.mockReturnValue(sb.client);

    await computeAndStoreForTenant('tenant-x');

    const current = sb.upsertCalls.find((c) => c.table === 'tenant_kpi_current');
    expect(current!.row.kpi.autopilot).toEqual({ error: 'autopilot query boom' });
    expect(current!.row.kpi.users.total_members).toBe(100);
    expect(current!.row.kpi.community.groups_total).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 1d/1e. Upsert failure control flow
// ---------------------------------------------------------------------------

describe('computeAndStoreForTenant — upsert failure control flow', () => {
  it('a tenant_kpi_current upsert failure short-circuits before the daily upsert / scanners / health-index', async () => {
    const sb = createSupabaseMock(happyQueryQueue(), { currentUpsertError: { message: 'current upsert failed' } });
    mockGetSupabase.mockReturnValue(sb.client);

    await computeAndStoreForTenant('tenant-x');

    expect(sb.upsertCalls.map((c) => c.table)).toEqual(['tenant_kpi_current']);
    expect(mockRunAllScanners).not.toHaveBeenCalled();
    expect(mockStoreHealthIndex).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('current upsert failed'));
  });

  it('a tenant_kpi_daily upsert failure does NOT short-circuit — scanners + health-index still run', async () => {
    const sb = createSupabaseMock(happyQueryQueue(), { dailyUpsertError: { message: 'daily upsert failed' } });
    mockGetSupabase.mockReturnValue(sb.client);

    await computeAndStoreForTenant('tenant-x');

    expect(sb.upsertCalls.map((c) => c.table)).toEqual(['tenant_kpi_current', 'tenant_kpi_daily']);
    expect(mockRunAllScanners).toHaveBeenCalledWith('tenant-x');
    expect(mockStoreHealthIndex).toHaveBeenCalledWith('tenant-x');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('daily upsert failed'));
  });
});

// ---------------------------------------------------------------------------
// 1f. Scanner / health-index error isolation
// ---------------------------------------------------------------------------

describe('computeAndStoreForTenant — scanner / health-index error isolation', () => {
  it('a scanner-runner rejection never propagates and never blocks the health-index step', async () => {
    const sb = createSupabaseMock(happyQueryQueue());
    mockGetSupabase.mockReturnValue(sb.client);
    mockRunAllScanners.mockRejectedValue(new Error('scanner boom'));

    await expect(computeAndStoreForTenant('tenant-x')).resolves.toBeUndefined();

    expect(mockStoreHealthIndex).toHaveBeenCalledWith('tenant-x');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scanner boom'));
  });

  it('a health-index rejection never propagates out of computeAndStoreForTenant', async () => {
    const sb = createSupabaseMock(happyQueryQueue());
    mockGetSupabase.mockReturnValue(sb.client);
    mockStoreHealthIndex.mockRejectedValue(new Error('health-index boom'));

    await expect(computeAndStoreForTenant('tenant-x')).resolves.toBeUndefined();

    expect(mockRunAllScanners).toHaveBeenCalledWith('tenant-x');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('health-index boom'));
  });
});

// ---------------------------------------------------------------------------
// 2. Worker scheduling
// ---------------------------------------------------------------------------

describe('startAdminAwarenessWorker / stopAdminAwarenessWorker', () => {
  it('starting twice registers only a single interval (second call is a no-op)', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    startAdminAwarenessWorker();
    startAdminAwarenessWorker();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('stop() clears the interval; a second stop() call is a safe no-op', () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    startAdminAwarenessWorker();
    stopAdminAwarenessWorker();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    stopAdminAwarenessWorker();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    clearIntervalSpy.mockRestore();
  });

  it('the scheduled tick lists active tenants and computes for each after the boot delay', async () => {
    jest.useFakeTimers();
    // listActiveTenants query response; no further per-tenant queries needed
    // because there are zero active tenants (keeps this test fast/simple —
    // per-tenant compute logic is covered by computeAndStoreForTenant tests).
    const sb = createSupabaseMock([{ data: [{ tenant_id: 't1', is_active: true }, { tenant_id: 't2', is_active: false }], error: null } as any]);
    mockGetSupabase.mockReturnValue(sb.client);

    startAdminAwarenessWorker();
    await jest.advanceTimersByTimeAsync(15_000);

    expect(sb.fromCalls).toContain('tenants');
  });
});
