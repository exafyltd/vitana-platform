/**
 * VTID-05159 (Health Hub Phase 1 / A2) — readers (S4), the change hook (S8),
 * withdrawal primitives (S9), the maintenance run and the dark flag, over the
 * S10 fake's in-memory parts. No database, no S3, no network.
 */
import { randomUUID } from 'crypto';
import { createFakeHealthStore, type FakeHealthStore } from '../../src/services/health-store/testing/fake-health-store';
import { runHealthStoreMaintenanceWith } from '../../src/services/health-store/maintenance';
import { createHealthStoreHookRegistry } from '../../src/services/health-store/change-hook';
import { getHealthStoreStatus, isHealthRawErasureAvailable, isHealthStoreEnabled } from '../../src/services/health-store/flags';
import { consentKeyFor, gateCategories, HEALTH_STORE_CONSENT_KEY_MAP } from '../../src/services/health-store/consent-gate';
import type { WriteHealthSamplesInput } from '../../src/services/health-store/ingest';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ME = { tenant_id: '10000000-0000-0000-0000-000000000001', user_id: 'a0000000-0000-0000-0000-00000000000a' };
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

let store: FakeHealthStore;
let oura: string;
let phone: string;

beforeEach(() => {
  store = createFakeHealthStore({ clock: () => NOW });
  oura = store.addSource({ ...ME, kind: 'device_cloud', connector_id: 'oura' });
  phone = store.addSource({ ...ME, kind: 'partner', connector_id: 'labco' });
  store.grantConsent(ME, 'wearables', 'oura');
  store.grantConsent(ME, 'partner_results', 'labco');
});

const input = (source_id: string, samples: WriteHealthSamplesInput['samples']): WriteHealthSamplesInput => ({
  identity: ME, source_id, batch_id: randomUUID(), via: 'internal', tz: 'UTC', samples, deletions: [],
});

describe('dark flag (VTID-05159)', () => {
  it('off by default, forced off on staging, off without a bucket', () => {
    expect(getHealthStoreStatus({})).toEqual({ enabled: false, reason: 'flag_off' });
    expect(getHealthStoreStatus({ HEALTH_STORE_ENABLED: 'true', HEALTH_RAW_BUCKET: 'b', VITANA_ENV: 'staging' })).toEqual({ enabled: false, reason: 'staging' });
    expect(getHealthStoreStatus({ VITANA_ENV: 'staging' })).toEqual({ enabled: false, reason: 'staging' });
    expect(getHealthStoreStatus({ HEALTH_STORE_ENABLED: 'true' })).toEqual({ enabled: false, reason: 'bucket_missing' });
    expect(getHealthStoreStatus({ HEALTH_STORE_ENABLED: 'TRUE', HEALTH_RAW_BUCKET: 'b' }).enabled).toBe(false);
    expect(isHealthStoreEnabled({ HEALTH_STORE_ENABLED: 'true', HEALTH_RAW_BUCKET: 'b', VITANA_ENV: 'production' })).toBe(true);
    expect(isHealthRawErasureAvailable({ HEALTH_RAW_BUCKET: 'b' })).toBe(true);
    expect(isHealthRawErasureAvailable({ HEALTH_RAW_BUCKET: 'b', VITANA_ENV: 'staging' })).toBe(false);
    expect(isHealthRawErasureAvailable({})).toBe(false);
  });
});

describe('S7 consent-key map (VTID-05159)', () => {
  it('maps every (kind, category) to its D10 key; C1 (VTID-05164) filled the sync_* and self_logged_health entries', () => {
    for (const cat of ['activity', 'sleep', 'heart', 'body'] as const) {
      expect(HEALTH_STORE_CONSENT_KEY_MAP.phone_store[cat]).toBe(`sync_${cat}`);
      expect(HEALTH_STORE_CONSENT_KEY_MAP.aggregator[cat]).toBe(`sync_${cat}`);
    }
    for (const cat of ['labs', 'habits'] as const) {
      expect(HEALTH_STORE_CONSENT_KEY_MAP.phone_store[cat]).toBeNull();
      expect(HEALTH_STORE_CONSENT_KEY_MAP.aggregator[cat]).toBeNull();
    }
    expect(consentKeyFor('device_cloud', 'sleep')).toBe('wearables');
    expect(consentKeyFor('partner', 'labs')).toBe('partner_results');
    for (const k of ['diary', 'voice', 'manual']) {
      for (const cat of ['activity', 'sleep', 'heart', 'body', 'labs', 'habits'] as const) expect(consentKeyFor(k, cat)).toBe('self_logged_health');
    }
    expect(consentKeyFor('unknown_kind', 'activity')).toBeNull();
  });

  it('a per-resource key with no resource is CONSENT_REQUIRED without a read; one read per (key, resource)', async () => {
    const find = jest.fn(async () => 'c-1');
    const out = await gateCategories(ME, { kind: 'device_cloud', connector_id: null }, ['activity'], find);
    expect(out.get('activity')).toEqual({ ok: false, code: 'CONSENT_REQUIRED' });
    expect(find).not.toHaveBeenCalled();
    const ok = await gateCategories(ME, { kind: 'device_cloud', connector_id: 'oura' }, ['activity', 'sleep', 'activity'], find);
    expect(ok.get('sleep')).toEqual({ ok: true, consent_id: 'c-1' });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(ME, 'wearables', 'oura');
  });
});

describe('S4 readers (VTID-05159)', () => {
  it('value comes from the best-ranked source; every source is listed', async () => {
    await store.writeHealthSamples(null, input(phone, [{ source_record_id: 'p-w', code: 'body_weight', unit: 'kg', start: minAgo(60), value: 80 }]));
    await store.writeHealthSamples(null, input(oura, [{ source_record_id: 'o-w', code: 'body_weight', unit: 'kg', start: minAgo(90), value: 79 }]));
    const r = await store.readDailyObservations(null, ME, { codes: ['body_weight'], from: '2026-10-13', to: '2026-10-13', purpose: 'feature_compute' });
    expect(r.ok && r.rows).toEqual([
      {
        date: '2026-10-13', code: 'body_weight', value: 79, unit: 'kg', sample_count: 1, updated_at: NOW.toISOString(),
        sources: [
          { source_id: oura, source_kind: 'device_cloud', value: 79, sample_count: 1 },
          { source_id: phone, source_kind: 'partner', value: 80, sample_count: 1 },
        ],
      },
    ]);
  });

  it('record daily rules: sum for sleep sessions, last for weight; records attributed in the requested tz', async () => {
    await store.writeHealthSamples(null, input(oura, [
      { source_record_id: 's1', code: 'sleep_session', unit: 'min', start: '2026-10-12T22:30:00.000Z', end: '2026-10-13T05:00:00.000Z', value: 450, detail: { stages: [{ s: 'deep', min: 80 }] } },
      { source_record_id: 's2', code: 'sleep_session', unit: 'min', start: '2026-10-13T11:00:00.000Z', value: 30 },
      { source_record_id: 'w1', code: 'body_weight', unit: 'kg', start: '2026-10-13T06:00:00.000Z', value: 70 },
      { source_record_id: 'w2', code: 'body_weight', unit: 'kg', start: '2026-10-13T10:00:00.000Z', value: 69.5 },
    ]));
    const utc = await store.readDailyObservations(null, ME, { codes: ['sleep_session', 'body_weight'], from: '2026-10-12', to: '2026-10-13', purpose: 'member_view' });
    expect(utc.ok && utc.rows.map((r) => [r.date, r.code, r.value, r.sample_count])).toEqual([
      ['2026-10-12', 'sleep_session', 450, 1],
      ['2026-10-13', 'body_weight', 69.5, 2],
      ['2026-10-13', 'sleep_session', 30, 1],
    ]);
    const berlin = await store.readDailyObservations(null, ME, { codes: ['sleep_session'], from: '2026-10-13', to: '2026-10-13', purpose: 'member_view', tz: 'Europe/Berlin' });
    expect(berlin.ok && berlin.rows.map((r) => r.value)).toEqual([480]);
    const rec = await store.readRecords(null, ME, { codes: ['sleep_session'], from: '2026-10-12T00:00:00Z', to: '2026-10-14T00:00:00Z', purpose: 'member_view' });
    expect(rec.ok && rec.rows[0]).toMatchObject({ source_record_id: 's1', detail: { stages: [{ s: 'deep', min: 80 }] } });
  });

  it('tier readers return 5-minute and hourly buckets; suppressed rows never appear', async () => {
    const b = new Date(Math.floor((NOW.getTime() - 30 * 60000) / 300000) * 300000).toISOString();
    await store.writeHealthSamples(null, input(oura, [{ source_record_id: `steps:${b}`, code: 'steps', unit: '{steps}', start: b, value: 12 }]));
    const range = { codes: ['steps'], from: '2026-10-13T00:00:00Z', to: '2026-10-14T00:00:00Z', purpose: 'feature_compute' as const };
    const five = await store.readSeries5m(null, ME, range);
    const hour = await store.readHourly(null, ME, range);
    expect(five.ok && five.rows.map((r) => [r.bucket_start, r.sum])).toEqual([[b, 12]]);
    expect(hour.ok && hour.rows.map((r) => r.sum)).toEqual([12]);
    await store.suppressHealthData(null, ME, { category: 'activity' });
    const after = await store.readSeries5m(null, ME, range);
    expect(after.ok && after.rows).toEqual([]);
  });

  it('missing purpose / ai_context without consent never call the repository; bad input is INVALID_INPUT', async () => {
    const before = store.db.calls.length;
    expect(await store.readSeries5m(null, ME, { codes: ['steps'], from: 'a', to: 'b' } as never)).toEqual({ ok: false, code: 'PURPOSE_REQUIRED' });
    expect(await store.readRecords(null, ME, { codes: ['body_weight'], from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', purpose: 'ai_context' })).toEqual({ ok: false, code: 'consent_required' });
    expect(await store.readDailyObservations(null, ME, { codes: ['steps'], from: '2026-10-13', to: '2025-01-01', purpose: 'member_view' })).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(store.db.calls.length).toBe(before);
    store.db.missing = true;
    expect(await store.readDailyObservations(null, ME, { codes: ['steps'], from: '2026-10-13', to: '2026-10-13', purpose: 'member_view' })).toEqual({ ok: false, code: 'STORE_PENDING' });
  });
});

describe('S8 change hook and S9 withdrawal (VTID-05159)', () => {
  it('a throwing or rejecting hook never fails the primitive; the others still run', async () => {
    const good = jest.fn(async () => undefined);
    store.registerHealthStoreChangeHook(async () => { throw new Error('boom'); });
    store.registerHealthStoreChangeHook((() => { throw new Error('sync boom'); }) as never);
    store.registerHealthStoreChangeHook(good);
    const s = await store.suppressHealthData(null, ME, { category: 'sleep', source_id: oura });
    expect(s.ok).toBe(true);
    await store.flushHooks();
    expect(good).toHaveBeenCalledWith(ME, { categories: ['sleep'], source_id: oura });
  });

  it('hooks run after the commit: the hook already sees the suppressed rows', async () => {
    await store.writeHealthSamples(null, input(oura, [{ source_record_id: 'w', code: 'body_weight', unit: 'kg', start: minAgo(60), value: 70 }]));
    const seen: Array<string | null> = [];
    store.registerHealthStoreChangeHook(async () => {
      seen.push(Array.from(store.db.obs.values())[0].suppressed_at);
    });
    const r = await store.suppressHealthData(null, ME, { category: 'body' });
    expect(r.ok).toBe(true);
    await store.flushHooks();
    expect(seen).toEqual([NOW.toISOString()]);
  });

  it('unregister stops a hook; the registry counts hooks', async () => {
    const reg = createHealthStoreHookRegistry();
    const fn = jest.fn(async () => undefined);
    const off = reg.register(fn);
    expect(reg.size()).toBe(1);
    off();
    reg.fire(ME, {});
    await reg.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('withdrawal works with the store flag off; bad input is INVALID_INPUT; a raw erase failure is reported, not fatal', async () => {
    store.setEnabled(false);
    expect((await store.suppressHealthData(null, ME, { category: 'heart' })).ok).toBe(true);
    expect(await store.suppressHealthData(null, ME, { category: 'glucose' as never })).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(await store.suppressHealthData(null, ME, { source_id: 'nope' })).toEqual({ ok: false, code: 'INVALID_INPUT' });
    store.raw.failErase = true;
    const r = await store.suppressHealthData(null, ME, { source_id: oura });
    expect(r.ok && r.raw).toEqual({ error: 'STORE_UNAVAILABLE' });
    store.db.missing = true;
    expect(await store.suppressHealthData(null, ME, {})).toEqual({ ok: false, code: 'STORE_PENDING' });
  });

  it('suppressed rows are hard-deleted by the purge after 7 days', async () => {
    await store.writeHealthSamples(null, input(oura, [{ source_record_id: 'w', code: 'body_weight', unit: 'kg', start: minAgo(60), value: 70 }]));
    await store.suppressHealthData(null, ME, { at: new Date(NOW.getTime() - 8 * 86400000).toISOString() });
    expect(store.db.obs.size).toBe(1);
    await runHealthStoreMaintenanceWith(store.deps);
    expect(store.db.obs.size).toBe(0);
  });
});

describe('maintenance run (VTID-05159)', () => {
  it('ensure -> purge, logs the run and emits maintenance.completed (counts only)', async () => {
    const s = await runHealthStoreMaintenanceWith(store.deps);
    expect(s).toMatchObject({ ok: true, partitions_created: 0, partitions_dropped: 0, missing_partitions: null, errors: [] });
    expect(store.db.calls).toEqual(['ensurePartitions', 'purge']);
    expect(store.logs.find((l) => l.event === 'health_store_maintenance')).toMatchObject({ ok: true });
    expect(store.events.map((e) => e.type)).toEqual(['health.store.maintenance.completed']);
  });

  it('the 02:xx UTC run adds the partition check and the capacity snapshot; a gap alarms', async () => {
    const two = createFakeHealthStore({ clock: () => new Date('2026-10-13T02:23:00Z') });
    two.db.partitionsBroken = true;
    const s = await runHealthStoreMaintenanceWith(two.deps);
    expect(s.missing_partitions).toEqual(['health_series_5m_p20261014']);
    expect(two.logs.find((l) => l.event === 'health_store_partition_check')).toMatchObject({ missing: 1 });
    expect(two.logs.find((l) => l.event === 'health_store_capacity')).toMatchObject({ series_5m_rows_estimate: 0 });
    expect(two.events.map((e) => e.type)).toEqual(['health.store.partition_missing', 'health.store.maintenance.completed']);
  });

  it('a failing step -> ok:false, maintenance.failed with codes, never throws', async () => {
    store.db.fail.purge = { code: 'XX000', message: 'boom' };
    const s = await runHealthStoreMaintenanceWith(store.deps, { partitionCheck: true });
    expect(s.ok).toBe(false);
    expect(s.errors).toEqual(['purge:STORE_UNAVAILABLE']);
    expect(store.events.map((e) => e.type)).toContain('health.store.maintenance.failed');
    store.db.fail.ensurePartitions = 'throw';
    const t = await runHealthStoreMaintenanceWith(store.deps);
    expect(t.ok).toBe(false);
  });
});
