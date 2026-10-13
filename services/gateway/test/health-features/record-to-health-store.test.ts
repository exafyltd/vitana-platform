/**
 * VTID-05162 (Health Hub Phase 1 / B2) — Change 7: recordToHealthStore over
 * the S10 fake store (real ingest, real reader) and an in-memory B2
 * repository: flags (off / staging = nothing touched), the store flag, the
 * source rules, the source_record_id rules, consent inside A's ingest
 * (skipped_no_consent counted, never fatal), the pending marker before
 * return, the derivation after, failures never thrown, and one golden
 * member-day per writer from writer call to health_features_daily_v2.
 *
 * Self-logged consent: the `self_logged_health` key is C1's (S7) and is not in
 * D10 yet, so A refuses self-logged samples today (asserted below). To prove
 * the self-logged path end to end, the "after C1" block simulates C1's
 * one-map edit by routing diary/voice/manual through a `self_logged_health`
 * consent read (jest.mock of the gate only; ingest and reader stay real).
 */
import { createFakeHealthStore, type FakeHealthStore } from '../../src/services/health-store/testing/fake-health-store';

let simulateC1 = false;
jest.mock('../../src/services/health-store/consent-gate', () => {
  const actual = jest.requireActual('../../src/services/health-store/consent-gate');
  return {
    ...actual,
    gateCategories: async (identity: unknown, source: { kind: string; connector_id: string | null }, categories: Iterable<string>, find: (i: unknown, k: string, r: string | null) => Promise<string | null>) => {
      if (simulateC1 && ['diary', 'voice', 'manual'].includes(source.kind)) {
        const id = await find(identity, 'self_logged_health', null).catch(() => null);
        const out = new Map();
        for (const c of new Set(categories)) out.set(c, id ? { ok: true, consent_id: id } : { ok: false, code: 'CONSENT_REQUIRED' });
        return out;
      }
      return actual.gateCategories(identity, source, categories, find);
    },
  };
});

import {
  getHealthStoreDualWriteCounters,
  recordToHealthStore,
  resetHealthStoreDualWriteCounters,
  sourceRecordIdFor,
  type RecordDeps,
} from '../../src/services/health-features/record-to-health-store';
import type { DerivationDeps } from '../../src/services/health-features/derive-daily-features';
import {
  writerValuesForDailyMetrics,
  writerValuesForFeature,
  type HealthWriterId,
  type WriterValue,
} from '../../src/services/health-features/feature-spec';
import { createMemoryFeaturesRepo, type MemoryFeaturesRepo } from './memory-features-repo';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ME = { tenant_id: '10000000-0000-0000-0000-000000000001', user_id: 'a0000000-0000-0000-0000-00000000000a' };
const DAY = '2026-10-12';
const LEGACY_CONN = 'c0000000-0000-0000-0000-00000000000c';
const DEVICE_ON = { HEALTH_STORE_DUAL_WRITE_DEVICE: 'true' };
const SELF_ON = { HEALTH_STORE_DUAL_WRITE_SELF_LOGGED: 'true' };

let store: FakeHealthStore;
let repo: MemoryFeaturesRepo;
let oura: string;
let scheduled: Array<() => Promise<unknown>>;
let events: string[];
let ids: number;
const sb = {} as never;

function deps(env: NodeJS.ProcessEnv, over: Partial<RecordDeps> = {}): Partial<RecordDeps> {
  const derivation: DerivationDeps = {
    read: (identity, o) => store.readDailyObservations(null, identity, o),
    repo,
    now: () => NOW,
    env,
    emit: async () => ({ ok: true }),
    log: () => undefined,
  };
  return {
    env,
    storeStatus: () => store.deps.status(),
    resolveSelfLogged: async (identity, kind) => {
      const existing = (store as unknown as { __self?: Map<string, string> }).__self ?? new Map<string, string>();
      (store as unknown as { __self?: Map<string, string> }).__self = existing;
      let id = existing.get(kind);
      if (!id) {
        id = store.addSource({ ...identity, kind });
        existing.set(kind, id);
      }
      return { ok: true, source_id: id, kind, connector_id: null, status: 'connected' };
    },
    resolveDevice: async (_identity, legacyId) =>
      legacyId === LEGACY_CONN ? { ok: true, source_id: oura, kind: 'device_cloud', connector_id: 'oura', status: 'connected' } : { ok: false, code: 'SOURCE_NOT_CONNECTED' },
    write: (input) => store.writeHealthSamples(null, input),
    repo,
    derivation,
    schedule: (fn) => {
      scheduled.push(fn);
    },
    emit: async (e) => {
      events.push(e.type);
      return { ok: true };
    },
    now: () => NOW,
    log: () => undefined,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    ...over,
  };
}

async function drain() {
  while (scheduled.length) await scheduled.shift()!();
}

beforeEach(() => {
  store = createFakeHealthStore({ clock: () => NOW });
  oura = store.addSource({ ...ME, kind: 'device_cloud', connector_id: 'oura' });
  store.grantConsent(ME, 'wearables', 'oura');
  repo = createMemoryFeaturesRepo();
  scheduled = [];
  events = [];
  ids = 0;
  simulateC1 = false;
  resetHealthStoreDualWriteCounters();
});

const steps = writerValuesForDailyMetrics({ steps: 9000, sleep_minutes: 420 }, DAY);

describe('flags (VTID-05162)', () => {
  it('flag off: nothing is read or written, no dependency is touched', async () => {
    const touched = jest.fn();
    const trap = new Proxy({}, { get: () => touched });
    for (const env of [{}, { HEALTH_STORE_DUAL_WRITE_DEVICE: 'TRUE' }, { HEALTH_STORE_DUAL_WRITE_SELF_LOGGED: 'true' }]) {
      const r = await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: LEGACY_CONN }, { ...(trap as object), env });
      expect(r).toEqual({ ok: true, skipped: 'flag_off' });
    }
    expect(touched).not.toHaveBeenCalled();
    expect(await recordToHealthStore(sb, ME, 'diary', [], {}, { env: DEVICE_ON })).toEqual({ ok: true, skipped: 'flag_off' });
  });

  it('staging forces both flags off whatever they say', async () => {
    const env = { ...DEVICE_ON, ...SELF_ON, VITANA_ENV: 'staging' };
    for (const w of ['webhook_daily', 'manual_workout', 'diary', 'voice', 'manual', 'orb_meal'] as HealthWriterId[]) {
      expect(await recordToHealthStore(sb, ME, w, steps, {}, deps(env))).toEqual({ ok: true, skipped: 'flag_off' });
    }
    expect(store.db).toBeDefined();
    expect(repo.calls).toEqual([]);
  });

  it('store flag off -> skipped, counted, nothing written', async () => {
    store.setEnabled(false);
    expect(await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON))).toEqual({ ok: true, skipped: 'store_disabled' });
    expect(getHealthStoreDualWriteCounters()['webhook_daily:STORE_DISABLED']).toBe(1);
    expect(repo.calls).toEqual([]);
  });

  it('the zero-UUID tenant fallback and empty values are skipped', async () => {
    expect(await recordToHealthStore(sb, { ...ME, tenant_id: '00000000-0000-0000-0000-000000000000' }, 'voice', writerValuesForFeature('water_intake', 500, DAY), {}, deps(SELF_ON))).toEqual({ ok: true, skipped: 'no_tenant' });
    expect(await recordToHealthStore(sb, ME, 'voice', writerValuesForFeature('journal_entry', 1, DAY), {}, deps(SELF_ON))).toEqual({ ok: true, skipped: 'no_values' });
  });
});

describe('device writers (VTID-05162)', () => {
  it('webhook daily metrics: stored, marker written before return, derivation after', async () => {
    const r = await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: LEGACY_CONN, connector_id: 'oura' }, deps(DEVICE_ON));
    expect(r).toEqual({ ok: true, counts: { stored: 2 }, dates: [DAY], marker: 'written' });
    expect(Array.from(repo.pending.values()).map((p) => p.date)).toEqual([DAY]);
    expect(repo.v2.size).toBe(0); // not yet: the derivation runs after the response
    await drain();
    expect(Array.from(repo.v2.values()).map((x) => x.feature_key).sort()).toEqual(['wearable_sleep_duration', 'wearable_steps']);
    expect(repo.pending.size).toBe(0);
  });

  it('replace semantics: the same day again is updated / duplicate, never a second row', async () => {
    await recordToHealthStore(sb, ME, 'webhook_daily', writerValuesForDailyMetrics({ sleep_minutes: 420 }, DAY), { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON));
    const again = await recordToHealthStore(sb, ME, 'webhook_daily', writerValuesForDailyMetrics({ sleep_minutes: 400 }, DAY), { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON));
    expect(again).toMatchObject({ counts: { updated: 1 } });
    const same = await recordToHealthStore(sb, ME, 'webhook_daily', writerValuesForDailyMetrics({ sleep_minutes: 400 }, DAY), { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON));
    expect(same).toEqual({ ok: true, counts: { duplicate: 1 }, dates: [], marker: 'none' });
  });

  it('webhook workouts are keyed <connector>:<external_workout_id>; a missing connection is a counted failure', async () => {
    const v: WriterValue = { code: 'workout', date: DAY, start: '2026-10-12T07:30:00.000Z', value: 45, external_id: 'wk-1' };
    expect(sourceRecordIdFor('webhook_workout', v, { connector_id: 'oura' }, 'x')).toBe('oura:wk-1');
    const r = await recordToHealthStore(sb, ME, 'webhook_workout', [v], { legacy_user_connection_id: LEGACY_CONN, connector_id: 'oura' }, deps(DEVICE_ON));
    expect(r).toMatchObject({ ok: true, counts: { stored: 1 } });
    const none = await recordToHealthStore(sb, ME, 'webhook_workout', [v], { connector_id: 'oura' }, deps(DEVICE_ON));
    expect(none).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
    const unknown = await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: 'other' }, deps(DEVICE_ON));
    expect(unknown).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
    expect(events).toContain('health.features.dual_write_failed');
  });

  it('a device sample without the wearables consent is skipped_no_consent, counted, not fatal', async () => {
    store.revokeConsent(ME, 'wearables', 'oura');
    const r = await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON));
    expect(r).toEqual({ ok: true, counts: { skipped_no_consent: 2 }, dates: [], marker: 'none' });
    expect(getHealthStoreDualWriteCounters()['webhook_daily:skipped_no_consent']).toBe(2);
  });

  it('the manual workout action is a per-call key on the device flag, written as the member’s manual source', async () => {
    const v: WriterValue = { code: 'workout', date: DAY, start: '2026-10-12T06:00:00.000Z', value: 30 };
    expect(sourceRecordIdFor('manual_workout', v, {}, 'act-1')).toBe('manual_workout:act-1');
    // Off with only the self-logged flag; on with the device flag. Until C1 the manual source has no consent key.
    expect(await recordToHealthStore(sb, ME, 'manual_workout', [v], { call_id: 'act-1' }, deps(SELF_ON))).toEqual({ ok: true, skipped: 'flag_off' });
    const r = await recordToHealthStore(sb, ME, 'manual_workout', [v], { call_id: 'act-1' }, deps(DEVICE_ON));
    expect(r).toMatchObject({ ok: true, counts: { skipped_no_consent: 1 } });
  });
});

describe('call-level failures never throw and never change anything for the caller (VTID-05162)', () => {
  it.each([
    ['STORE_PENDING', { write: async () => ({ ok: false as const, code: 'STORE_PENDING' as const }) }],
    ['STORE_UNAVAILABLE', { write: async () => ({ ok: false as const, code: 'STORE_UNAVAILABLE' as const }) }],
    ['STORE_DISABLED', { write: async () => ({ ok: false as const, code: 'STORE_DISABLED' as const }) }],
    ['STORE_PENDING (source)', { resolveDevice: async () => ({ ok: false as const, code: 'STORE_PENDING' as const }) }],
  ])('%s is a result', async (_name, over) => {
    const r = await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON, over as Partial<RecordDeps>));
    expect(r.ok).toBe(false);
    expect(repo.pending.size).toBe(0);
  });

  it('a throwing writer, resolver, repository or emitter gives a result', async () => {
    const boom = async () => {
      throw new Error('boom');
    };
    expect(await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON, { write: boom }))).toEqual({ ok: false, code: 'THREW' });
    expect(await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON, { resolveDevice: boom }))).toEqual({ ok: false, code: 'THREW' });
    const failing = { emit: boom, write: async () => ({ ok: false as const, code: 'STORE_UNAVAILABLE' as const }) };
    expect(await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON, failing))).toEqual({ ok: false, code: 'STORE_UNAVAILABLE' });
  });

  it('a marker write failure is counted, not fatal; the nightly pass still covers the day', async () => {
    repo.fail.upsertPending = 'missing';
    const r = await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON));
    expect(r).toMatchObject({ ok: true, marker: 'failed' });
    expect(getHealthStoreDualWriteCounters()['webhook_daily:MARKER_WRITE_FAILED']).toBe(1);
  });

  it('OASIS failure events are rate-limited per writer and code', async () => {
    const fail = { write: async () => ({ ok: false as const, code: 'STORE_UNAVAILABLE' as const }) };
    for (let i = 0; i < 3; i++) await recordToHealthStore(sb, ME, 'webhook_daily', steps, { legacy_user_connection_id: LEGACY_CONN }, deps(DEVICE_ON, fail));
    expect(events.filter((e) => e === 'health.features.dual_write_failed')).toHaveLength(1);
    expect(getHealthStoreDualWriteCounters()['webhook_daily:STORE_UNAVAILABLE']).toBe(3);
  });
});

describe('self-logged writers (VTID-05162)', () => {
  it('today (before C1): every self-logged sample is skipped_no_consent / CONSENT_CATEGORY_MISSING, counted, nothing derived', async () => {
    const r = await recordToHealthStore(sb, ME, 'voice', writerValuesForFeature('water_intake', 500, DAY), {}, deps(SELF_ON));
    expect(r).toEqual({ ok: true, counts: { skipped_no_consent: 1 }, dates: [], marker: 'none' });
    expect(repo.v2.size).toBe(0);
  });

  describe('after C1 (self_logged_health simulated)', () => {
    beforeEach(() => {
      simulateC1 = true;
      store.grantConsent(ME, 'self_logged_health' as never);
    });

    const golden: Array<[HealthWriterId, WriterValue[], Record<string, number>]> = [
      ['diary', [
        ...writerValuesForFeature('water_intake', 1000, DAY),
        ...writerValuesForFeature('meal_log', 2, DAY),
        ...writerValuesForFeature('wearable_steps', 5000, DAY),
        ...writerValuesForFeature('wearable_workout', 30, DAY),
        ...writerValuesForFeature('wearable_sleep_duration', 420, DAY),
        ...writerValuesForFeature('meditation_minutes', 10, DAY),
        ...writerValuesForFeature('journal_entry', 1, DAY),
      ], { water_intake: 1000, meal_log: 2, wearable_steps: 5000, wearable_workout: 1, wearable_sleep_duration: 420, meditation_minutes: 10 }],
      ['voice', writerValuesForFeature('meditation_minutes', 15, DAY), { meditation_minutes: 15 }],
      ['manual', writerValuesForFeature('vo2_max', 44, DAY), { vo2_max: 44 }],
      ['orb_meal', writerValuesForFeature('meal_log', 1, DAY, 'event'), { meal_log: 1 }],
      ['orb_mood', writerValuesForFeature('mood_entry', 4, DAY), { mood_entry: 4 }],
      ['orb_vitals', writerValuesForFeature('wearable_heart_rate', 62, DAY), { wearable_heart_rate: 62 }],
    ];

    it.each(golden)('%s: one member-day from writer call to health_features_daily_v2', async (writer, values, expected) => {
      const r = await recordToHealthStore(sb, ME, writer, values, {}, deps(SELF_ON));
      expect(r).toMatchObject({ ok: true, dates: [DAY], marker: 'written' });
      await drain();
      const got = Object.fromEntries(Array.from(repo.v2.values()).map((x) => [x.feature_key, x.feature_value]));
      expect(got).toEqual(expected);
    });

    it('diary replace: a lower meal count replaces a higher one (records 1..N, N+1..10 deleted)', async () => {
      await recordToHealthStore(sb, ME, 'diary', writerValuesForFeature('meal_log', 3, DAY), {}, deps(SELF_ON));
      const r = await recordToHealthStore(sb, ME, 'diary', writerValuesForFeature('meal_log', 1, DAY), {}, deps(SELF_ON));
      expect(r).toMatchObject({ counts: expect.objectContaining({ duplicate: 1, deleted: 2 }) });
      await drain();
      await store.flushHooks();
      expect(Array.from(repo.v2.values()).map((x) => [x.feature_key, x.feature_value])).toEqual([['meal_log', 1]]);
    });

    it('log_meal is an event writer: each call is a new record, the day counts them', async () => {
      await recordToHealthStore(sb, ME, 'orb_meal', writerValuesForFeature('meal_log', 1, DAY, 'event'), {}, deps(SELF_ON));
      await recordToHealthStore(sb, ME, 'orb_meal', writerValuesForFeature('meal_log', 1, DAY, 'event'), {}, deps(SELF_ON));
      await drain();
      expect(Array.from(repo.v2.values()).map((x) => [x.feature_key, x.feature_value])).toEqual([['meal_log', 2]]);
    });

    it('log_vitals blood pressure is quarantined by the catalogue (CATEGORY_NOT_ALLOWED), weight stored', async () => {
      const r = await recordToHealthStore(sb, ME, 'orb_vitals', [
        { code: 'body_weight', date: DAY, value: 80 },
        { code: 'blood_pressure_systolic', date: DAY, value: 120 },
      ], {}, deps(SELF_ON));
      expect(r).toMatchObject({ ok: true, counts: { stored: 1, quarantined: 1 } });
    });

    it('member-stated beats device on the same day', async () => {
      await recordToHealthStore(sb, ME, 'webhook_daily', writerValuesForDailyMetrics({ sleep_minutes: 400 }, DAY), { legacy_user_connection_id: LEGACY_CONN }, deps({ ...DEVICE_ON }));
      await recordToHealthStore(sb, ME, 'voice', writerValuesForFeature('wearable_sleep_duration', 450, DAY), {}, deps(SELF_ON));
      await drain();
      const sleep = Array.from(repo.v2.values()).find((x) => x.feature_key === 'wearable_sleep_duration');
      expect(sleep).toMatchObject({ feature_value: 450, source_kinds: ['device_cloud', 'voice'] });
    });
  });
});
