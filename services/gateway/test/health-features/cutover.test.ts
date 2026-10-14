/**
 * VTID-05163 (Health Hub Phase 1 / B3) — the cutover switch (plan Change 13):
 * the switch itself (default legacy, unknown = legacy, staging forced off, C
 * required), which writers and keys each mode covers, persistFeatureRow
 * (legacy: the writer's own call, untouched; derived: the shadow),
 * deriveAndStore target 'live' (publishes the mode's keys for dates >= C,
 * insert-only + update only derived rows, stale derived rows deleted, a
 * member's own row never overwritten), and recordToHealthStore `cutover: true`
 * (synchronous, fatal) — over the S10 fake store (real ingest, real reader).
 */
import { createFakeHealthStore, type FakeHealthStore } from '../../src/services/health-store/testing/fake-health-store';
import {
  bridgeShadowWriter,
  cutoverKeys,
  cutoverWriters,
  derivationTargetFor,
  getHealthFeaturesCutover,
  isFeatureSqlCutOver,
  isFeatureWriteCutOver,
  isWearableBridgeCutOver,
  isWriterCutOver,
  persistFeatureRow,
  readFeatureValueForWrite,
} from '../../src/services/health-features/cutover';
import { deriveAndStore, rederiveMemberFeatures, type DerivationDeps } from '../../src/services/health-features/derive-daily-features';
import { DEVICE_FEATURE_KEYS, DERIVED_FEATURE_KEYS, writerValuesForDailyMetrics } from '../../src/services/health-features/feature-spec';
import { recordToHealthStore, resetHealthStoreDualWriteCounters, type RecordDeps } from '../../src/services/health-features/record-to-health-store';
import { createMemoryFeaturesRepo, type MemoryFeaturesRepo } from './memory-features-repo';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ME = { tenant_id: '10000000-0000-0000-0000-000000000001', user_id: 'a0000000-0000-0000-0000-00000000000a' };
const C = '2026-10-10';
const DEVICE_ON = { HEALTH_STORE_DUAL_WRITE_DEVICE: 'true' };
const SELF_ON = { HEALTH_STORE_DUAL_WRITE_SELF_LOGGED: 'true' };
const DERIVED_DEVICE = { HEALTH_FEATURES_SOURCE: 'derived_device', HEALTH_FEATURES_CUTOVER_DATE: C };
const DERIVED = { HEALTH_FEATURES_SOURCE: 'derived', HEALTH_FEATURES_CUTOVER_DATE: C };
const LEGACY_CONN = 'c0000000-0000-0000-0000-00000000000c';
const sb = {} as never;

describe('the switch (Change 13)', () => {
  it('is legacy by default, for any unknown value, on staging, and without a valid cutover date', () => {
    expect(getHealthFeaturesCutover({})).toEqual({ source: 'legacy', cutover_date: null, reason: 'unset' });
    expect(getHealthFeaturesCutover({ HEALTH_FEATURES_SOURCE: 'legacy' }).source).toBe('legacy');
    for (const v of ['Derived', 'DERIVED_DEVICE', 'true', 'derived ', 'v2']) {
      expect(getHealthFeaturesCutover({ HEALTH_FEATURES_SOURCE: v, HEALTH_FEATURES_CUTOVER_DATE: C })).toEqual({ source: 'legacy', cutover_date: null, reason: 'unknown_value' });
    }
    expect(getHealthFeaturesCutover({ ...DERIVED, VITANA_ENV: 'staging' })).toEqual({ source: 'legacy', cutover_date: null, reason: 'staging' });
    for (const d of [undefined, '', '2026-13-01', '2026-02-30', '10/10/2026']) {
      expect(getHealthFeaturesCutover({ HEALTH_FEATURES_SOURCE: 'derived', HEALTH_FEATURES_CUTOVER_DATE: d }).reason).toBe('cutover_date_missing');
    }
    expect(getHealthFeaturesCutover(DERIVED_DEVICE)).toEqual({ source: 'derived_device', cutover_date: C });
    expect(getHealthFeaturesCutover(DERIVED)).toEqual({ source: 'derived', cutover_date: C });
  });

  it('derived_device covers the device writers and the seven device keys; derived every writer and every coded key', () => {
    expect([...cutoverWriters('derived_device')].sort()).toEqual(['manual_workout', 'webhook_daily', 'webhook_workout']);
    expect(cutoverWriters('derived')).toHaveLength(9);
    expect(cutoverWriters('legacy')).toEqual([]);
    expect(cutoverKeys('derived_device')).toEqual(DEVICE_FEATURE_KEYS);
    expect(cutoverKeys('derived')).toEqual(DERIVED_FEATURE_KEYS);
    expect(cutoverKeys('derived')).not.toEqual(expect.arrayContaining(['biomarker_glucose']));
    expect(cutoverKeys('legacy')).toEqual([]);
  });

  it('a writer is cut over only when its mode covers it AND its own dual-write flag is on', () => {
    expect(isWriterCutOver('webhook_daily', DERIVED_DEVICE)).toBe(false); // device dual-write off
    expect(isWriterCutOver('webhook_daily', { ...DERIVED_DEVICE, ...DEVICE_ON })).toBe(true);
    expect(isWriterCutOver('voice', { ...DERIVED_DEVICE, ...DEVICE_ON, ...SELF_ON })).toBe(false); // self-logged stays legacy
    expect(isWriterCutOver('voice', { ...DERIVED, ...SELF_ON })).toBe(true);
    expect(isWriterCutOver('voice', { ...DERIVED, ...SELF_ON, VITANA_ENV: 'staging' })).toBe(false);
    expect(isFeatureWriteCutOver('voice', 'water_intake', '2026-10-12', { ...DERIVED, ...SELF_ON })).toBe(true);
    expect(isFeatureWriteCutOver('voice', 'water_intake', '2026-10-09', { ...DERIVED, ...SELF_ON })).toBe(false); // before C
    expect(isFeatureWriteCutOver('manual', 'biomarker_glucose', '2026-10-12', { ...DERIVED, ...SELF_ON })).toBe(false); // no code
    expect(isFeatureWriteCutOver('diary', 'journal_entry', '2026-10-12', { ...DERIVED, ...SELF_ON })).toBe(false);
    expect(isWearableBridgeCutOver({ ...DERIVED_DEVICE, ...DEVICE_ON })).toBe(true);
    expect(isWearableBridgeCutOver(DERIVED_DEVICE)).toBe(false);
    expect(isFeatureSqlCutOver({ ...DERIVED_DEVICE, ...DEVICE_ON })).toBe(false);
    expect(isFeatureSqlCutOver(DERIVED)).toBe(false); // dual-write off
    expect(isFeatureSqlCutOver({ ...DERIVED, ...DEVICE_ON, ...SELF_ON })).toBe(true);
    expect(derivationTargetFor({})).toBe('v2');
    expect(derivationTargetFor(DERIVED)).toBe('live');
  });
});

describe('persistFeatureRow / readFeatureValueForWrite', () => {
  const row = { tenant_id: ME.tenant_id, user_id: ME.user_id, date: '2026-10-12', feature_key: 'water_intake', feature_value: 500, metadata: { source: 'voice_tool' } };

  it('legacy: runs the writer\'s own write and returns its result untouched; the shadow is never touched', async () => {
    const repo = createMemoryFeaturesRepo();
    for (const env of [{}, { ...DERIVED, VITANA_ENV: 'staging', ...SELF_ON }, DERIVED /* self dual-write off */]) {
      const err = { message: 'boom', code: '23505' };
      const legacyWrite = jest.fn(async () => ({ error: err }));
      const res = await persistFeatureRow(sb, 'voice', row, legacyWrite, { env, repo });
      expect(legacyWrite).toHaveBeenCalledTimes(1);
      expect(res).toEqual({ error: err, cutover: false });
      expect(res.error).toBe(err);
    }
    const thrower = jest.fn(async () => {
      throw new Error('legacy throws');
    });
    await expect(persistFeatureRow(sb, 'voice', row, thrower, { env: {}, repo })).rejects.toThrow('legacy throws');
    expect(repo.calls).toEqual([]);
  });

  it('derived: the same row goes to the shadow, health_features_daily is not written', async () => {
    const repo = createMemoryFeaturesRepo();
    const legacyWrite = jest.fn();
    const res = await persistFeatureRow(sb, 'voice', row, legacyWrite, { env: { ...DERIVED, ...SELF_ON }, repo });
    expect(res).toEqual({ error: null, cutover: true });
    expect(legacyWrite).not.toHaveBeenCalled();
    expect(Array.from(repo.shadow.values())).toEqual([row]);
    repo.fail.upsertLegacyShadow = 'missing';
    expect(await persistFeatureRow(sb, 'voice', row, legacyWrite, { env: { ...DERIVED, ...SELF_ON }, repo }))
      .toEqual({ error: { message: 'legacy_shadow_write_failed: FEATURES_STORE_PENDING' }, cutover: true });
    repo.fail.upsertLegacyShadow = 'throw';
    expect((await persistFeatureRow(sb, 'voice', row, legacyWrite, { env: { ...DERIVED, ...SELF_ON }, repo })).cutover).toBe(true);
  });

  it('log_meal\'s running count is read from the shadow when cut over, else by the writer', async () => {
    const repo = createMemoryFeaturesRepo();
    await repo.upsertLegacyShadow([{ ...row, feature_key: 'meal_log', feature_value: 2 }]);
    const legacyRead = jest.fn(async () => ({ data: { feature_value: 9 }, error: null }));
    const key = { tenant_id: ME.tenant_id, user_id: ME.user_id, date: '2026-10-12', feature_key: 'meal_log' };
    expect(await readFeatureValueForWrite(sb, 'orb_meal', key, legacyRead, { env: {}, repo })).toEqual({ data: { feature_value: 9 }, error: null });
    expect(await readFeatureValueForWrite(sb, 'orb_meal', key, legacyRead, { env: { ...DERIVED, ...SELF_ON }, repo })).toEqual({ data: { feature_value: 2 }, error: null });
    expect(legacyRead).toHaveBeenCalledTimes(1);
  });

  it('the bridge shadow writer keeps the bridge\'s own rules (insert-only, update only bridge rows)', async () => {
    const repo = createMemoryFeaturesRepo();
    await repo.upsertLegacyShadow([{ ...row, feature_key: 'wearable_steps', feature_value: 1, metadata: { source: 'voice_tool' } }]);
    const w = bridgeShadowWriter(sb, repo);
    const bridgeRow = { ...row, feature_key: 'wearable_steps', feature_value: 8000, metadata: { source: 'wearable_bridge' } };
    await w.insertIgnoringExisting([bridgeRow, { ...bridgeRow, feature_key: 'wearable_hrv', feature_value: 40 }]);
    await w.updateBridgeOwned(bridgeRow);
    await w.updateBridgeOwned({ ...bridgeRow, feature_key: 'wearable_hrv', feature_value: 41 });
    expect(Array.from(repo.shadow.values()).map((r) => [r.feature_key, r.feature_value]).sort()).toEqual([['wearable_hrv', 41], ['wearable_steps', 1]]);
  });
});

// ---------------------------------------------------------------------------
// deriveAndStore target 'live' and recordToHealthStore cutover, over the fake store
// ---------------------------------------------------------------------------

let store: FakeHealthStore;
let repo: MemoryFeaturesRepo;
let oura: string;
let ids: number;

function derivation(env: NodeJS.ProcessEnv): DerivationDeps {
  return { read: (identity, o) => store.readDailyObservations(null, identity, o), repo, now: () => NOW, env, emit: async () => ({ ok: true }), log: () => undefined };
}

function recordDeps(env: NodeJS.ProcessEnv, scheduled: Array<() => Promise<unknown>>, over: Partial<RecordDeps> = {}): Partial<RecordDeps> {
  return {
    env,
    storeStatus: () => store.deps.status(),
    resolveSelfLogged: async (identity, kind) => ({ ok: true, source_id: store.addSource({ ...identity, kind }), kind, connector_id: null, status: 'connected' }),
    resolveDevice: async (_i, legacyId) =>
      legacyId === LEGACY_CONN ? { ok: true, source_id: oura, kind: 'device_cloud', connector_id: 'oura', status: 'connected' } : { ok: false, code: 'SOURCE_NOT_CONNECTED' },
    write: (input) => store.writeHealthSamples(null, input),
    repo,
    derivation: derivation(env),
    schedule: (fn) => {
      scheduled.push(fn);
    },
    emit: async () => ({ ok: true }),
    now: () => NOW,
    log: () => undefined,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    ...over,
  };
}

const liveKeys = () => Array.from(repo.live.values()).map((r) => `${r.date}|${r.feature_key}|${r.feature_value}|${(r.metadata as { source?: string }).source}`).sort();

beforeEach(() => {
  store = createFakeHealthStore({ clock: () => NOW });
  oura = store.addSource({ ...ME, kind: 'device_cloud', connector_id: 'oura' });
  store.grantConsent(ME, 'wearables', 'oura');
  repo = createMemoryFeaturesRepo();
  ids = 0;
  resetHealthStoreDualWriteCounters();
});

async function writeDevice(date: string, metrics: Record<string, unknown>) {
  const env = { ...DEVICE_ON };
  const r = await recordToHealthStore(sb, ME, 'webhook_daily', writerValuesForDailyMetrics(metrics, date), { legacy_user_connection_id: LEGACY_CONN }, recordDeps(env, []));
  expect(r.ok).toBe(true);
}

describe('deriveAndStore target live (Change 13)', () => {
  it('answers CUTOVER_OFF with the switch off and touches nothing', async () => {
    await writeDevice('2026-10-12', { steps: 9000 });
    expect(await deriveAndStore(derivation({}), ME, ['2026-10-12'], 'live')).toEqual({ ok: false, code: 'CUTOVER_OFF' });
    expect(await deriveAndStore(derivation({ ...DERIVED, VITANA_ENV: 'staging' }), ME, ['2026-10-12'], 'live')).toEqual({ ok: false, code: 'STAGING' });
    expect(repo.live.size).toBe(0);
  });

  it('target v2 never touches health_features_daily, whatever the switch says', async () => {
    await writeDevice('2026-10-12', { steps: 9000 });
    const res = await deriveAndStore(derivation({ ...DERIVED_DEVICE, ...DEVICE_ON }), ME, ['2026-10-12'], 'v2');
    expect(res).toEqual({ ok: true, dates: 1, upserted: 1, deleted: 0 });
    expect(repo.live.size).toBe(0);
    expect(repo.calls.filter((c) => /Live/.test(c))).toEqual([]);
  });

  it('publishes only the mode\'s keys and only dates >= C; insert-only, never over a member\'s own row; updates its own rows; deletes stale ones', async () => {
    const env = { ...DERIVED_DEVICE, ...DEVICE_ON };
    await writeDevice('2026-10-09', { steps: 5000 }); // before C
    await writeDevice('2026-10-11', { steps: 6000, sleep_minutes: 400 });
    await writeDevice('2026-10-12', { steps: 7000, hrv_rmssd_ms: 40 });
    // a member's own row for a device key on a published day, and a non-derived self-logged row
    repo.live.set(`${ME.tenant_id}|${ME.user_id}|2026-10-12|wearable_hrv`, { ...ME, date: '2026-10-12', feature_key: 'wearable_hrv', feature_value: 55, metadata: { source: 'voice_tool_vitals' } });
    const res = await deriveAndStore(derivation(env), ME, ['2026-10-09', '2026-10-11', '2026-10-12'], 'live');
    expect(res).toMatchObject({ ok: true, dates: 3, published: 4, unpublished: 0 });
    expect(liveKeys()).toEqual([
      '2026-10-11|wearable_sleep_duration|400|derived_v2',
      '2026-10-11|wearable_steps|6000|derived_v2',
      '2026-10-12|wearable_hrv|55|voice_tool_vitals',
      '2026-10-12|wearable_steps|7000|derived_v2',
    ]);
    // a later write updates the derived row; a withdrawn value removes it
    await writeDevice('2026-10-11', { steps: 6500 });
    await deriveAndStore(derivation(env), ME, ['2026-10-11'], 'live');
    expect(liveKeys()).toContain('2026-10-11|wearable_steps|6500|derived_v2');
  });

  it('derived mode publishes coded self-logged keys too, never biomarkers or keys without a code', async () => {
    const env = { ...DERIVED, ...DEVICE_ON };
    await writeDevice('2026-10-12', { steps: 7000 });
    const res = await deriveAndStore(derivation(env), ME, ['2026-10-12'], 'live');
    expect(res.ok).toBe(true);
    for (const r of repo.live.values()) expect(DERIVED_FEATURE_KEYS).toContain(r.feature_key);
  });

  it('the S8 hook re-derives with target live once a mode is on, and deletes published rows whose data was withdrawn', async () => {
    const env = { ...DERIVED_DEVICE, ...DEVICE_ON };
    await writeDevice('2026-10-12', { steps: 7000 });
    await deriveAndStore(derivation(env), ME, ['2026-10-12'], 'live');
    expect(liveKeys()).toEqual(['2026-10-12|wearable_steps|7000|derived_v2']);
    await store.suppressHealthData(null, ME, { source_id: oura });
    const res = await rederiveMemberFeatures(derivation(env), ME, {});
    expect(res).toMatchObject({ ok: true, unpublished: 1 });
    expect(repo.live.size).toBe(0);
    // switch off: the hook stays on v2 and never touches the live table
    repo.calls.length = 0;
    await rederiveMemberFeatures(derivation({ ...DEVICE_ON }), ME, {});
    expect(repo.calls.filter((c) => /Live/.test(c))).toEqual([]);
  });
});

describe('recordToHealthStore cutover: true (Change 13)', () => {
  const env = { ...DERIVED_DEVICE, ...DEVICE_ON };

  it('writes, marks, derives and publishes synchronously — nothing is scheduled', async () => {
    const scheduled: Array<() => Promise<unknown>> = [];
    const r = await recordToHealthStore(sb, ME, 'webhook_daily', writerValuesForDailyMetrics({ steps: 7000 }, '2026-10-12'),
      { legacy_user_connection_id: LEGACY_CONN, cutover: true }, recordDeps(env, scheduled));
    expect(r).toMatchObject({ ok: true, dates: ['2026-10-12'], marker: 'written' });
    expect(scheduled).toHaveLength(0);
    expect(liveKeys()).toEqual(['2026-10-12|wearable_steps|7000|derived_v2']);
    expect(repo.pending.size).toBe(0); // the derivation cleared the marker
    // a duplicate (same content) still derives its day
    repo.live.clear();
    const again = await recordToHealthStore(sb, ME, 'webhook_daily', writerValuesForDailyMetrics({ steps: 7000 }, '2026-10-12'),
      { legacy_user_connection_id: LEGACY_CONN, cutover: true }, recordDeps(env, scheduled));
    expect(again).toMatchObject({ ok: true, counts: { duplicate: 1 } });
    expect(liveKeys()).toEqual(['2026-10-12|wearable_steps|7000|derived_v2']);
  });

  it('every failure is fatal and returned: store off, no tenant, source, a non-stored sample, the derivation', async () => {
    const vals = writerValuesForDailyMetrics({ steps: 7000 }, '2026-10-12');
    const o = { legacy_user_connection_id: LEGACY_CONN, cutover: true };
    expect(await recordToHealthStore(sb, ME, 'webhook_daily', vals, o, recordDeps(env, [], { storeStatus: () => ({ enabled: false, reason: 'flag_off' }) })))
      .toEqual({ ok: false, code: 'STORE_DISABLED' });
    expect(await recordToHealthStore(sb, { tenant_id: '00000000-0000-0000-0000-000000000000', user_id: ME.user_id }, 'webhook_daily', vals, o, recordDeps(env, [])))
      .toEqual({ ok: false, code: 'NO_TENANT' });
    expect(await recordToHealthStore(sb, ME, 'webhook_daily', vals, { ...o, legacy_user_connection_id: 'other' }, recordDeps(env, [])))
      .toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
    expect(await recordToHealthStore(sb, ME, 'webhook_daily', writerValuesForDailyMetrics({ steps: 7000000 }, '2026-10-12'), o, recordDeps(env, [])))
      .toEqual({ ok: false, code: 'IMPLAUSIBLE' });
    repo.fail.insertLiveIgnoringExisting = 'error';
    expect(await recordToHealthStore(sb, ME, 'webhook_daily', vals, o, recordDeps(env, [])))
      .toEqual({ ok: false, code: 'DERIVATION_FEATURES_STORE_UNAVAILABLE' });
    // the same failures with cutover false stay non-fatal (B2 semantics unchanged)
    expect(await recordToHealthStore(sb, ME, 'webhook_daily', vals, { legacy_user_connection_id: LEGACY_CONN }, recordDeps(env, [], { storeStatus: () => ({ enabled: false, reason: 'flag_off' }) })))
      .toEqual({ ok: true, skipped: 'store_disabled' });
  });

  it('the post-response derivation of a non-cut-over write follows the switch (live once a mode is on)', async () => {
    const scheduled: Array<() => Promise<unknown>> = [];
    await recordToHealthStore(sb, ME, 'webhook_daily', writerValuesForDailyMetrics({ steps: 7000 }, '2026-10-12'),
      { legacy_user_connection_id: LEGACY_CONN }, recordDeps(env, scheduled));
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect(liveKeys()).toEqual(['2026-10-12|wearable_steps|7000|derived_v2']);
    // and with the switch off it stays on v2
    repo.live.clear();
    const s2: Array<() => Promise<unknown>> = [];
    await recordToHealthStore(sb, ME, 'webhook_daily', writerValuesForDailyMetrics({ steps: 7100 }, '2026-10-12'),
      { legacy_user_connection_id: LEGACY_CONN }, recordDeps({ ...DEVICE_ON }, s2));
    await s2[0]();
    expect(repo.live.size).toBe(0);
  });
});
