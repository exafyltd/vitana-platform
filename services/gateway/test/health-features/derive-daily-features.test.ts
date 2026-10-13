/**
 * VTID-05162 (Health Hub Phase 1 / B2) — Change 8: deriveFeatures (pure,
 * golden fixtures), deriveAndStore (replace semantics, failure safety, the
 * pending marker), rederiveMemberFeatures through A's change hook (S8) after
 * a withdrawal and after a committed deletion, the nightly catch-up and the
 * nightly "previous 2 days" pass. Store reads go through the S10 fake's real
 * reader (S4); B2's tables are an in-memory repository. No database, no network.
 */
import { randomUUID } from 'crypto';
import { createFakeHealthStore, type FakeHealthStore } from '../../src/services/health-store/testing/fake-health-store';
import type { DailyObservationRow } from '../../src/services/health-store/reader';
import {
  deriveAndStore,
  deriveFeatures,
  registerHealthFeaturesDerivation,
  rederiveMemberFeatures,
  runFeatureDerivationCatchUp,
  runNightlyFeatureDerivation,
  type DerivationDeps,
} from '../../src/services/health-features/derive-daily-features';
import { DERIVED_FEATURE_KEYS, FEATURE_SPEC } from '../../src/services/health-features/feature-spec';
import { createMemoryFeaturesRepo, type MemoryFeaturesRepo } from './memory-features-repo';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ME = { tenant_id: '10000000-0000-0000-0000-000000000001', user_id: 'a0000000-0000-0000-0000-00000000000a' };
const DAY = '2026-10-12';
const midnight = (d: string) => `${d}T00:00:00.000Z`;

const row = (date: string, code: string, unit: string, sources: Array<[string, number | null, number?]>): DailyObservationRow => ({
  date,
  code,
  value: sources[0]?.[1] ?? null,
  unit,
  sample_count: sources[0]?.[2] ?? 1,
  updated_at: NOW.toISOString(),
  sources: sources.map(([kind, value, n], i) => ({ source_id: `s${i}`, source_kind: kind, value, sample_count: n ?? 1 })),
});

describe('deriveFeatures — golden fixtures (VTID-05162)', () => {
  it('a device day (webhook writer) gives the seven device keys with D6a-compatible units', () => {
    const out = deriveFeatures([
      row(DAY, 'steps', '{steps}', [['device_cloud', 8123]]),
      row(DAY, 'sleep_session', 'min', [['device_cloud', 431]]),
      row(DAY, 'sleep_efficiency', '%', [['device_cloud', 91]]),
      row(DAY, 'hrv_rmssd', 'ms', [['device_cloud', 48]]),
      row(DAY, 'resting_heart_rate', '/min', [['device_cloud', 54]]),
      row(DAY, 'vo2_max', 'mL/kg/min', [['device_cloud', 44]]),
      row(DAY, 'workout', 'min', [['device_cloud', 75, 2]]),
    ]);
    const byKey = Object.fromEntries(out.map((f) => [f.feature_key, f]));
    expect(Object.keys(byKey).sort()).toEqual(['vo2_max', 'wearable_heart_rate', 'wearable_hrv', 'wearable_sleep_duration', 'wearable_sleep_efficiency', 'wearable_steps', 'wearable_workout']);
    expect(byKey.wearable_steps).toMatchObject({ feature_value: 8123, feature_unit: 'steps', source_kinds: ['device_cloud'], confidence: 0.9 });
    expect(byKey.wearable_workout).toMatchObject({ feature_value: 2, feature_unit: 'count', sample_count: 2 });
    expect(byKey.wearable_heart_rate).toMatchObject({ feature_value: 54, feature_unit: 'bpm' });
  });

  it('a self-logged day (diary / voice / manual / ORB) gives the self-logged keys', () => {
    const out = deriveFeatures([
      row(DAY, 'water_intake', 'mL', [['voice', 750]]),
      row(DAY, 'meal', '{meal}', [['voice', 2, 2], ['diary', 1, 1]]),
      row(DAY, 'meditation_minutes', 'min', [['diary', 10]]),
      row(DAY, 'mood', '{score}', [['voice', 4]]),
      row(DAY, 'workout', 'min', [['manual', 30]]),
    ]);
    const byKey = Object.fromEntries(out.map((f) => [f.feature_key, f]));
    expect(byKey.water_intake).toMatchObject({ feature_value: 750, feature_unit: 'ml', confidence: 0.85 });
    // count keys sum across sources
    expect(byKey.meal_log).toMatchObject({ feature_value: 3, sample_count: 3, source_kinds: ['diary', 'voice'] });
    expect(byKey.meditation_minutes.feature_value).toBe(10);
    expect(byKey.mood_entry.feature_value).toBe(4);
    expect(byKey.wearable_workout.feature_value).toBe(1);
  });

  it('member-stated beats device for value keys, whatever S4 ranked first', () => {
    const [sleep] = deriveFeatures([row(DAY, 'sleep_session', 'min', [['device_cloud', 400, 1], ['voice', 420, 1]])]);
    expect(sleep).toMatchObject({ feature_key: 'wearable_sleep_duration', feature_value: 420, sample_count: 2, source_kinds: ['device_cloud', 'voice'], confidence: 0.85 });
  });

  it('drops implausible values (D6a bounds), never clamps, and falls through to the next code', () => {
    // resting HR 22 passes the store (20..200) but not D6a (25..220); heart_rate 61 is the next code.
    const out = deriveFeatures([
      row(DAY, 'resting_heart_rate', '/min', [['device_cloud', 22]]),
      row(DAY, 'heart_rate', '/min', [['device_cloud', 61]]),
      row(DAY, 'sleep_session', 'min', [['device_cloud', 0]]),
    ]);
    expect(out).toEqual([expect.objectContaining({ feature_key: 'wearable_heart_rate', feature_value: 61 })]);
  });

  it('prefers the first code of the spec within a class (resting HR over the heart-rate series)', () => {
    const [hr] = deriveFeatures([row(DAY, 'heart_rate', '/min', [['device_cloud', 70]]), row(DAY, 'resting_heart_rate', '/min', [['device_cloud', 52]])]);
    expect(hr.feature_value).toBe(52);
  });

  it('never produces a key without a code, and nothing from codes it does not read', () => {
    const out = deriveFeatures([
      row(DAY, 'body_weight', 'kg', [['voice', 80]]),
      row(DAY, 'active_energy', 'kcal', [['device_cloud', 500]]),
      row(DAY, 'distance', 'm', [['device_cloud', 4000]]),
    ]);
    expect(out).toEqual([]);
    const never = FEATURE_SPEC.filter((s) => s.codes === null).map((s) => s.feature_key);
    expect(never.sort()).toEqual(['biomarker_glucose', 'biomarker_hba1c', 'hydration_log', 'journal_entry', 'macro_balance', 'wearable_sleep_stages', 'wearable_stress']);
    for (const k of never) expect(DERIVED_FEATURE_KEYS).not.toContain(k);
  });

  it('a garbage input gives no rows and no exception', () => {
    expect(deriveFeatures([null as never, { date: 1 } as never])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

let store: FakeHealthStore;
let repo: MemoryFeaturesRepo;
let deps: DerivationDeps;
let oura: string;
let events: string[];

function makeDeps(env: NodeJS.ProcessEnv = {}): DerivationDeps {
  return {
    read: (identity, o) => store.readDailyObservations(null, identity, o),
    repo,
    now: () => NOW,
    env,
    emit: async (e) => {
      events.push(e.type);
      return { ok: true };
    },
    log: () => undefined,
  };
}

async function deviceWrite(samples: Array<{ id: string; code: string; unit: string; start: string; value?: number; stats?: { n: number; sum: number; min: number; max: number } }>, deletions: Array<{ source_record_id: string; code: string }> = []) {
  const r = await store.writeHealthSamples(null, {
    identity: ME,
    source_id: oura,
    batch_id: randomUUID(),
    via: 'internal',
    tz: 'UTC',
    samples: samples.map((s) => ({ source_record_id: s.id, code: s.code, unit: s.unit, start: s.start, value: s.value, stats: s.stats })),
    deletions,
  });
  expect(r.ok).toBe(true);
  return r;
}

beforeEach(() => {
  store = createFakeHealthStore({ clock: () => NOW });
  oura = store.addSource({ ...ME, kind: 'device_cloud', connector_id: 'oura' });
  store.grantConsent(ME, 'wearables', 'oura');
  repo = createMemoryFeaturesRepo();
  events = [];
  deps = makeDeps();
});

describe('deriveAndStore (VTID-05162)', () => {
  it('reads S4 with purpose feature_compute and tz UTC, writes v2 rows stamped derived_v2, clears the marker', async () => {
    await deviceWrite([
      { id: 'steps:a', code: 'steps', unit: '{steps}', start: midnight(DAY), value: 9000 },
      { id: 'sleep-1', code: 'sleep_session', unit: 'min', start: midnight(DAY), value: 420 },
    ]);
    await repo.upsertPending([{ ...ME, date: DAY, enqueued_at: NOW.toISOString() }]);
    const reads: unknown[] = [];
    const spy: DerivationDeps = { ...deps, read: (i, o) => (reads.push(o), deps.read(i, o)) };
    const res = await deriveAndStore(spy, ME, [DAY]);
    expect(res).toEqual({ ok: true, dates: 1, upserted: 2, deleted: 0 });
    expect(reads).toEqual([expect.objectContaining({ purpose: 'feature_compute', tz: 'UTC', from: DAY, to: DAY })]);
    const rows = Array.from(repo.v2.values());
    expect(rows.map((r) => r.feature_key).sort()).toEqual(['wearable_sleep_duration', 'wearable_steps']);
    for (const r of rows) {
      expect(r).toMatchObject({ derivation_version: 'b2.1', source_kinds: ['device_cloud'], metadata: expect.objectContaining({ source: 'derived_v2' }) });
    }
    expect(repo.pending.size).toBe(0);
  });

  it('replaces a date: v2 rows the store no longer supports are deleted', async () => {
    await deviceWrite([{ id: 'sleep-1', code: 'sleep_session', unit: 'min', start: midnight(DAY), value: 420 }]);
    await repo.upsertFeaturesV2([{ ...ME, date: DAY, feature_key: 'wearable_steps', feature_value: 1, feature_unit: 'steps', sample_count: 1, confidence: 0.9, metadata: {}, derivation_version: 'b2.1', source_kinds: ['device_cloud'], updated_at: NOW.toISOString() }]);
    const res = await deriveAndStore(deps, ME, [DAY]);
    expect(res).toMatchObject({ ok: true, upserted: 1, deleted: 1 });
    expect(Array.from(repo.v2.values()).map((r) => r.feature_key)).toEqual(['wearable_sleep_duration']);
  });

  it('writes and deletes nothing when the store cannot be read, and keeps the marker', async () => {
    await repo.upsertFeaturesV2([{ ...ME, date: DAY, feature_key: 'wearable_steps', feature_value: 1, feature_unit: 'steps', sample_count: 1, confidence: 0.9, metadata: {}, derivation_version: 'b2.1', source_kinds: [], updated_at: NOW.toISOString() }]);
    await repo.upsertPending([{ ...ME, date: DAY, enqueued_at: NOW.toISOString() }]);
    store.setEnabled(false);
    expect(await deriveAndStore(deps, ME, [DAY])).toEqual({ ok: false, code: 'STORE_DISABLED' });
    expect(repo.v2.size).toBe(1);
    expect(repo.pending.size).toBe(1);
  });

  it('answers FEATURES_STORE_PENDING while B2 tables are absent, never throws on a throwing repository', async () => {
    repo.fail.listFeaturesV2Keys = 'missing';
    expect(await deriveAndStore(deps, ME, [DAY])).toEqual({ ok: false, code: 'FEATURES_STORE_PENDING' });
    repo.fail.listFeaturesV2Keys = 'throw';
    expect(await deriveAndStore(deps, ME, [DAY])).toEqual({ ok: false, code: 'THREW' });
  });

  it('is a no-op on staging and refuses a bad identity', async () => {
    expect(await deriveAndStore(makeDeps({ VITANA_ENV: 'staging' }), ME, [DAY])).toEqual({ ok: false, code: 'STAGING' });
    expect(await deriveAndStore(deps, { tenant_id: '', user_id: ME.user_id }, [DAY])).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(repo.calls).toEqual([]);
  });

  it('derives dates spread over more than a year in separate S4 windows', async () => {
    const reads: Array<{ from: string; to: string }> = [];
    const spy: DerivationDeps = { ...deps, read: (i, o) => (reads.push({ from: o.from, to: o.to }), deps.read(i, o)) };
    const res = await deriveAndStore(spy, ME, ['2025-08-01', DAY, 'not-a-date']);
    expect(res).toMatchObject({ ok: true, dates: 2 });
    expect(reads).toEqual([{ from: '2025-08-01', to: '2025-08-01' }, { from: DAY, to: DAY }]);
  });
});

describe('rederiveMemberFeatures through the S8 change hook (VTID-05162)', () => {
  beforeEach(() => {
    store.registerHealthStoreChangeHook((identity, change) => rederiveMemberFeatures(deps, identity, change).then(() => undefined));
  });

  it('a withdrawal (suppress, no dates) deletes the v2 rows whose observations were withdrawn', async () => {
    await deviceWrite([
      { id: 'sleep-1', code: 'sleep_session', unit: 'min', start: midnight(DAY), value: 420 },
      { id: 'steps:a', code: 'steps', unit: '{steps}', start: midnight(DAY), value: 9000 },
    ]);
    await deriveAndStore(deps, ME, [DAY]);
    expect(repo.v2.size).toBe(2);
    const s = await store.suppressHealthData(null, ME, { category: 'sleep' });
    expect(s.ok).toBe(true);
    await store.flushHooks();
    expect(Array.from(repo.v2.values()).map((r) => r.feature_key)).toEqual(['wearable_steps']);
    await store.unsuppressHealthData(null, ME, { category: 'sleep' });
    await store.flushHooks();
    expect(Array.from(repo.v2.values()).map((r) => r.feature_key).sort()).toEqual(['wearable_sleep_duration', 'wearable_steps']);
  });

  it('a committed deletion (with dates) re-derives that day', async () => {
    await deviceWrite([{ id: 'w1', code: 'workout', unit: 'min', start: midnight(DAY), value: 30 }]);
    await deriveAndStore(deps, ME, [DAY]);
    expect(repo.v2.size).toBe(1);
    await deviceWrite([], [{ source_record_id: 'w1', code: 'workout' }]);
    await store.flushHooks();
    expect(repo.v2.size).toBe(0);
  });

  it('a failing re-derivation is logged and never throws into the store', async () => {
    repo.fail.listFeaturesV2Dates = 'throw';
    await expect(rederiveMemberFeatures(deps, ME, {})).resolves.toEqual({ ok: false, code: 'THREW' });
    expect(await rederiveMemberFeatures(makeDeps({ VITANA_ENV: 'staging' }), ME, { dates: [DAY] })).toEqual({ ok: false, code: 'STAGING' });
  });

  it('registerHealthFeaturesDerivation registers once (idempotent) and the hook is a no-op without a client', async () => {
    const registered: Array<(i: typeof ME, c: object) => Promise<void>> = [];
    const off = jest.fn();
    const register = ((fn: (i: typeof ME, c: object) => Promise<void>) => (registered.push(fn), off)) as never;
    const unregister = registerHealthFeaturesDerivation(register, () => null);
    expect(registerHealthFeaturesDerivation(register, () => null)).toBe(unregister);
    expect(registered).toHaveLength(1);
    await expect(registered[0](ME, {})).resolves.toBeUndefined();
    unregister();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe('nightly passes (VTID-05162)', () => {
  const ON = { HEALTH_STORE_DUAL_WRITE_DEVICE: 'true' };

  it('the catch-up derives markers older than 5 minutes only, and reports counts on OASIS', async () => {
    await deviceWrite([{ id: 'sleep-1', code: 'sleep_session', unit: 'min', start: midnight(DAY), value: 420 }]);
    const old = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    await repo.upsertPending([{ ...ME, date: DAY, enqueued_at: old }, { ...ME, date: '2026-10-13', enqueued_at: NOW.toISOString() }]);
    const d = makeDeps(ON);
    const res = await runFeatureDerivationCatchUp(d);
    expect(res).toEqual({ markers_found: 1, members: 1, derived_members: 1, failed_members: 0 });
    expect(repo.v2.size).toBe(1);
    expect(Array.from(repo.pending.values()).map((p) => p.date)).toEqual(['2026-10-13']);
    expect(events).toEqual(['health.features.derivation_catch_up']);
  });

  it('a failed catch-up keeps the marker and counts an attempt', async () => {
    const old = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    await repo.upsertPending([{ ...ME, date: DAY, enqueued_at: old }]);
    store.setEnabled(false);
    const res = await runFeatureDerivationCatchUp(makeDeps(ON));
    expect(res.failed_members).toBe(1);
    expect(Array.from(repo.pending.values())[0].attempts).toBe(1);
  });

  it('both passes are off without a dual-write flag and on staging', async () => {
    for (const env of [{}, { ...ON, VITANA_ENV: 'staging' }]) {
      expect(await runFeatureDerivationCatchUp(makeDeps(env))).toMatchObject({ skipped: 'disabled' });
      expect(await runNightlyFeatureDerivation(makeDeps(env), { tenant_id: ME.tenant_id, user_ids: [ME.user_id], run_date: '2026-10-13' })).toMatchObject({ skipped: 'disabled' });
    }
    expect(repo.calls).toEqual([]);
  });

  it('the nightly pass derives the previous 2 days per user and stops at its budget', async () => {
    await deviceWrite([{ id: 'sleep-1', code: 'sleep_session', unit: 'min', start: midnight('2026-10-11'), value: 420 }]);
    const reads: Array<{ from: string; to: string }> = [];
    const d = makeDeps(ON);
    const spy: DerivationDeps = { ...d, read: (i, o) => (reads.push({ from: o.from, to: o.to }), d.read(i, o)) };
    const res = await runNightlyFeatureDerivation(spy, { tenant_id: ME.tenant_id, user_ids: [ME.user_id], run_date: '2026-10-13' });
    expect(res).toEqual({ derived: 1, failed: 0, skipped_budget: 0 });
    expect(reads).toEqual([{ from: '2026-10-11', to: '2026-10-12' }]);
    expect(repo.v2.size).toBe(1);
    const capped = await runNightlyFeatureDerivation(spy, { tenant_id: ME.tenant_id, user_ids: ['u1', 'u2'], run_date: '2026-10-13', budget_ms: -1 });
    expect(capped).toEqual({ derived: 0, failed: 0, skipped_budget: 2 });
  });
});
