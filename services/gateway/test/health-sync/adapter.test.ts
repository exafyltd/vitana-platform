/**
 * VTID-05164 (Health Hub Phase 1 / C1) — processHealthSyncBatch over A's S10
 * fake (the real store logic in memory) and an S6 fake of B's source functions.
 *
 *   - consent per category: unconsented records are dropped BEFORE A (A's
 *     samples, raw archive and quarantine never see them); all unconsented ->
 *     403 and nothing created; deletions pass through without consent; a
 *     consent read error is "not granted"; one read per category present;
 *   - idempotency through A: batch replay, record resend (duplicate), changed
 *     value (updated);
 *   - S3 mapping table: STORE_PENDING / STORE_UNAVAILABLE / BATCH_ID_REUSED /
 *     QUOTA_EXCEEDED / INVALID_INPUT / STORE_DISABLED and every per-record code;
 *   - SOURCE_PAUSED; OASIS payloads never carry a value or a record id;
 *     never throws; the aggregator interface with a fixture adapter.
 */
import {
  mapStoreBatchError,
  mapStoreRecordCode,
  processAggregatorDelivery,
  processHealthSyncBatch,
  type HealthSyncDeps,
} from '../../src/services/health-sync/adapter';
import { parseHealthSyncBatch, type HealthSyncBatchV1 } from '../../src/services/health-sync/contract-v1';
import { createFixtureAggregatorAdapter } from '../../src/services/health-sync/testing/fixture-aggregator';
import { createHarness, INSTALL_ID, ME, NOW, sleepRecord, stepsRecord, validBatch, weightRecord } from './helpers';

function batch(over: Record<string, unknown> = {}): HealthSyncBatchV1 {
  const p = parseHealthSyncBatch(validBatch(over));
  if (!p.ok) throw new Error(`fixture invalid: ${JSON.stringify(p)}`);
  return p.batch;
}

const BATCH_A = '6f1c2b1e-4d6a-4a8e-9c1b-2f3e4d5a6b7c';
const BATCH_B = '7a2d3c4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const BATCH_C = '8b3e4d5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';

let h: ReturnType<typeof createHarness>;
beforeEach(() => {
  h = createHarness();
});

describe('consent per category (fail closed)', () => {
  it('drops unconsented records before A: A gets only consented samples, its raw archive and quarantine never see the rest', async () => {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    const out = await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 120), sleepRecord('sleep-1', 480), weightRecord('w-1', 72.4)] }), { channel: 'native' }, h.deps);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      ok: true,
      counts: { stored: 1, duplicate: 0, updated: 0, deleted: 0, rejected: 2 },
      rejected: [
        { record_id: 'sleep-1', code: 'CATEGORY_NOT_CONSENTED' },
        { record_id: 'w-1', code: 'CATEGORY_NOT_CONSENTED' },
      ],
      consent: { activity: 'granted', sleep: 'not_granted', body: 'not_granted' },
      source_state: 'connected',
    });
    expect(h.writes).toHaveLength(1);
    const sent = h.writes[0] as { samples: Array<{ code: string }>; via: string; contract_version: string };
    expect(sent.samples.map((s) => s.code)).toEqual(['steps']);
    expect(sent.via).toBe('health_sync_native');
    expect(sent.contract_version).toBe('1.0');
    const archived = JSON.stringify([...h.store.raw.objects.values()]);
    expect(archived).not.toContain('sleep-1');
    expect(archived).not.toContain('w-1');
    expect(h.store.db.quarantine).toHaveLength(0);
  });

  it('checks each category present once (at most 4 reads), with the phone store as the resource', async () => {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    const recs = [stepsRecord(30, 1), stepsRecord(35, 2), stepsRecord(40, 3), sleepRecord('s1', 400), sleepRecord('s2', 410)];
    await processHealthSyncBatch(ME, batch({ records: recs }), { channel: 'native' }, h.deps);
    expect(h.consentReads()).toBe(2);
  });

  it('another source’s consent does not count (per category x source)', async () => {
    h.store.grantConsent(ME, 'sync_activity', 'health_connect');
    const out = await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 1)] }), { channel: 'native' }, h.deps);
    expect(out).toMatchObject({ status: 403, body: { ok: false, error: 'CONSENT_REQUIRED', retryable: false, categories: ['activity'] } });
  });

  it('no consented category and no deletion -> 403 CONSENT_REQUIRED; nothing is created or written', async () => {
    const out = await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 1), sleepRecord('s1', 400)] }), { channel: 'native' }, h.deps);
    expect(out).toMatchObject({ status: 403, body: { error: 'CONSENT_REQUIRED', categories: ['activity', 'sleep'] } });
    expect(h.sources.calls).toHaveLength(0);
    expect(h.sources.rows).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
    expect(h.store.raw.puts).toBe(0);
    expect(h.events.map((e) => e.type)).toEqual(['health.sync.batch.rejected']);
  });

  it('a consent read that throws is "not granted"', async () => {
    const deps: HealthSyncDeps = { ...h.deps, findConsentId: async () => { throw new Error('db down'); } };
    const out = await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 1)] }), { channel: 'native' }, deps);
    expect(out.status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });

  it('deletions pass through whatever the consent state, and the change hook fires for committed deletions', async () => {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    const rec = stepsRecord(30, 77);
    expect((await processHealthSyncBatch(ME, batch({ records: [rec] }), { channel: 'native' }, h.deps)).status).toBe(200);
    h.store.revokeConsent(ME, 'sync_activity', 'apple_health');
    const hook = jest.fn(async () => undefined);
    h.store.registerHealthStoreChangeHook(hook);
    const out = await processHealthSyncBatch(
      ME,
      batch({ batch_id: BATCH_B, records: [stepsRecord(45, 5)], deletions: [{ record_id: rec.record_id, type: 'steps' }, { record_id: 'steps:2026-10-13T00:00:00.000Z', type: 'steps' }] }),
      { channel: 'native' },
      h.deps,
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ counts: { deleted: 2, stored: 0, rejected: 1 }, rejected: [{ code: 'CATEGORY_NOT_CONSENTED' }], consent: { activity: 'not_granted' } });
    const sent = h.writes[1] as { samples: unknown[]; deletions: unknown[] };
    expect(sent.samples).toHaveLength(0);
    expect(sent.deletions).toHaveLength(2);
    await h.store.flushHooks();
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

describe('idempotency through A (S3)', () => {
  beforeEach(() => {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    h.store.grantConsent(ME, 'sync_body', 'apple_health');
  });

  it('the same batch twice is a replay: same outcome, replay:true, nothing written twice', async () => {
    const b = batch({ records: [stepsRecord(30, 10), weightRecord('w-1', 70)] });
    const first = await processHealthSyncBatch(ME, b, { channel: 'native' }, h.deps);
    const puts = h.store.raw.puts;
    const second = await processHealthSyncBatch(ME, b, { channel: 'native' }, h.deps);
    expect(first.body).toMatchObject({ replay: false, counts: { stored: 2 } });
    expect(second.body).toMatchObject({ replay: true, counts: { stored: 2 } });
    expect(h.store.raw.puts).toBe(puts);
  });

  it('a record resent in a new batch is duplicate; a changed value with the same record_id is updated', async () => {
    await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 10), weightRecord('w-1', 70)] }), { channel: 'native' }, h.deps);
    const resend = await processHealthSyncBatch(ME, batch({ batch_id: BATCH_B, records: [stepsRecord(30, 10), weightRecord('w-1', 70)] }), { channel: 'native' }, h.deps);
    expect(resend.body).toMatchObject({ counts: { duplicate: 2, stored: 0, updated: 0 } });
    const changed = await processHealthSyncBatch(ME, batch({ batch_id: BATCH_C, records: [stepsRecord(30, 11), weightRecord('w-1', 70.5)] }), { channel: 'native' }, h.deps);
    expect(changed.body).toMatchObject({ counts: { updated: 2 } });
  });

  it('the same batch_id with different content is 409 BATCH_ID_REUSED (not retryable)', async () => {
    await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 10)] }), { channel: 'native' }, h.deps);
    const out = await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 99)] }), { channel: 'native' }, h.deps);
    expect(out).toMatchObject({ status: 409, body: { ok: false, error: 'BATCH_ID_REUSED', retryable: false } });
  });
});

describe('per-record codes from A (S3 mapping)', () => {
  beforeEach(() => {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    h.store.grantConsent(ME, 'sync_body', 'apple_health');
    h.store.grantConsent(ME, 'sync_sleep', 'apple_health');
  });

  it('unit mismatch, implausible, out of window, misaligned, unsupported type', async () => {
    const misaligned = { ...stepsRecord(30, 5), record_id: 'mis', start: new Date(Date.parse(stepsRecord(30, 5).start) + 60_000).toISOString() };
    const old = { ...weightRecord('old', 70), start: '2025-01-01T07:00:00Z', end: '2025-01-01T07:00:00Z' };
    const future = { ...weightRecord('future', 70), start: '2026-10-13T13:00:00Z', end: '2026-10-13T13:00:00Z' };
    const vo2 = { record_id: 'vo2', type: 'vo2_max', value: 40, unit: 'mL/kg/min', start: '2026-10-13T07:00:00Z', end: '2026-10-13T07:00:00Z', tz: 'UTC' };
    const glucose = { record_id: 'glu', type: 'blood_glucose', value: 5, unit: 'mmol/L', start: '2026-10-13T07:00:00Z', end: '2026-10-13T07:00:00Z', tz: 'UTC' };
    const out = await processHealthSyncBatch(
      ME,
      batch({ records: [weightRecord('lbs', 150, '[lb_av]'), weightRecord('heavy', 900), old, future, misaligned, vo2, glucose, sleepRecord('ok-sleep', 450)] }),
      { channel: 'native' },
      h.deps,
    );
    expect(out.status).toBe(200);
    const byId = Object.fromEntries((out.body as any).rejected.map((r: any) => [r.record_id, r.code]));
    expect(byId).toEqual({
      vo2: 'UNSUPPORTED_TYPE',
      glu: 'UNSUPPORTED_TYPE',
      lbs: 'UNIT_MISMATCH',
      heavy: 'IMPLAUSIBLE_VALUE',
      old: 'OUT_OF_WINDOW',
      future: 'OUT_OF_WINDOW',
      mis: 'INVALID_RECORD',
    });
    expect((out.body as any).counts).toMatchObject({ stored: 1, rejected: 7 });
    // unsupported types never reach A
    const sent = h.writes[0] as { samples: Array<{ code: string; detail?: unknown }> };
    expect(sent.samples.map((s) => s.code)).not.toContain('vo2_max');
    expect(sent.samples.map((s) => s.code)).not.toContain('blood_glucose');
    // sleep stages travel as the sample detail
    expect(sent.samples.find((s) => s.code === 'sleep_session')?.detail).toEqual({ stages: expect.any(Array) });
  });

  it('the mapping table matches the shared interfaces', () => {
    expect(mapStoreRecordCode('quarantined', 'IMPLAUSIBLE')).toBe('IMPLAUSIBLE_VALUE');
    expect(mapStoreRecordCode('quarantined', 'UNIT_MISMATCH')).toBe('UNIT_MISMATCH');
    expect(mapStoreRecordCode('quarantined', 'UNKNOWN_CODE')).toBe('UNSUPPORTED_TYPE');
    expect(mapStoreRecordCode('quarantined', 'CATEGORY_NOT_ALLOWED')).toBe('UNSUPPORTED_TYPE');
    expect(mapStoreRecordCode('quarantined', 'TOO_OLD')).toBe('OUT_OF_WINDOW');
    expect(mapStoreRecordCode('quarantined', 'FUTURE')).toBe('OUT_OF_WINDOW');
    expect(mapStoreRecordCode('quarantined', 'MISALIGNED_BUCKET')).toBe('INVALID_RECORD');
    expect(mapStoreRecordCode('invalid', 'INVALID_ITEM')).toBe('INVALID_RECORD');
    expect(mapStoreRecordCode('skipped_no_consent', 'CONSENT_REQUIRED')).toBe('CATEGORY_NOT_CONSENTED');
    expect(mapStoreRecordCode('store_unavailable')).toBe('STORE_UNAVAILABLE');
    for (const s of ['stored', 'updated', 'duplicate', 'deleted', 'not_found']) expect(mapStoreRecordCode(s)).toBeNull();

    expect(mapStoreBatchError('STORE_DISABLED')).toEqual({ status: 409, body: { ok: false, error: 'INGEST_DISABLED', retryable: false, reason: 'flag_off' } });
    expect(mapStoreBatchError('STORE_PENDING')).toEqual({ status: 503, body: { ok: false, error: 'STORE_PENDING', retryable: true } });
    expect(mapStoreBatchError('STORE_UNAVAILABLE')).toEqual({ status: 503, body: { ok: false, error: 'STORE_UNAVAILABLE', retryable: true } });
    expect(mapStoreBatchError('SOURCE_NOT_CONNECTED')).toEqual({ status: 503, body: { ok: false, error: 'STORE_UNAVAILABLE', retryable: true } });
    expect(mapStoreBatchError('BATCH_ID_REUSED')).toEqual({ status: 409, body: { ok: false, error: 'BATCH_ID_REUSED', retryable: false } });
    expect(mapStoreBatchError('QUOTA_EXCEEDED')).toMatchObject({ status: 429, body: { error: 'RATE_LIMITED', retryable: true } });
    expect(mapStoreBatchError('INVALID_INPUT')).toEqual({ status: 400, body: { ok: false, error: 'INVALID_BATCH', retryable: false } });
  });

  it('a chunk A could not store is a retryable STORE_UNAVAILABLE record (re-send in a new batch)', async () => {
    const deps: HealthSyncDeps = {
      ...h.deps,
      writeHealthSamples: async () => ({ ok: true, replay: false, batch_id: BATCH_A, results: [{ source_record_id: 'x', status: 'store_unavailable' }] }),
    };
    const out = await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 1)] }), { channel: 'native' }, deps);
    expect(out.body).toMatchObject({ ok: true, rejected: [{ record_id: 'x', code: 'STORE_UNAVAILABLE', retryable: true }] });
  });
});

describe('store and source states', () => {
  beforeEach(() => h.store.grantConsent(ME, 'sync_activity', 'apple_health'));

  it('STORE_PENDING when B’s table is absent; STORE_UNAVAILABLE when B fails', async () => {
    h.sources.setMode('STORE_PENDING');
    expect(await processHealthSyncBatch(ME, batch(), { channel: 'native' }, h.deps)).toMatchObject({ status: 503, body: { error: 'STORE_PENDING', retryable: true } });
    h.sources.setMode('STORE_UNAVAILABLE');
    expect(await processHealthSyncBatch(ME, batch(), { channel: 'native' }, h.deps)).toMatchObject({ status: 503, body: { error: 'STORE_UNAVAILABLE' } });
    expect(h.writes).toHaveLength(0);
  });

  it('STORE_PENDING when A’s tables are absent; STORE_DISABLED is 409 INGEST_DISABLED', async () => {
    const pending: HealthSyncDeps = { ...h.deps, writeHealthSamples: async () => ({ ok: false, code: 'STORE_PENDING' }) };
    expect(await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 1)] }), { channel: 'native' }, pending)).toMatchObject({ status: 503, body: { error: 'STORE_PENDING' } });
    h.store.setEnabled(false);
    expect(await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 1)] }), { channel: 'native' }, h.deps)).toMatchObject({ status: 409, body: { error: 'INGEST_DISABLED', reason: 'flag_off' } });
  });

  it('a phone store is created on first sync with the install id, and reused after', async () => {
    await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 1)] }), { channel: 'native' }, h.deps);
    await processHealthSyncBatch(ME, batch({ batch_id: BATCH_B, records: [stepsRecord(35, 1)] }), { channel: 'native' }, h.deps);
    expect(h.sources.rows).toHaveLength(1);
    expect(h.sources.rows[0]).toMatchObject({ kind: 'phone_store', connector_id: 'apple_health', provider_user_id: INSTALL_ID });
    expect(h.sources.calls[0]).toEqual({ kind: 'phone_store', connector_id: 'apple_health', provider_user_id: INSTALL_ID, create: true });
  });

  it('a paused or disconnected source answers 409 SOURCE_PAUSED and writes nothing', async () => {
    await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 1)] }), { channel: 'native' }, h.deps);
    for (const status of ['paused', 'disconnected']) {
      h.sources.setStatus(h.sources.rows[0].source_id, status);
      const out = await processHealthSyncBatch(ME, batch({ batch_id: BATCH_B, records: [stepsRecord(35, 1)] }), { channel: 'native' }, h.deps);
      expect(out).toMatchObject({ status: 409, body: { error: 'SOURCE_PAUSED', retryable: false } });
    }
    expect(h.writes).toHaveLength(1);
  });

  it('never throws: a throwing source, store or emitter gives an outcome', async () => {
    const boom = async () => { throw new Error('boom'); };
    expect(await processHealthSyncBatch(ME, batch(), { channel: 'native' }, { ...h.deps, resolveSource: boom })).toMatchObject({ status: 503, body: { error: 'STORE_UNAVAILABLE' } });
    expect(await processHealthSyncBatch(ME, batch(), { channel: 'native' }, { ...h.deps, writeHealthSamples: boom })).toMatchObject({ status: 503 });
    const out = await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 1)] }), { channel: 'native' }, { ...h.deps, emit: boom });
    expect(out.status).toBe(200);
  });
});

describe('OASIS', () => {
  it('payloads carry batch id, source kind, categories, counts and codes — never a value or a record id', async () => {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    const rec = stepsRecord(30, 98765);
    await processHealthSyncBatch(ME, batch({ records: [rec, sleepRecord('sleep-secret-id', 451)] }), { channel: 'native' }, h.deps);
    await processHealthSyncBatch(ME, batch({ batch_id: BATCH_B, records: [sleepRecord('sleep-secret-id', 451)] }), { channel: 'native' }, h.deps);
    const types = h.events.map((e) => e.type);
    expect(types).toEqual(['health.sync.batch.processed', 'health.sync.batch.rejected']);
    const text = JSON.stringify(h.events);
    expect(text).not.toContain('98765');
    expect(text).not.toContain('451');
    expect(text).not.toContain(rec.record_id);
    expect(text).not.toContain('sleep-secret-id');
    expect(h.events[0].payload).toMatchObject({ batch_id: BATCH_A, source_kind: 'apple_health', categories: expect.arrayContaining(['activity', 'sleep']), counts: { stored: 1, rejected: 1 } });
    expect(h.events[0]).toMatchObject({ vtid: 'VTID-05164', actor_id: ME.user_id, actor_role: 'user', surface: 'api' });
  });

  it('an emit failure is logged and never fails the batch', async () => {
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    const out = await processHealthSyncBatch(ME, batch({ records: [stepsRecord(30, 1)] }), { channel: 'native' }, { ...h.deps, emit: async () => ({ ok: false }) });
    expect(out.status).toBe(200);
    expect(h.logs.some((l) => l.event === 'health_sync_oasis_emit_failed')).toBe(true);
  });
});

describe('aggregator channel (Phase 2 interface)', () => {
  it('a fixture adapter maps normalised events into a v1 batch; consent and source are the aggregator’s', async () => {
    const adapter = createFixtureAggregatorAdapter('terra');
    h.sources.addAggregator(ME, 'terra', 'terra-user-1');
    h.store.grantConsent(ME, 'sync_activity', 'terra');
    const s = stepsRecord(30, 321);
    const out = await processAggregatorDelivery(adapter, ME, [{ kind: 'steps', start: s.start, end: s.end, value: 321 }], { provider_user_id: 'terra-user-1', batch_id: BATCH_A }, h.deps);
    expect(out).toMatchObject({ status: 200, body: { counts: { stored: 1 } } });
    expect((h.writes[0] as { via: string }).via).toBe('health_sync_aggregator');
    expect(h.sources.calls[0]).toEqual({ kind: 'aggregator', connector_id: 'terra', provider_user_id: 'terra-user-1' });
  });

  it('an aggregator that is not connected is not created by a delivery', async () => {
    h.store.grantConsent(ME, 'sync_activity', 'terra');
    const s = stepsRecord(30, 1);
    const out = await processAggregatorDelivery(createFixtureAggregatorAdapter('terra'), ME, [{ kind: 'steps', start: s.start, end: s.end, value: 1 }], { provider_user_id: 'nobody', batch_id: BATCH_A }, h.deps);
    expect(out).toMatchObject({ status: 503, body: { error: 'STORE_UNAVAILABLE' } });
    expect(h.sources.rows).toHaveLength(0);
  });

  it('nothing mappable -> null; an adapter batch that breaks the schema is INVALID_BATCH', async () => {
    const adapter = createFixtureAggregatorAdapter('terra');
    expect(await processAggregatorDelivery(adapter, ME, [], { provider_user_id: 'p', batch_id: BATCH_A }, h.deps)).toBeNull();
    const broken = { connector_id: 'terra', toBatch: () => ({ ...validBatch(), user_id: 'x' }) as unknown as HealthSyncBatchV1 };
    expect(await processAggregatorDelivery(broken, ME, [{}], { provider_user_id: 'p', batch_id: BATCH_A }, h.deps)).toMatchObject({ status: 400, body: { error: 'INVALID_BATCH' } });
  });
});

it('the fixed clock used here is the store clock', () => {
  expect(NOW.toISOString()).toBe('2026-10-13T12:00:00.000Z');
});
