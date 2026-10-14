/**
 * VTID-05089 (Health Hub D6a) — wearable -> health_features_daily bridge.
 *
 * Runs the real bridge and its real repository over an in-memory fake
 * Supabase that models the parts the bridge depends on: reads of
 * wearable_daily_metrics / wearable_workouts, an insert that ignores
 * duplicates on (tenant_id, user_id, date, feature_key), an update filtered
 * on metadata->>source, the Index RPC and the two exclusion tables.
 */

const mockEmit = jest.fn(async (..._args: unknown[]) => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmit(...args),
}));

import {
  bridgeWearableDays,
  isWearableFeatureBridgeEnabled,
  mapDailyMetricsToFeatures,
  type DailyMetricsRow,
} from '../src/services/wearable-features-bridge';

const ON = { WEARABLE_FEATURE_BRIDGE_ENABLED: 'true' } as NodeJS.ProcessEnv;
const NOW = new Date('2026-10-12T09:30:00.000Z');
const T = 'tenant-1';
const U = 'user-1';

type Row = Record<string, any>;

function getPath(row: Row, col: string): unknown {
  const m = /^metadata->>(\w+)$/.exec(col);
  if (m) return row.metadata?.[m[1]];
  return row[col];
}

function createFakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    wearable_daily_metrics: [],
    wearable_workouts: [],
    health_features_daily: [],
    service_bot_accounts: [],
    notification_test_actors: [],
    ...JSON.parse(JSON.stringify(seed)),
  };
  const writes: Array<{ table: string; op: string }> = [];
  const rpcCalls: Array<{ name: string; params: any }> = [];
  const failOn: { table?: string; op?: string; rpc?: boolean } = {};

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'upsert' | 'update' = 'select';
    let payload: any;
    let upsertOpts: any;
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: unknown) => (filters.push((r) => getPath(r, c) === v), chain),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(getPath(r, c))), chain),
      gte: (c: string, v: any) => (filters.push((r) => String(getPath(r, c)) >= v), chain),
      lt: (c: string, v: any) => (filters.push((r) => String(getPath(r, c)) < v), chain),
      filter: (c: string, operator: string, v: unknown) => {
        if (operator !== 'eq') throw new Error(`fake: unsupported filter op ${operator}`);
        filters.push((r) => getPath(r, c) === v);
        return chain;
      },
      upsert: (rows: any, opts: any) => ((op = 'upsert'), (payload = rows), (upsertOpts = opts), chain),
      update: (patch: any) => ((op = 'update'), (payload = patch), chain),
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    };
    function run() {
      if (op !== 'select') writes.push({ table, op });
      if (failOn.table === table && (!failOn.op || failOn.op === op)) {
        return { data: null, error: { message: 'boom' } };
      }
      const rows = tables[table] ?? (tables[table] = []);
      if (op === 'select') return { data: rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
      if (op === 'upsert') {
        const keys = String(upsertOpts?.onConflict ?? '').split(',');
        for (const incoming of Array.isArray(payload) ? payload : [payload]) {
          const existing = rows.find((r) => keys.every((k) => r[k] === incoming[k]));
          if (existing) {
            if (!upsertOpts?.ignoreDuplicates) Object.assign(existing, JSON.parse(JSON.stringify(incoming)));
          } else rows.push(JSON.parse(JSON.stringify(incoming)));
        }
        return { data: null, error: null };
      }
      for (const r of rows) if (filters.every((f) => f(r))) Object.assign(r, JSON.parse(JSON.stringify(payload)));
      return { data: null, error: null };
    }
    return chain;
  }

  const client: any = {
    from: jest.fn(from),
    rpc: jest.fn(async (name: string, params: any) => {
      rpcCalls.push({ name, params });
      return failOn.rpc ? { data: null, error: { message: 'rpc boom' } } : { data: { ok: true }, error: null };
    }),
  };
  return { client, tables, writes, rpcCalls, failOn };
}

const OURA_DAY: Row = {
  tenant_id: T, user_id: U, provider: 'oura', metric_date: '2026-10-11', updated_at: '2026-10-11T08:00:00Z',
  sleep_minutes: 437, sleep_efficiency_pct: 88.5, hrv_avg_ms: 52.25, hrv_rmssd_ms: 49.75,
  resting_hr: 61, steps: 12345, vo2max: 47.5, workout_count: 3,
};

beforeEach(() => {
  mockEmit.mockClear();
});

// ---------------------------------------------------------------------------
// Flag matrix
// ---------------------------------------------------------------------------

describe('isWearableFeatureBridgeEnabled (VTID-05089)', () => {
  it.each([
    ['flag absent on production', {}, false],
    ['flag absent, VITANA_ENV=production', { VITANA_ENV: 'production' }, false],
    ["'true' on production (VITANA_ENV unset)", { WEARABLE_FEATURE_BRIDGE_ENABLED: 'true' }, true],
    ["'true' on production (VITANA_ENV=production)", { WEARABLE_FEATURE_BRIDGE_ENABLED: 'true', VITANA_ENV: 'production' }, true],
    ["'true' on staging", { WEARABLE_FEATURE_BRIDGE_ENABLED: 'true', VITANA_ENV: 'staging' }, false],
    ["'false'", { WEARABLE_FEATURE_BRIDGE_ENABLED: 'false' }, false],
    ["'TRUE'", { WEARABLE_FEATURE_BRIDGE_ENABLED: 'TRUE' }, false],
    ["'1'", { WEARABLE_FEATURE_BRIDGE_ENABLED: '1' }, false],
  ])('%s -> %s', (_label, env, expected) => {
    expect(isWearableFeatureBridgeEnabled(env as NodeJS.ProcessEnv)).toBe(expected);
  });

  it.each([
    ['absent', {}],
    ["'false'", { WEARABLE_FEATURE_BRIDGE_ENABLED: 'false' }],
    ["'TRUE'", { WEARABLE_FEATURE_BRIDGE_ENABLED: 'TRUE' }],
    ["'true' + VITANA_ENV=staging", { WEARABLE_FEATURE_BRIDGE_ENABLED: 'true', VITANA_ENV: 'staging' }],
  ])('flag %s -> bridgeWearableDays makes zero reads, zero writes, zero RPC calls', async (_l, env) => {
    const db = createFakeDb({ wearable_daily_metrics: [OURA_DAY] });
    const res = await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11'] }, { env: env as NodeJS.ProcessEnv, now: NOW });
    expect(res).toEqual({ ok: true, skipped: 'disabled' });
    expect(db.client.from).not.toHaveBeenCalled();
    expect(db.client.rpc).not.toHaveBeenCalled();
    expect(db.tables.health_features_daily).toHaveLength(0);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

describe('mapDailyMetricsToFeatures (VTID-05089)', () => {
  it('maps every column to its feature key and unit', () => {
    const out = mapDailyMetricsToFeatures([OURA_DAY as DailyMetricsRow]);
    const byKey = Object.fromEntries(out.map((f) => [f.feature_key, f]));
    expect(byKey).toEqual({
      wearable_sleep_duration: { feature_key: 'wearable_sleep_duration', feature_value: 437, feature_unit: 'min', sample_count: 1, provider: 'oura' },
      wearable_sleep_efficiency: { feature_key: 'wearable_sleep_efficiency', feature_value: 88.5, feature_unit: '%', sample_count: 1, provider: 'oura' },
      wearable_hrv: { feature_key: 'wearable_hrv', feature_value: 52.25, feature_unit: 'ms', sample_count: 1, provider: 'oura' },
      wearable_heart_rate: { feature_key: 'wearable_heart_rate', feature_value: 61, feature_unit: 'bpm', sample_count: 1, provider: 'oura' },
      wearable_steps: { feature_key: 'wearable_steps', feature_value: 12345, feature_unit: 'steps', sample_count: 1, provider: 'oura' },
      vo2_max: { feature_key: 'vo2_max', feature_value: 47.5, feature_unit: 'ml/kg/min', sample_count: 1, provider: 'oura' },
      wearable_workout: { feature_key: 'wearable_workout', feature_value: 3, feature_unit: 'count', sample_count: 1, provider: 'oura' },
    });
    // No honest source column -> never produced.
    expect(out.map((f) => f.feature_key)).not.toEqual(expect.arrayContaining(['wearable_sleep_stages']));
    expect(out.map((f) => f.feature_key)).not.toEqual(expect.arrayContaining(['wearable_stress']));
  });

  it('falls back to hrv_rmssd_ms when hrv_avg_ms is null', () => {
    const out = mapDailyMetricsToFeatures([{ ...OURA_DAY, hrv_avg_ms: null } as DailyMetricsRow]);
    expect(out.find((f) => f.feature_key === 'wearable_hrv')?.feature_value).toBe(49.75);
  });

  it('accepts numeric strings (PostgREST NUMERIC) and skips nulls', () => {
    const out = mapDailyMetricsToFeatures([
      { provider: 'oura', metric_date: '2026-10-11', sleep_efficiency_pct: '91.25', steps: null, vo2max: undefined } as DailyMetricsRow,
    ]);
    expect(out).toEqual([
      { feature_key: 'wearable_sleep_efficiency', feature_value: 91.25, feature_unit: '%', sample_count: 1, provider: 'oura' },
    ]);
  });

  it.each([
    ['sleep_minutes', 0], ['sleep_minutes', 1441],
    ['sleep_efficiency_pct', -1], ['sleep_efficiency_pct', 100.5],
    ['hrv_avg_ms', 0], ['hrv_avg_ms', 301],
    ['resting_hr', 24], ['resting_hr', 221],
    ['steps', -5], ['steps', 100001],
    ['vo2max', 9.9], ['vo2max', 95.1],
  ])('drops an out-of-bounds %s = %s (never clamps)', (col, value) => {
    const row = { provider: 'oura', metric_date: '2026-10-11', [col]: value } as DailyMetricsRow;
    expect(mapDailyMetricsToFeatures([row])).toEqual([]);
  });

  it.each([
    ['sleep_minutes', 1, 'wearable_sleep_duration'], ['sleep_minutes', 1440, 'wearable_sleep_duration'],
    ['sleep_efficiency_pct', 0, 'wearable_sleep_efficiency'], ['sleep_efficiency_pct', 100, 'wearable_sleep_efficiency'],
    ['hrv_avg_ms', 1, 'wearable_hrv'], ['hrv_avg_ms', 300, 'wearable_hrv'],
    ['resting_hr', 25, 'wearable_heart_rate'], ['resting_hr', 220, 'wearable_heart_rate'],
    ['steps', 0, 'wearable_steps'], ['steps', 100000, 'wearable_steps'],
    ['vo2max', 10, 'vo2_max'], ['vo2max', 95, 'vo2_max'],
  ])('keeps the inclusive bound %s = %s', (col, value, key) => {
    const row = { provider: 'oura', metric_date: '2026-10-11', [col]: value } as DailyMetricsRow;
    expect(mapDailyMetricsToFeatures([row])).toEqual([
      expect.objectContaining({ feature_key: key, feature_value: value }),
    ]);
  });

  it('multi-provider merge: per column the row with the latest updated_at wins, with its provider', () => {
    const older = { provider: 'garmin', metric_date: '2026-10-11', updated_at: '2026-10-11T06:00:00Z', sleep_minutes: 400, steps: 9000, resting_hr: 58 };
    const newer = { provider: 'oura', metric_date: '2026-10-11', updated_at: '2026-10-11T09:00:00Z', sleep_minutes: 430, steps: null, resting_hr: 999 };
    const out = mapDailyMetricsToFeatures([older, newer] as DailyMetricsRow[]);
    const byKey = Object.fromEntries(out.map((f) => [f.feature_key, f]));
    expect(byKey.wearable_sleep_duration).toMatchObject({ feature_value: 430, provider: 'oura', sample_count: 2 });
    // newer has no steps -> older provider's value
    expect(byKey.wearable_steps).toMatchObject({ feature_value: 9000, provider: 'garmin', sample_count: 1 });
    // newer value implausible -> dropped, older plausible value used
    expect(byKey.wearable_heart_rate).toMatchObject({ feature_value: 58, provider: 'garmin', sample_count: 1 });
    // Input order does not matter.
    expect(mapDailyMetricsToFeatures([newer, older] as DailyMetricsRow[])).toEqual(out);
  });

  it('workout count is the max of the daily workout_count and the wearable_workouts rows that day', () => {
    const day = { provider: 'garmin', metric_date: '2026-10-11', workout_count: 1 } as DailyMetricsRow;
    const workouts = [
      { provider: 'strava', started_at: '2026-10-11T06:00:00Z' },
      { provider: 'garmin', started_at: '2026-10-11T18:00:00Z' },
    ];
    expect(mapDailyMetricsToFeatures([day], workouts)).toEqual([
      { feature_key: 'wearable_workout', feature_value: 2, feature_unit: 'count', sample_count: 2, provider: 'garmin+strava' },
    ]);
    const bigDaily = { ...day, workout_count: 4 } as DailyMetricsRow;
    expect(mapDailyMetricsToFeatures([bigDaily], workouts)).toEqual([
      { feature_key: 'wearable_workout', feature_value: 4, feature_unit: 'count', sample_count: 1, provider: 'garmin' },
    ]);
  });

  it('writes no workout feature when both sources say zero', () => {
    expect(mapDailyMetricsToFeatures([{ provider: 'oura', metric_date: '2026-10-11', workout_count: 0 } as DailyMetricsRow], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bridge (writes, precedence, idempotency, RPC, OASIS)
// ---------------------------------------------------------------------------

describe('bridgeWearableDays (VTID-05089)', () => {
  it('writes the mapped rows with bridge metadata and recomputes the Index exactly once', async () => {
    const db = createFakeDb({
      wearable_daily_metrics: [OURA_DAY, { ...OURA_DAY, metric_date: '2026-10-10', sleep_minutes: 401 }],
      wearable_workouts: [{ tenant_id: T, user_id: U, provider: 'strava', started_at: '2026-10-10T07:00:00.000Z' }],
    });
    const res = await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11', '2026-10-10', '2026-10-11'] }, { env: ON, now: NOW });

    expect(res).toEqual({ ok: true, features_written: 14, days: 2, index_recomputed: true });
    expect(db.tables.health_features_daily).toHaveLength(14);
    const sleep = db.tables.health_features_daily.find((r) => r.date === '2026-10-11' && r.feature_key === 'wearable_sleep_duration');
    expect(sleep).toEqual({
      tenant_id: T, user_id: U, date: '2026-10-11', feature_key: 'wearable_sleep_duration',
      feature_value: 437, feature_unit: 'min', sample_count: 1, confidence: 0.9,
      metadata: { source: 'wearable_bridge', provider: 'oura', metric_date: '2026-10-11' },
      updated_at: NOW.toISOString(),
    });
    // VTID-05168: the recompute goes through the locked + recorded writer, tagged as a wearable sync.
    expect(db.rpcCalls).toEqual([{
      name: 'vitana_index_recompute_and_record',
      params: { p_user_id: U, p_date: '2026-10-12', p_trigger: 'wearable_sync', p_source_kind: 'wearable_bridge', p_source_ref: 'oura', p_model_version: 'v3-5pillar' },
    }]);
  });

  it('only reads this member in this tenant (another member / tenant is never bridged)', async () => {
    const db = createFakeDb({
      wearable_daily_metrics: [
        { ...OURA_DAY, user_id: 'someone-else' },
        { ...OURA_DAY, tenant_id: 'other-tenant' },
      ],
    });
    const res = await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11'] }, { env: ON, now: NOW });
    expect(res).toEqual({ ok: true, features_written: 0, days: 1, index_recomputed: false });
    expect(db.tables.health_features_daily).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('is idempotent: running twice gives the same rows', async () => {
    const db = createFakeDb({ wearable_daily_metrics: [OURA_DAY] });
    await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11'] }, { env: ON, now: NOW });
    const first = JSON.parse(JSON.stringify(db.tables.health_features_daily));
    await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11'] }, { env: ON, now: NOW });
    expect(db.tables.health_features_daily).toEqual(first);
    expect(first).toHaveLength(7);
  });

  it("never overwrites a member's own diary / voice row, but updates its own earlier bridge row", async () => {
    const diary = {
      tenant_id: T, user_id: U, date: '2026-10-11', feature_key: 'wearable_sleep_duration',
      feature_value: 360, feature_unit: 'min', sample_count: 1, confidence: 0.6,
      metadata: { source: 'diary_extractor' }, updated_at: '2026-10-11T07:00:00.000Z',
    };
    const voice = {
      tenant_id: T, user_id: U, date: '2026-10-11', feature_key: 'wearable_heart_rate',
      feature_value: 70, feature_unit: 'bpm', sample_count: 1, confidence: 1,
      metadata: { source: 'voice_health_log' }, updated_at: '2026-10-11T07:00:00.000Z',
    };
    const oldBridge = {
      tenant_id: T, user_id: U, date: '2026-10-11', feature_key: 'wearable_steps',
      feature_value: 100, feature_unit: 'steps', sample_count: 1, confidence: 0.9,
      metadata: { source: 'wearable_bridge', provider: 'garmin', metric_date: '2026-10-11' }, updated_at: '2026-10-11T05:00:00.000Z',
    };
    const db = createFakeDb({ wearable_daily_metrics: [OURA_DAY], health_features_daily: [diary, voice, oldBridge] });

    await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11'] }, { env: ON, now: NOW });

    const get = (k: string) => db.tables.health_features_daily.find((r) => r.feature_key === k);
    expect(get('wearable_sleep_duration')).toEqual(diary);
    expect(get('wearable_heart_rate')).toEqual(voice);
    expect(get('wearable_steps')).toMatchObject({
      feature_value: 12345,
      metadata: { source: 'wearable_bridge', provider: 'oura', metric_date: '2026-10-11' },
      updated_at: NOW.toISOString(),
    });
    expect(db.tables.health_features_daily).toHaveLength(7);
  });

  it('skips an excluded test/service account: zero writes, zero RPC calls', async () => {
    for (const table of ['service_bot_accounts', 'notification_test_actors']) {
      const db = createFakeDb({ wearable_daily_metrics: [OURA_DAY], [table]: [{ user_id: U }] });
      const res = await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11'] }, { env: ON, now: NOW });
      expect(res).toEqual({ ok: true, skipped: 'excluded_account' });
      expect(db.writes).toHaveLength(0);
      expect(db.client.rpc).not.toHaveBeenCalled();
      expect(db.tables.health_features_daily).toHaveLength(0);
    }
  });

  it('emits one bridged event whose payload carries no numeric health value', async () => {
    const db = createFakeDb({ wearable_daily_metrics: [OURA_DAY] });
    await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11'] }, { env: ON, now: NOW });

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const ev = mockEmit.mock.calls[0][0] as any;
    expect(ev.type).toBe('health.wearable_features.bridged');
    expect(ev.status).toBe('info');
    expect(Object.keys(ev.payload).sort()).toEqual(['dates', 'days', 'feature_keys', 'index_recomputed', 'providers', 'rows_written']);
    expect(ev.payload).toMatchObject({ dates: ['2026-10-11'], providers: ['oura'], rows_written: 7, days: 1 });
    const serialized = JSON.stringify(ev);
    for (const v of [437, 88.5, 52.25, 49.75, 61, 12345, 47.5]) {
      expect(serialized).not.toContain(String(v));
    }
    // The only numbers in the payload are counts.
    for (const [k, v] of Object.entries(ev.payload)) {
      if (typeof v === 'number') expect(['rows_written', 'days']).toContain(k);
    }
  });

  it.each([
    ['wearable_daily_metrics', 'select', 'read_daily_metrics_failed'],
    ['wearable_workouts', 'select', 'read_workouts_failed'],
    ['health_features_daily', 'upsert', 'insert_features_failed'],
    ['health_features_daily', 'update', 'update_features_failed'],
  ])('on a %s %s error emits bridge_failed with %s and still resolves', async (table, op, code) => {
    const db = createFakeDb({ wearable_daily_metrics: [OURA_DAY] });
    db.failOn.table = table;
    db.failOn.op = op;
    const res = await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11'] }, { env: ON, now: NOW });
    expect(res).toEqual({ ok: false, error_code: code });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const ev = mockEmit.mock.calls[0][0] as any;
    expect(ev.type).toBe('health.wearable_features.bridge_failed');
    expect(ev.status).toBe('error');
    expect(ev.payload).toEqual({ error_code: code, dates: ['2026-10-11'], days: 1 });
  });

  it('on an Index RPC error emits bridge_failed (index_recompute_failed) and still resolves', async () => {
    const db = createFakeDb({ wearable_daily_metrics: [OURA_DAY] });
    db.failOn.rpc = true;
    const res = await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11'] }, { env: ON, now: NOW });
    expect(res).toEqual({ ok: false, error_code: 'index_recompute_failed' });
    expect((mockEmit.mock.calls[0][0] as any).type).toBe('health.wearable_features.bridge_failed');
  });

  it('a thrown client error resolves with error_code "exception", and a failing OASIS emit never throws', async () => {
    const db = createFakeDb({ wearable_daily_metrics: [OURA_DAY] });
    db.client.rpc.mockImplementationOnce(() => { throw new Error('socket hang up value=437'); });
    mockEmit.mockRejectedValueOnce(new Error('oasis down'));
    const res = await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['2026-10-11'] }, { env: ON, now: NOW });
    expect(res).toEqual({ ok: false, error_code: 'exception' });
    expect(JSON.stringify(mockEmit.mock.calls[0][0])).not.toContain('437');
  });

  it('ignores malformed dates and does nothing without a valid one', async () => {
    const db = createFakeDb({ wearable_daily_metrics: [OURA_DAY] });
    const res = await bridgeWearableDays(db.client, { tenantId: T, userId: U, dates: ['not-a-date', ''] }, { env: ON, now: NOW });
    expect(res).toEqual({ ok: true, skipped: 'no_dates' });
    expect(db.client.from).not.toHaveBeenCalled();
  });
});
