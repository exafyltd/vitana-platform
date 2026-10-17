/**
 * VTID-05159 (Health Hub Phase 1 / A2) — the S3/S4/S8/S9 contract, run twice:
 *   1. against the S10 fake (createFakeHealthStore), which B and C use;
 *   2. against the REAL module entry points (writeHealthSamples(sb, …),
 *      readDailyObservations(sb, …), suppressHealthData(sb, …),
 *      registerHealthStoreChangeHook) with Jest mocks: the repository is the
 *      in-memory twin of the A1 SQL functions, the S3 client is a fake, and
 *      S6 sources / D10 consents / OASIS are mocked.
 * Nothing touches a database, S3 or the network.
 */
import { randomUUID } from 'crypto';
import {
  createFakeHealthStore,
  createMemoryHealthDb,
  createMemoryHealthStoreRepository,
  type MemoryHealthDb,
} from '../../src/services/health-store/testing/fake-health-store';

// ---- mocks for the real-module harness ---------------------------------------
let mockRepo: unknown = null;
jest.mock('../../src/services/health-store/health-store-repository', () => {
  const actual = jest.requireActual('../../src/services/health-store/health-store-repository');
  return { ...actual, healthStoreRepository: () => mockRepo };
});
const mockSources = new Map<string, { tenant_id: string; user_id: string; kind: string; connector_id: string | null; status: string }>();
jest.mock('../../src/services/health-sources/health-sources', () => ({
  resolveHealthSource: async (_sb: unknown, identity: { tenant_id: string; user_id: string }, input: { source_id: string }) => {
    const s = mockSources.get(input.source_id);
    if (!s || s.tenant_id !== identity.tenant_id || s.user_id !== identity.user_id) return { ok: false, code: 'SOURCE_NOT_CONNECTED' };
    return { ok: true, source_id: input.source_id, kind: s.kind, connector_id: s.connector_id, status: s.status };
  },
}));
const mockConsents = new Map<string, string>();
const ck = (i: { tenant_id: string; user_id: string }, key: string, r?: string | null) => `${i.tenant_id}|${i.user_id}|${key}|${r ?? ''}`;
jest.mock('../../src/services/consent/health-consent', () => {
  const actual = jest.requireActual('../../src/services/consent/health-consent');
  return {
    ...actual,
    findActiveHealthConsentId: async (_sb: unknown, i: any, key: string, r?: string | null) => mockConsents.get(ck(i, key, r)) ?? null,
    hasHealthConsent: async (_sb: unknown, i: any, key: string, r?: string | null) => mockConsents.has(ck(i, key, r)),
  };
});
const mockEmit = jest.fn(async (..._a: unknown[]) => ({ ok: true }));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => mockEmit(...a) }));

import { writeHealthSamples, type WriteHealthSamplesInput } from '../../src/services/health-store/ingest';
import { readDailyObservations, type ReadDailyObservationsOptions } from '../../src/services/health-store/reader';
import { suppressHealthData, unsuppressHealthData, type SuppressionInput } from '../../src/services/health-store/suppression';
import { healthStoreHooks, registerHealthStoreChangeHook, type HealthStoreChangeHook } from '../../src/services/health-store/change-hook';
import { setHealthRawS3ClientForTests, decodeRawBatch } from '../../src/services/health-store/raw-batch-store';

// ---- a fake S3 client for the real raw-batch store ------------------------------
function fakeS3() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async send(cmd: { constructor: { name: string }; input: any }) {
      const i = cmd.input;
      switch (cmd.constructor.name) {
        case 'PutObjectCommand':
          objects.set(i.Key, Buffer.from(i.Body));
          return {};
        case 'GetObjectCommand': {
          const b = objects.get(i.Key);
          if (!b) throw Object.assign(new Error('nope'), { name: 'NoSuchKey' });
          return { Body: { transformToByteArray: async () => new Uint8Array(b) } };
        }
        case 'DeleteObjectCommand':
          objects.delete(i.Key);
          return {};
        case 'ListObjectsV2Command':
          return { Contents: Array.from(objects.keys()).filter((k) => k.startsWith(i.Prefix)).map((Key) => ({ Key })), IsTruncated: false };
        case 'DeleteObjectsCommand':
          for (const o of i.Delete.Objects) objects.delete(o.Key);
          return { Errors: [] };
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    },
  };
}

// ---- the harness interface ---------------------------------------------------------
interface Harness {
  db: MemoryHealthDb;
  write(input: WriteHealthSamplesInput): ReturnType<typeof writeHealthSamples>;
  readDaily(identity: Identity, o: ReadDailyObservationsOptions): ReturnType<typeof readDailyObservations>;
  suppress(identity: Identity, i?: SuppressionInput): ReturnType<typeof suppressHealthData>;
  unsuppress(identity: Identity, i?: SuppressionInput): ReturnType<typeof unsuppressHealthData>;
  register(fn: HealthStoreChangeHook): () => void;
  flush(): Promise<void>;
  addSource(identity: Identity, kind: string, connector_id: string | null, status?: string): string;
  grant(identity: Identity, key: string, resource?: string | null): string;
  revoke(identity: Identity, key: string, resource?: string | null): void;
  rawCount(): number;
  rawPayloads(): unknown[];
  setEnabled(on: boolean): void;
}
type Identity = { tenant_id: string; user_id: string };

function fakeHarness(): Harness {
  const store = createFakeHealthStore();
  return {
    db: store.db,
    write: (input) => store.writeHealthSamples(null, input),
    readDaily: (identity, o) => store.readDailyObservations(null, identity, o),
    suppress: (identity, i) => store.suppressHealthData(null, identity, i),
    unsuppress: (identity, i) => store.unsuppressHealthData(null, identity, i),
    register: (fn) => store.registerHealthStoreChangeHook(fn),
    flush: () => store.flushHooks(),
    addSource: (identity, kind, connector_id, status = 'connected') =>
      store.addSource({ ...identity, kind: kind as any, connector_id, status: status as any }),
    grant: (identity, key, resource) => store.grantConsent(identity, key as any, resource),
    revoke: (identity, key, resource) => store.revokeConsent(identity, key as any, resource),
    rawCount: () => store.raw.objects.size,
    rawPayloads: () => Array.from(store.raw.objects.values()),
    setEnabled: (on) => store.setEnabled(on),
  };
}

function realHarness(): Harness {
  const db = createMemoryHealthDb();
  mockRepo = createMemoryHealthStoreRepository(db);
  mockSources.clear();
  mockConsents.clear();
  healthStoreHooks.clear();
  const s3 = fakeS3();
  setHealthRawS3ClientForTests(s3);
  process.env.HEALTH_STORE_ENABLED = 'true';
  process.env.HEALTH_RAW_BUCKET = 'vitana-health-raw-test';
  delete process.env.VITANA_ENV;
  const sb = {} as never;
  return {
    db,
    write: (input) => writeHealthSamples(sb, input),
    readDaily: (identity, o) => readDailyObservations(sb, identity, o),
    suppress: (identity, i) => suppressHealthData(sb, identity, i),
    unsuppress: (identity, i) => unsuppressHealthData(sb, identity, i),
    register: (fn) => registerHealthStoreChangeHook(fn),
    flush: () => healthStoreHooks.flush(),
    addSource: (identity, kind, connector_id, status = 'connected') => {
      const id = randomUUID();
      mockSources.set(id, { ...identity, kind, connector_id, status });
      return id;
    },
    grant: (identity, key, resource) => {
      const id = randomUUID();
      mockConsents.set(ck(identity, key, resource), id);
      return id;
    },
    revoke: (identity, key, resource) => {
      mockConsents.delete(ck(identity, key, resource));
    },
    rawCount: () => s3.objects.size,
    rawPayloads: () => Array.from(s3.objects.values()).map((b) => decodeRawBatch(b)),
    setEnabled: (on) => {
      process.env.HEALTH_STORE_ENABLED = on ? 'true' : 'false';
    },
  };
}

afterAll(() => {
  setHealthRawS3ClientForTests(null);
  delete process.env.HEALTH_STORE_ENABLED;
  delete process.env.HEALTH_RAW_BUCKET;
});

// ---- time helpers (relative to the real clock: both harnesses use it) ----------------
const FIVE = 5 * 60 * 1000;
const bucketAgo = (minutes: number) => new Date(Math.floor((Date.now() - minutes * 60 * 1000) / FIVE) * FIVE).toISOString();
const todayUtc = () => new Date().toISOString().slice(0, 10);
const daysAgoDate = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

const ME: Identity = { tenant_id: '10000000-0000-0000-0000-000000000001', user_id: 'a0000000-0000-0000-0000-00000000000a' };
const OTHER: Identity = { tenant_id: '10000000-0000-0000-0000-000000000001', user_id: 'b0000000-0000-0000-0000-00000000000b' };

function input(source_id: string, samples: WriteHealthSamplesInput['samples'], deletions: WriteHealthSamplesInput['deletions'] = [], batch_id = randomUUID()): WriteHealthSamplesInput {
  return { identity: ME, source_id, batch_id, via: 'internal', tz: 'UTC', samples, deletions };
}

const steps = (start: string, value: number) => ({ source_record_id: `steps:${start}`, code: 'steps', unit: '{steps}', start, value });
const weight = (id: string, start: string, value: number) => ({ source_record_id: id, code: 'body_weight', unit: 'kg', start, value });

describe.each([
  ['S10 fake', fakeHarness],
  ['real module with mocks', realHarness],
])('health store contract — %s (VTID-05159)', (_name, make) => {
  let h: Harness;
  let oura: string;
  beforeEach(() => {
    h = make();
    oura = h.addSource(ME, 'device_cloud', 'oura');
    h.grant(ME, 'wearables', 'oura');
  });

  it('disabled: STORE_DISABLED and nothing is read or written', async () => {
    h.setEnabled(false);
    const r = await h.write(input(oura, [steps(bucketAgo(30), 100)]));
    expect(r).toEqual({ ok: false, code: 'STORE_DISABLED' });
    expect(h.db.calls).toEqual([]);
    expect(h.rawCount()).toBe(0);
    expect(await h.readDaily(ME, { codes: ['steps'], from: todayUtc(), to: todayUtc(), purpose: 'member_view' })).toEqual({ ok: false, code: 'STORE_DISABLED' });
  });

  it('stores a series bucket and a record; the reader returns the daily values', async () => {
    const b = bucketAgo(30);
    const r = await h.write(input(oura, [steps(b, 420), weight('w-1', new Date(Date.now() - 3600000).toISOString(), 71.5)]));
    expect(r).toMatchObject({ ok: true, replay: false });
    if (!r.ok) throw new Error('unreachable');
    expect(r.results.map((x) => x.status)).toEqual(['stored', 'stored']);
    expect(h.rawCount()).toBe(1);

    const date = b.slice(0, 10);
    const read = await h.readDaily(ME, { codes: ['steps', 'body_weight'], from: daysAgoDate(1), to: todayUtc(), purpose: 'feature_compute' });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    const stepsRow = read.rows.find((x) => x.code === 'steps' && x.date === date);
    expect(stepsRow).toMatchObject({ value: 420, unit: '{steps}', sources: [{ source_id: oura, source_kind: 'device_cloud', value: 420 }] });
    expect(read.rows.find((x) => x.code === 'body_weight')).toMatchObject({ value: 71.5, unit: 'kg', sample_count: 1 });
  });

  it('batch replay: same batch_id + content -> replay:true, nothing written; new content -> BATCH_ID_REUSED', async () => {
    const id = randomUUID();
    const first = await h.write(input(oura, [steps(bucketAgo(30), 5)], [], id));
    expect(first.ok).toBe(true);
    const ingestCalls = h.db.calls.filter((c) => c === 'ingestChunk').length;
    const again = await h.write(input(oura, [steps(bucketAgo(30), 5)], [], id));
    expect(again).toEqual({ ...first, replay: true });
    expect(h.db.calls.filter((c) => c === 'ingestChunk').length).toBe(ingestCalls);
    expect(await h.write(input(oura, [steps(bucketAgo(30), 6)], [], id))).toEqual({ ok: false, code: 'BATCH_ID_REUSED' });
  });

  it('replace mode: same key + same content -> duplicate, new content -> updated', async () => {
    const b = bucketAgo(30);
    await h.write(input(oura, [steps(b, 5)]));
    const dup = await h.write(input(oura, [steps(b, 5)]));
    const upd = await h.write(input(oura, [steps(b, 9)]));
    expect(dup.ok && dup.results[0].status).toBe('duplicate');
    expect(upd.ok && upd.results[0].status).toBe('updated');
  });

  it('no consent: skipped_no_consent (CONSENT_REQUIRED), no S3 object, no store write', async () => {
    h.revoke(ME, 'wearables', 'oura');
    const r = await h.write(input(oura, [steps(bucketAgo(30), 5)]));
    expect(r.ok && r.results[0]).toEqual({ source_record_id: expect.any(String), status: 'skipped_no_consent', code: 'CONSENT_REQUIRED' });
    expect(h.rawCount()).toBe(0);
    expect(h.db.calls).not.toContain('ingestChunk');
  });

  it('a (source kind, category) with no D10 key is refused: CONSENT_CATEGORY_MISSING', async () => {
    // VTID-05164 (C1) filled phone_store activity|sleep|heart|body -> sync_*; habits stays keyless.
    const phone = h.addSource(ME, 'phone_store', 'apple_health');
    const water = { source_record_id: 'water-1', code: 'water_intake', unit: 'mL', start: bucketAgo(30), value: 250 };
    const r = await h.write(input(phone, [water]));
    expect(r.ok && r.results[0].code).toBe('CONSENT_CATEGORY_MISSING');
    expect(h.rawCount()).toBe(0);
  });

  it('a phone store needs the per-source sync_<category> consent (VTID-05164 keys)', async () => {
    const phone = h.addSource(ME, 'phone_store', 'apple_health');
    const before = await h.write(input(phone, [steps(bucketAgo(30), 5)]));
    expect(before.ok && before.results[0]).toMatchObject({ status: 'skipped_no_consent', code: 'CONSENT_REQUIRED' });
    h.grant(ME, 'sync_activity', 'health_connect'); // another source's consent does not count
    const other = await h.write(input(phone, [steps(bucketAgo(35), 5)]));
    expect(other.ok && other.results[0].status).toBe('skipped_no_consent');
    h.grant(ME, 'sync_activity', 'apple_health');
    const after = await h.write(input(phone, [steps(bucketAgo(40), 5)]));
    expect(after.ok && after.results[0].status).toBe('stored');
  });

  it("an unknown or another member's source: SOURCE_NOT_CONNECTED", async () => {
    const theirs = h.addSource(OTHER, 'device_cloud', 'oura');
    expect(await h.write(input(theirs, [steps(bucketAgo(30), 5)]))).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
    expect(await h.write(input(randomUUID(), [steps(bucketAgo(30), 5)]))).toEqual({ ok: false, code: 'SOURCE_NOT_CONNECTED' });
  });

  it('deletions are processed without consent and fire the change hook with the dates', async () => {
    const b = bucketAgo(30);
    await h.write(input(oura, [steps(b, 5), weight('w-del', b, 70)]));
    h.revoke(ME, 'wearables', 'oura');
    const hook = jest.fn(async () => undefined);
    const off = h.register(hook);
    const r = await h.write(input(oura, [], [{ source_record_id: `steps:${b}`, code: 'steps' }, { source_record_id: 'w-del', code: 'body_weight' }, { source_record_id: 'nope', code: 'body_weight' }]));
    expect(r.ok && r.results.map((x) => x.status)).toEqual(['deleted', 'deleted', 'not_found']);
    await h.flush();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(ME, { dates: [b.slice(0, 10)], categories: expect.arrayContaining(['activity', 'body']), source_id: oura });
    off();
  });

  it('suppress hides rows from every read and fires the hook; unsuppress restores them', async () => {
    const b = bucketAgo(30);
    await h.write(input(oura, [steps(b, 77)]));
    const hook = jest.fn(async () => undefined);
    const off = h.register(hook);
    const q = { codes: ['steps'], from: daysAgoDate(1), to: todayUtc(), purpose: 'member_view' as const };
    const s = await h.suppress(ME, { category: 'activity', source_id: oura });
    expect(s.ok).toBe(true);
    const hidden = await h.readDaily(ME, q);
    expect(hidden.ok && hidden.rows).toEqual([]);
    // a resend of withdrawn data never resurrects it
    const resend = await h.write(input(oura, [steps(b, 77)]));
    expect(resend.ok && resend.results[0]).toMatchObject({ status: 'skipped_no_consent', code: 'WITHDRAWN' });
    const u = await h.unsuppress(ME, { category: 'activity', source_id: oura });
    expect(u.ok).toBe(true);
    const back = await h.readDaily(ME, q);
    expect(back.ok && back.rows.map((x) => x.value)).toEqual([77]);
    await h.flush();
    expect(hook).toHaveBeenCalledTimes(2);
    off();
  });

  it('suppress deletes the raw batches of that source', async () => {
    await h.write(input(oura, [steps(bucketAgo(30), 5)]));
    expect(h.rawCount()).toBe(1);
    const s = await h.suppress(ME, { category: 'heart', source_id: oura });
    expect(s.ok && s.raw).toEqual({ deleted: 1, residual: 0 });
    expect(h.rawCount()).toBe(0);
  });

  it('reads require a purpose; ai_context requires ai_health_analysis (fail closed, repository not called)', async () => {
    const base = { codes: ['steps'], from: todayUtc(), to: todayUtc() };
    expect(await h.readDaily(ME, base as any)).toEqual({ ok: false, code: 'PURPOSE_REQUIRED' });
    expect(await h.readDaily(ME, { ...base, purpose: 'ai_context' })).toEqual({ ok: false, code: 'consent_required' });
    expect(h.db.calls).toEqual([]);
    h.grant(ME, 'ai_health_analysis');
    expect((await h.readDaily(ME, { ...base, purpose: 'ai_context' })).ok).toBe(true);
  });

  it('quarantines an implausible value without its value; valid items in the same batch are stored', async () => {
    const r = await h.write(input(oura, [steps(bucketAgo(30), 500000), steps(bucketAgo(60), 10)]));
    expect(r.ok && r.results.map((x) => [x.status, x.code])).toEqual([
      ['quarantined', 'IMPLAUSIBLE'],
      ['stored', undefined],
    ]);
    expect(h.db.quarantine).toHaveLength(1);
    expect(h.db.quarantine[0]).not.toHaveProperty('value');
    expect(h.db.quarantine[0]).toMatchObject({ reason: 'IMPLAUSIBLE', code_key: 'steps', item_index: 0 });
  });

  it('the raw archive holds only the consented subset', async () => {
    const phone = h.addSource(ME, 'device_cloud', 'fitbit'); // no consent for fitbit
    await h.write(input(phone, [steps(bucketAgo(30), 5)]));
    expect(h.rawCount()).toBe(0);
    await h.write(input(oura, [steps(bucketAgo(30), 5)]));
    const payloads = h.rawPayloads() as Array<{ samples: unknown[] }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].samples).toHaveLength(1);
  });

  it('more than 5,000 items: INVALID_INPUT', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => weight(`w-${i}`, bucketAgo(30), 70));
    expect(await h.write(input(oura, many))).toEqual({ ok: false, code: 'INVALID_INPUT' });
  });

  it('consent id is stored on rows and on the batch row', async () => {
    h.revoke(ME, 'wearables', 'oura');
    const consentId = h.grant(ME, 'wearables', 'oura');
    await h.write(input(oura, [steps(bucketAgo(30), 5), weight('w-c', bucketAgo(30), 70)]));
    for (const r of h.db.s5m.values()) expect(r.consent_id).toBe(consentId);
    for (const r of h.db.obs.values()) expect(r.consent_id).toBe(consentId);
    expect(h.db.batches[0].consent_id).toBe(consentId);
  });
});
