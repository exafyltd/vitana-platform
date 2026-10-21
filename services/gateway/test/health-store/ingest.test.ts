/**
 * VTID-05159 (Health Hub Phase 1 / A2) — writeHealthSamples (S3) in detail,
 * over the S10 fake's in-memory parts with a fixed clock: never throws,
 * round trips, failure order, partition routing, quota, validation, chunking,
 * tiers, time zones, reprocess. No database, no S3, no network.
 */
import { randomUUID } from 'crypto';
import { createFakeHealthStore, type FakeHealthStore } from '../../src/services/health-store/testing/fake-health-store';
import {
  writeHealthSamplesWith,
  type HealthStoreDeps,
  type WriteHealthSamplesInput,
} from '../../src/services/health-store/ingest';
import type { HealthStoreRepository } from '../../src/services/health-store/health-store-repository';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ME = { tenant_id: '10000000-0000-0000-0000-000000000001', user_id: 'a0000000-0000-0000-0000-00000000000a' };
const iso = (ms: number) => new Date(ms).toISOString();
const minAgo = (m: number) => iso(NOW.getTime() - m * 60000);

let store: FakeHealthStore;
let oura: string;
let consentId: string;

beforeEach(() => {
  store = createFakeHealthStore({ clock: () => NOW });
  oura = store.addSource({ ...ME, kind: 'device_cloud', connector_id: 'oura' });
  consentId = store.grantConsent(ME, 'wearables', 'oura');
});

function input(samples: WriteHealthSamplesInput['samples'], deletions: WriteHealthSamplesInput['deletions'] = [], extra: Partial<WriteHealthSamplesInput> = {}): WriteHealthSamplesInput {
  return { identity: ME, source_id: oura, batch_id: randomUUID(), via: 'internal', tz: 'UTC', samples, deletions, ...extra };
}
const steps = (start: string, value: number) => ({ source_record_id: `steps:${start}`, code: 'steps', unit: '{steps}', start, value });
const hr = (start: string, stats: { n: number; sum: number; min: number; max: number }) => ({ source_record_id: `heart_rate:${start}`, code: 'heart_rate', unit: '/min', start, stats });
const weight = (id: string, start: string, value: number) => ({ source_record_id: id, code: 'body_weight', unit: 'kg', start, value });

describe('writeHealthSamples never throws (VTID-05159)', () => {
  const methods: Array<keyof HealthStoreRepository> = ['listBatchCountsSince', 'firstBatchForSource', 'findBatch', 'insertQuarantine', 'ingestChunk', 'insertBatch'];

  it.each(methods)('a throwing repository (%s) gives a result, not an exception', async (m) => {
    store.db.fail[m] = 'throw';
    const r = await store.writeHealthSamples(null, input([steps(minAgo(30), 5), steps(minAgo(30), 1e9)]));
    expect(r).toBeDefined();
    if (!r.ok) expect(r.code).toBe('STORE_UNAVAILABLE');
  });

  it('a throwing S3 client, consent read, source lookup, hook or emitter gives a result', async () => {
    const deps: HealthStoreDeps = {
      ...store.deps,
      raw: { ...store.raw, put: async () => { throw new Error('s3'); } },
    };
    expect(await writeHealthSamplesWith(deps, input([steps(minAgo(30), 5)]))).toEqual({ ok: false, code: 'STORE_UNAVAILABLE' });

    const consentThrows: HealthStoreDeps = { ...store.deps, findConsentId: async () => { throw new Error('db'); } };
    const c = await writeHealthSamplesWith(consentThrows, input([steps(minAgo(30), 5)]));
    expect(c.ok && c.results[0]).toMatchObject({ status: 'skipped_no_consent', code: 'CONSENT_REQUIRED' });

    const sourceThrows: HealthStoreDeps = { ...store.deps, resolveSource: async () => { throw new Error('db'); } };
    expect(await writeHealthSamplesWith(sourceThrows, input([steps(minAgo(30), 5)]))).toEqual({ ok: false, code: 'STORE_UNAVAILABLE' });

    const emitThrows: HealthStoreDeps = { ...store.deps, emit: async () => { throw new Error('oasis'); } };
    const e = await writeHealthSamplesWith(emitThrows, input([steps(minAgo(30), 5)]));
    expect(e.ok).toBe(true);

    store.registerHealthStoreChangeHook(async () => { throw new Error('hook'); });
    await store.writeHealthSamples(null, input([weight('w1', minAgo(30), 70)]));
    const d = await store.writeHealthSamples(null, input([], [{ source_record_id: 'w1', code: 'body_weight' }]));
    expect(d.ok && d.results[0].status).toBe('deleted');
    await store.flushHooks();
  });

  it('a garbage input gives INVALID_INPUT', async () => {
    for (const bad of [null, {}, { ...input([]), batch_id: 'nope' }, { ...input([]), via: 'web' }, { ...input([]), tz: 'Mars/Base' }, { ...input([]), identity: {} }]) {
      expect(await store.writeHealthSamples(null, bad as never)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    }
  });
});

describe('round trips and order (VTID-05159)', () => {
  it('one consent read per category present, one S3 put, one RPC per chunk', async () => {
    const phoneReads = store.consentReadCount();
    const r = await store.writeHealthSamples(null, input([steps(minAgo(30), 5), hr(minAgo(30), { n: 10, sum: 600, min: 55, max: 70 }), weight('w', minAgo(60), 70)]));
    expect(r.ok).toBe(true);
    // device_cloud: every category maps to the same `wearables`/oura consent -> one read for three categories
    expect(store.consentReadCount() - phoneReads).toBe(1);
    expect(store.raw.puts).toBe(1);
    expect(store.db.calls.filter((c) => c === 'ingestChunk')).toHaveLength(1);
    expect(store.db.calls).toEqual(['listBatchCountsSince', 'firstBatchForSource', 'findBatch', 'ingestChunk', 'insertBatch']);
  });

  it('chunks at 2,000 items', async () => {
    const many = Array.from({ length: 4500 }, (_, i) => weight(`w-${i}`, minAgo(60), 70));
    const r = await store.writeHealthSamples(null, input(many));
    expect(r.ok && r.results.every((x) => x.status === 'stored')).toBe(true);
    expect(store.db.calls.filter((c) => c === 'ingestChunk')).toHaveLength(3);
  });

  it('S3 failure -> STORE_UNAVAILABLE, no RPC, no batch row', async () => {
    store.raw.failPut = true;
    expect(await store.writeHealthSamples(null, input([steps(minAgo(30), 5)]))).toEqual({ ok: false, code: 'STORE_UNAVAILABLE' });
    expect(store.db.calls).not.toContain('ingestChunk');
    expect(store.db.batches).toHaveLength(0);
  });

  it('store not applied -> STORE_PENDING before anything is archived', async () => {
    store.db.missing = true;
    expect(await store.writeHealthSamples(null, input([steps(minAgo(30), 5)]))).toEqual({ ok: false, code: 'STORE_PENDING' });
    expect(store.raw.puts).toBe(0);
  });

  it('ingest function missing -> STORE_PENDING and the raw object is removed again', async () => {
    store.db.fail.ingestChunk = { code: '42883', message: 'function public.health_store_ingest does not exist' };
    expect(await store.writeHealthSamples(null, input([steps(minAgo(30), 5)]))).toEqual({ ok: false, code: 'STORE_PENDING' });
    expect(store.raw.objects.size).toBe(0);
  });
});

describe('partition routing (VTID-05159)', () => {
  it('23514 -> ensure_partitions once, the chunk is retried once and stored', async () => {
    store.db.partitionsMissing = true;
    const r = await store.writeHealthSamples(null, input([steps(minAgo(30), 5)]));
    expect(r.ok && r.results[0].status).toBe('stored');
    expect(store.db.calls.filter((c) => c === 'ensurePartitions')).toHaveLength(1);
    expect(store.db.calls.filter((c) => c === 'ingestChunk')).toHaveLength(2);
  });

  it('still failing -> that chunk is store_unavailable, logged + alarmed, other chunks stored, no throw', async () => {
    let call = 0;
    const repo: HealthStoreRepository = {
      ...store.deps.repo,
      ingestChunk: async (p) => {
        call++;
        if (call <= 2) return { data: null, error: { code: '23514', message: 'no partition of relation "health_series_5m" found for row' } };
        return store.deps.repo.ingestChunk(p);
      },
    };
    const deps: HealthStoreDeps = { ...store.deps, repo };
    const many = Array.from({ length: 2001 }, (_, i) => weight(`w-${i}`, minAgo(60), 70));
    const r = await writeHealthSamplesWith(deps, input(many));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.slice(0, 2000).every((x) => x.status === 'store_unavailable')).toBe(true);
    expect(r.results[2000].status).toBe('stored');
    expect(store.logs.some((l) => l.event === 'health.store.partition_missing')).toBe(true);
    expect(store.events.map((e) => e.type)).toContain('health.store.partition_missing');
    expect(store.db.calls.filter((c) => c === 'ensurePartitions')).toHaveLength(1);
  });
});

describe('quota (VTID-05159)', () => {
  function seedBatches(n: number, items: number, at: string) {
    for (let i = 0; i < n; i++) {
      store.db.batches.push({
        tenant_id: ME.tenant_id, user_id: ME.user_id, batch_id: randomUUID(), body_sha256: 'x', source_id: oura, via: 'internal',
        contract_version: null, tz: null, s3_key: null, consent_id: null, accepted: items, quarantined: 0, rejected: 0,
        status: 'stored', results: null, received_at: at,
      });
    }
  }

  it('the 501st batch of the day -> QUOTA_EXCEEDED + one health.store.quota.exceeded', async () => {
    seedBatches(500, 1, minAgo(60));
    expect(await store.writeHealthSamples(null, input([steps(minAgo(30), 5)]))).toEqual({ ok: false, code: 'QUOTA_EXCEEDED' });
    expect(store.events.filter((e) => e.type === 'health.store.quota.exceeded')).toHaveLength(1);
    expect(JSON.stringify(store.events[0].payload)).not.toContain(ME.user_id);
  });

  it('50,000 items/day after the 7-day backfill grace; 250,000 inside it', async () => {
    seedBatches(1, 49_999, iso(NOW.getTime() - 10 * 86400000)); // first batch 10 days ago: grace over
    seedBatches(1, 49_999, minAgo(60));
    expect(await store.writeHealthSamples(null, input([steps(minAgo(30), 5), steps(minAgo(35), 5)]))).toEqual({ ok: false, code: 'QUOTA_EXCEEDED' });

    const fresh = createFakeHealthStore({ clock: () => NOW });
    const src = fresh.addSource({ ...ME, kind: 'device_cloud', connector_id: 'oura' });
    fresh.grantConsent(ME, 'wearables', 'oura');
    fresh.db.batches.push({
      tenant_id: ME.tenant_id, user_id: ME.user_id, batch_id: randomUUID(), body_sha256: 'x', source_id: src, via: 'internal',
      contract_version: null, tz: null, s3_key: null, consent_id: null, accepted: 60_000, quarantined: 0, rejected: 0,
      status: 'stored', results: null, received_at: minAgo(60),
    });
    const ok = await fresh.writeHealthSamples(null, { ...input([steps(minAgo(30), 5)]), source_id: src });
    expect(ok.ok).toBe(true);
  });
});

describe('validation and quarantine (VTID-05159)', () => {
  it('each reason is quarantined with no value; valid items stored', async () => {
    const r = await store.writeHealthSamples(null, input([
      { ...steps(minAgo(30), 5), unit: 'count' },                       // UNIT_MISMATCH
      steps(minAgo(30), -1),                                              // IMPLAUSIBLE
      steps(iso(NOW.getTime() - 32 * 60000 + 60000), 5),                  // MISALIGNED_BUCKET (not on 5 min)
      steps(iso(NOW.getTime() + 60 * 60000), 5),                          // FUTURE
      weight('old', iso(NOW.getTime() - 401 * 86400000), 70),             // TOO_OLD
      { source_record_id: 'g', code: 'blood_glucose', unit: 'mg/dL', start: minAgo(30), value: 90 }, // UNKNOWN_CODE
      { source_record_id: 'bp', code: 'blood_pressure_systolic', unit: 'mm[Hg]', start: minAgo(30), value: 120 }, // CATEGORY_NOT_ALLOWED
      steps(minAgo(30), 5),                                               // valid
      { source_record_id: '', code: 'steps', unit: '{steps}', start: minAgo(30), value: 1 }, // INVALID_ITEM
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.map((x) => x.code ?? x.status)).toEqual([
      'UNIT_MISMATCH', 'IMPLAUSIBLE', 'MISALIGNED_BUCKET', 'FUTURE', 'TOO_OLD', 'UNKNOWN_CODE', 'CATEGORY_NOT_ALLOWED', 'stored', 'INVALID_ITEM',
    ]);
    expect(r.results[8].status).toBe('invalid');
    expect(store.db.quarantine.map((q) => q.reason)).toEqual(expect.arrayContaining(['UNIT_MISMATCH', 'IMPLAUSIBLE', 'MISALIGNED_BUCKET', 'FUTURE', 'TOO_OLD', 'UNKNOWN_CODE', 'CATEGORY_NOT_ALLOWED']));
    for (const q of store.db.quarantine) expect(Object.keys(q).sort()).toEqual(['batch_id', 'code_key', 'item_index', 'reason', 'tenant_id', 'user_id']);
    // the unknown code was never archived (no category, no consent); the archive holds the consented subset only
    const archived = Array.from(store.raw.objects.values())[0] as { samples: Array<{ code: string }> };
    expect(archived.samples.map((s) => s.code)).not.toContain('blood_glucose');
    expect(store.events.map((e) => e.type)).toContain('health.store.batch.quarantined');
  });

  it('series older than 30 days go to the hourly tier (hour-aligned)', async () => {
    const start = iso(Math.floor((NOW.getTime() - 40 * 86400000) / 3600000) * 3600000);
    const r = await store.writeHealthSamples(null, input([steps(start, 1000)]));
    expect(r.ok && r.results[0].status).toBe('stored');
    expect(store.db.s5m.size).toBe(0);
    expect(store.db.s1h.size).toBe(1);
    expect(store.db.s1d.size).toBe(1);
  });

  it('daily attribution follows the batch time zone (Europe/Berlin, DST end day)', async () => {
    const clock = new Date('2026-10-26T12:00:00Z');
    const s = createFakeHealthStore({ clock: () => clock });
    const src = s.addSource({ ...ME, kind: 'device_cloud', connector_id: 'oura' });
    s.grantConsent(ME, 'wearables', 'oura');
    // 2026-10-24T22:30Z is 00:30 CEST on 25 Oct; 2026-10-25T22:30Z is 23:30 CET on 25 Oct.
    const r = await s.writeHealthSamples(null, {
      identity: ME, source_id: src, batch_id: randomUUID(), via: 'internal', tz: 'Europe/Berlin', deletions: [],
      samples: [steps('2026-10-24T22:30:00.000Z', 10), steps('2026-10-25T22:30:00.000Z', 20), steps('2026-10-24T21:55:00.000Z', 5)],
    });
    expect(r.ok).toBe(true);
    const read = await s.readDailyObservations(null, ME, { codes: ['steps'], from: '2026-10-24', to: '2026-10-25', purpose: 'member_view' });
    expect(read.ok && read.rows.map((x) => [x.date, x.value])).toEqual([
      ['2026-10-24', 5],
      ['2026-10-25', 30],
    ]);
  });

  it('stats codes keep n/sum/min/max; the daily value is the mean', async () => {
    await store.writeHealthSamples(null, input([hr(minAgo(30), { n: 10, sum: 600, min: 50, max: 70 }), hr(minAgo(35), { n: 10, sum: 800, min: 70, max: 90 })]));
    const read = await store.readDailyObservations(null, ME, { codes: ['heart_rate'], from: '2026-10-13', to: '2026-10-13', purpose: 'member_view' });
    expect(read.ok && read.rows[0]).toMatchObject({ value: 70, sample_count: 20 });
  });
});

describe('sources, deletions, reprocess (VTID-05159)', () => {
  it('a disconnected source refuses samples but still processes deletions', async () => {
    const gone = store.addSource({ ...ME, kind: 'device_cloud', connector_id: 'oura', status: 'disconnected' });
    expect(await store.writeHealthSamples(null, { ...input([steps(minAgo(30), 5)]), source_id: gone })).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
    const d = await store.writeHealthSamples(null, { ...input([], [{ source_record_id: 'x', code: 'body_weight' }]), source_id: gone });
    expect(d.ok && d.results[0].status).toBe('not_found');
  });

  it('a malformed deletion is invalid; a series deletion needs "<code>:<start>"', async () => {
    const r = await store.writeHealthSamples(null, input([], [{ source_record_id: 'steps-x', code: 'steps' }, { source_record_id: 'a', code: 'nope' }]));
    expect(r.ok && r.results.map((x) => x.status)).toEqual(['invalid', 'invalid']);
  });

  it('reprocess re-runs a stored raw batch with the CURRENT consent: revoked -> nothing written', async () => {
    const first = await store.writeHealthSamples(null, input([weight('w-r', minAgo(30), 70)]));
    expect(first.ok).toBe(true);
    const batchId = store.db.batches[0].batch_id;
    store.db.obs.clear();
    store.revokeConsent(ME, 'wearables', 'oura');
    const r = await store.reprocessHealthBatch(null, batchId);
    expect(r.ok && r.results[0]).toMatchObject({ status: 'skipped_no_consent' });
    expect(store.db.obs.size).toBe(0);

    store.grantConsent(ME, 'wearables', 'oura');
    const again = await store.reprocessHealthBatch(null, batchId);
    expect(again.ok && again.results[0].status).toBe('stored');
    expect(store.db.batches.map((b) => b.via)).toEqual(['internal', 'reprocess', 'reprocess']);
    expect(await store.reprocessHealthBatch(null, randomUUID())).toEqual({ ok: false, code: 'BATCH_NOT_FOUND' });
  });

  it('first data for a source emits health.store.source.first_data once, with ids and counts only', async () => {
    await store.writeHealthSamples(null, input([steps(minAgo(30), 5)]));
    await store.writeHealthSamples(null, input([steps(minAgo(35), 5)]));
    const first = store.events.filter((e) => e.type === 'health.store.source.first_data');
    expect(first).toHaveLength(1);
    expect(first[0].payload).toEqual({ source_id: oura, source_kind: 'device_cloud', batch_id: expect.any(String), stored: 1 });
    expect(consentId).toBeDefined();
  });
});
