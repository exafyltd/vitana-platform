/**
 * VTID-05159 (Health Hub Phase 1 / A2) — /api/v1/health/internal routes,
 * the real raw-batch store over a fake S3 client, and the S7 consent lookup
 * findActiveHealthConsentId. The repository is the in-memory twin of the A1
 * SQL functions; auth, S6, D10 and OASIS are mocked. No database, S3 or network.
 */
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createMemoryHealthDb, createMemoryHealthStoreRepository, type MemoryHealthDb } from '../../src/services/health-store/testing/fake-health-store';

let mockRepo: unknown = null;
jest.mock('../../src/services/health-store/health-store-repository', () => {
  const actual = jest.requireActual('../../src/services/health-store/health-store-repository');
  return { ...actual, healthStoreRepository: () => mockRepo };
});
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, res: any, next: any) => {
    const u = req.headers['x-test-user'];
    if (!u) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: u, tenant_id: 't' };
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
const mockSources = new Map<string, any>();
jest.mock('../../src/services/health-sources/health-sources', () => ({
  resolveHealthSource: async (_sb: unknown, identity: any, input: { source_id: string }) => {
    const s = mockSources.get(input.source_id);
    if (!s || s.user_id !== identity.user_id) return { ok: false, code: 'SOURCE_NOT_CONNECTED' };
    return { ok: true, source_id: input.source_id, kind: s.kind, connector_id: s.connector_id, status: 'connected' };
  },
}));
const mockConsents = new Set<string>();
jest.mock('../../src/services/consent/health-consent', () => {
  const actual = jest.requireActual('../../src/services/consent/health-consent');
  return {
    ...actual,
    findActiveHealthConsentId: async (_sb: unknown, i: any, key: string, r?: string) => (mockConsents.has(`${i.user_id}|${key}|${r ?? ''}`) ? 'consent-1' : null),
    hasHealthConsent: async () => false,
  };
});
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: async () => ({ ok: true }) }));

import router from '../../src/routes/health-store-internal';
import { setHealthRawS3ClientForTests, rawBatchKey, rawBatchPrefix, s3RawBatchStore } from '../../src/services/health-store/raw-batch-store';
import { writeHealthSamples } from '../../src/services/health-store/ingest';

const app = express();
app.use(express.json());
app.use('/api/v1/health/internal', router);

const U1 = 'a0000000-0000-0000-0000-00000000000a';
const U2 = 'b0000000-0000-0000-0000-00000000000b';
const S1 = 'c0000000-0000-0000-0000-00000000000c';
const S2 = 'd0000000-0000-0000-0000-00000000000d';

function fakeS3(opts: { pageSize?: number; failList?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  return {
    objects,
    calls,
    async send(cmd: { constructor: { name: string }; input: any }) {
      const i = cmd.input;
      calls.push(cmd.constructor.name);
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
        case 'ListObjectsV2Command': {
          if (opts.failList) throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
          const all = Array.from(objects.keys()).filter((k) => k.startsWith(i.Prefix)).sort();
          const size = opts.pageSize ?? 1000;
          const start = i.ContinuationToken ? Number(i.ContinuationToken) : 0;
          const page = all.slice(start, start + size);
          const more = start + size < all.length;
          return { Contents: page.map((Key) => ({ Key })), IsTruncated: more, NextContinuationToken: more ? String(start + size) : undefined };
        }
        case 'DeleteObjectsCommand':
          for (const o of i.Delete.Objects) objects.delete(o.Key);
          return { Errors: [] };
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    },
  };
}

let db: MemoryHealthDb;
let s3: ReturnType<typeof fakeS3>;
const ENV_KEYS = ['HEALTH_STORE_ENABLED', 'HEALTH_RAW_BUCKET', 'VITANA_ENV', 'GATEWAY_INTERNAL_TOKEN', 'GATEWAY_SERVICE_TOKEN'];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setHealthRawS3ClientForTests(null);
});

beforeEach(() => {
  db = createMemoryHealthDb();
  mockRepo = createMemoryHealthStoreRepository(db);
  s3 = fakeS3();
  setHealthRawS3ClientForTests(s3);
  mockSources.clear();
  mockConsents.clear();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATEWAY_INTERNAL_TOKEN = 'internal-secret';
  process.env.GATEWAY_SERVICE_TOKEN = 'service-secret';
});

const enable = () => {
  process.env.HEALTH_STORE_ENABLED = 'true';
  process.env.HEALTH_RAW_BUCKET = 'vitana-health-raw-test';
};

describe('GET /store-status (VTID-05159)', () => {
  it('needs a member JWT (401 JSON without one)', async () => {
    const r = await request(app).get('/api/v1/health/internal/store-status');
    expect(r.status).toBe(401);
    expect(r.headers['content-type']).toMatch(/json/);
  });

  it('reports {enabled:false, reason:"staging"} on staging and the flag state elsewhere', async () => {
    process.env.VITANA_ENV = 'staging';
    process.env.HEALTH_STORE_ENABLED = 'true';
    process.env.HEALTH_RAW_BUCKET = 'b';
    const r = await request(app).get('/api/v1/health/internal/store-status').set('x-test-user', U1);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, enabled: false, reason: 'staging' });
    delete process.env.VITANA_ENV;
    const on = await request(app).get('/api/v1/health/internal/store-status').set('x-test-user', U1);
    expect(on.body).toEqual({ ok: true, enabled: true, reason: null });
    delete process.env.HEALTH_STORE_ENABLED;
    const off = await request(app).get('/api/v1/health/internal/store-status').set('x-test-user', U1);
    expect(off.body).toEqual({ ok: true, enabled: false, reason: 'flag_off' });
  });
});

describe('POST /maintenance (VTID-05159)', () => {
  const url = '/api/v1/health/internal/maintenance';

  it('rejects without X-Gateway-Internal (401), with a wrong one (403), and fails closed with no token configured (503)', async () => {
    enable();
    expect((await request(app).post(url)).status).toBe(401);
    expect((await request(app).post(url).set('X-Gateway-Internal', 'nope')).status).toBe(403);
    delete process.env.GATEWAY_INTERNAL_TOKEN;
    expect((await request(app).post(url).set('X-Gateway-Internal', 'internal-secret')).status).toBe(503);
    expect(db.calls).toEqual([]);
  });

  it('store off -> 404 HEALTH_STORE_DISABLED, nothing read', async () => {
    const r = await request(app).post(url).set('X-Gateway-Internal', 'internal-secret').send({ partition_check: true });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, error: 'HEALTH_STORE_DISABLED' });
    expect(db.calls).toEqual([]);
  });

  it('store on -> ensure then purge (+ partition check on request), 200', async () => {
    enable();
    const r = await request(app).post(url).set('X-Gateway-Internal', 'internal-secret').send({ partition_check: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, missing_partitions: [] });
    expect(db.calls).toEqual(['ensurePartitions', 'purge', 'partitionCheck', 'capacitySnapshot']);
  });

  it('a failing run answers 500 MAINTENANCE_FAILED with codes, never a DB message', async () => {
    enable();
    db.fail.purge = { code: 'XX000', message: 'secret detail' };
    const r = await request(app).post(url).set('X-Gateway-Internal', 'internal-secret');
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ ok: false, error: 'MAINTENANCE_FAILED', errors: ['purge:STORE_UNAVAILABLE'] });
    expect(JSON.stringify(r.body)).not.toContain('secret detail');
  });
});

describe('POST /reprocess (VTID-05159)', () => {
  const url = '/api/v1/health/internal/reprocess';
  const auth = { Authorization: 'Bearer service-secret' };

  it('needs the service token or an exafy_admin JWT; off -> 404; bad body -> 400', async () => {
    expect((await request(app).post(url).send({ batch_id: randomUUID() })).status).toBe(401);
    const off = await request(app).post(url).set(auth).send({ batch_id: randomUUID() });
    expect(off.status).toBe(404);
    expect(off.body.error).toBe('HEALTH_STORE_DISABLED');
    enable();
    expect((await request(app).post(url).set(auth).send({ batch_id: 'x' })).status).toBe(400);
    const missing = await request(app).post(url).set(auth).send({ batch_id: randomUUID() });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('BATCH_NOT_FOUND');
  });

  it('re-checks the CURRENT consent: revoked -> nothing written', async () => {
    enable();
    mockSources.set(S1, { user_id: U1, kind: 'device_cloud', connector_id: 'oura' });
    mockConsents.add(`${U1}|wearables|oura`);
    const w = await writeHealthSamples({} as never, {
      identity: { tenant_id: 't', user_id: U1 }, source_id: S1, batch_id: randomUUID(), via: 'internal', tz: 'UTC', deletions: [],
      samples: [{ source_record_id: 'w1', code: 'body_weight', unit: 'kg', start: new Date(Date.now() - 3600000).toISOString(), value: 70 }],
    });
    expect(w.ok).toBe(true);
    db.obs.clear();
    mockConsents.clear();
    const r = await request(app).post(url).set(auth).send({ batch_id: db.batches[0].batch_id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, counts: { skipped_no_consent: 1 } });
    expect(db.obs.size).toBe(0);
  });
});

describe('POST /erase-raw (VTID-05159)', () => {
  const url = '/api/v1/health/internal/erase-raw';
  const auth = { Authorization: 'Bearer service-secret' };
  const put = (u: string, s: string) => s3.objects.set(rawBatchKey(u, s, randomUUID(), new Date()), Buffer.from('x'));

  it('needs the service token; no bucket -> 404 HEALTH_STORE_DISABLED (A3 counts it as nothing to erase)', async () => {
    expect((await request(app).post(url).send({ user_id: U1 })).status).toBe(401);
    const r = await request(app).post(url).set(auth).send({ user_id: U1 });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, error: 'HEALTH_STORE_DISABLED' });
    process.env.HEALTH_RAW_BUCKET = 'b';
    process.env.VITANA_ENV = 'staging';
    expect((await request(app).post(url).set(auth).send({ user_id: U1 })).status).toBe(404);
  });

  it("deletes only the member's prefix, lists again and reports residual — even with the store flag off", async () => {
    process.env.HEALTH_RAW_BUCKET = 'vitana-health-raw-test'; // flag off: a rolled-back store still erases
    put(U1, S1); put(U1, S1); put(U1, S2); put(U2, S1);
    const r = await request(app).post(url).set(auth).send({ user_id: U1 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, deleted: 3, residual: 0 });
    expect(Array.from(s3.objects.keys()).every((k) => k.startsWith(`u/${U2}/`))).toBe(true);
  });

  it('a source_id narrows the erasure to that source (withdrawal)', async () => {
    process.env.HEALTH_RAW_BUCKET = 'vitana-health-raw-test';
    put(U1, S1); put(U1, S2);
    const r = await request(app).post(url).set(auth).send({ user_id: U1, source_id: S1 });
    expect(r.body).toEqual({ ok: true, deleted: 1, residual: 0 });
    expect(Array.from(s3.objects.keys())).toEqual([expect.stringContaining(`u/${U1}/${S2}/`)]);
  });

  it('bad ids -> 400; an S3 failure -> 503 STORE_UNAVAILABLE', async () => {
    process.env.HEALTH_RAW_BUCKET = 'vitana-health-raw-test';
    expect((await request(app).post(url).set(auth).send({ user_id: 'x' })).status).toBe(400);
    expect((await request(app).post(url).set(auth).send({ user_id: U1, source_id: '../' })).status).toBe(400);
    setHealthRawS3ClientForTests(fakeS3({ failList: true }));
    const r = await request(app).post(url).set(auth).send({ user_id: U1 });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, error: 'STORE_UNAVAILABLE' });
  });
});

describe('raw-batch store over S3 (VTID-05159)', () => {
  it('keys and prefixes; never a bucket-wide prefix', () => {
    expect(rawBatchKey(U1, S1, 'b', new Date('2026-10-03T23:59:59Z'))).toBe(`u/${U1}/${S1}/2026/10/03/b.json.gz`);
    expect(rawBatchPrefix(U1)).toBe(`u/${U1}/`);
    expect(rawBatchPrefix(U1, S1)).toBe(`u/${U1}/${S1}/`);
    expect(rawBatchPrefix('')).toBeNull();
    expect(rawBatchPrefix(U1, 'x')).toBeNull();
  });

  it('puts gzip JSON with SSE-KMS, reads it back, pages through listings when erasing', async () => {
    const paged = fakeS3({ pageSize: 2 });
    setHealthRawS3ClientForTests(paged);
    const store = s3RawBatchStore('bkt');
    const sent: any[] = [];
    const orig = paged.send.bind(paged);
    paged.send = async (cmd: any) => {
      sent.push(cmd.input);
      return orig(cmd);
    };
    for (let i = 0; i < 5; i++) expect(await store.put(rawBatchKey(U1, S1, `b${i}`, new Date()), { i })).toEqual({ ok: true });
    expect(sent[0]).toMatchObject({ Bucket: 'bkt', ServerSideEncryption: 'aws:kms', ContentEncoding: 'gzip' });
    expect(await store.get(rawBatchKey(U1, S1, 'b3', new Date()))).toEqual({ ok: true, payload: { i: 3 } });
    expect(await store.get('u/none')).toEqual({ ok: true, payload: null });
    expect(await store.erasePrefix(`u/${U1}/`)).toEqual({ ok: true, deleted: 5, residual: 0 });
    expect(await store.erasePrefix('u/')).toEqual({ ok: false, code: 'INVALID_INPUT' });
  });
});

describe('S7 findActiveHealthConsentId (VTID-05159)', () => {
  const real = jest.requireActual('../../src/services/consent/health-consent') as typeof import('../../src/services/consent/health-consent');

  function client(result: { data: unknown; error: unknown } | 'throw') {
    const calls: Array<[string, unknown[]]> = [];
    const chain: any = {};
    for (const m of ['select', 'eq', 'is']) chain[m] = (...a: unknown[]) => (calls.push([m, a]), chain);
    chain.maybeSingle = async () => {
      if (result === 'throw') throw new Error('net');
      return result;
    };
    return { sb: { from: (t: string) => (calls.push(['from', [t]]), chain) } as any, calls };
  }
  const ID = { tenant_id: 't1', user_id: U1 };

  it('returns the active row id with the same query as hasHealthConsent', async () => {
    const { sb, calls } = client({ data: { id: 'consent-9' }, error: null });
    expect(await real.findActiveHealthConsentId(sb, ID, 'wearables', 'oura')).toBe('consent-9');
    expect(calls).toEqual([
      ['from', ['data_sharing_consents']],
      ['select', ['id']],
      ['eq', ['tenant_id', 't1']],
      ['eq', ['user_id', U1]],
      ['eq', ['resource_type', 'health_source']],
      ['eq', ['resource_id', 'oura']],
      ['eq', ['scope', 'ingestion']],
      ['is', ['revoked_at', null]],
    ]);
  });

  it('fails closed: no row, an error, a throw, an unknown category or a missing resource -> null', async () => {
    expect(await real.findActiveHealthConsentId(client({ data: null, error: null }).sb, ID, 'wearables', 'oura')).toBeNull();
    expect(await real.findActiveHealthConsentId(client({ data: null, error: { message: 'x' } }).sb, ID, 'wearables', 'oura')).toBeNull();
    expect(await real.findActiveHealthConsentId(client('throw').sb, ID, 'wearables', 'oura')).toBeNull();
    expect(await real.findActiveHealthConsentId(client({ data: { id: 'c' }, error: null }).sb, ID, 'nope' as never)).toBeNull();
    expect(await real.findActiveHealthConsentId(client({ data: { id: 'c' }, error: null }).sb, ID, 'wearables')).toBeNull();
    expect(await real.findActiveHealthConsentId(client({ data: { id: 'c' }, error: null }).sb, ID, 'ai_health_analysis')).toBe('c');
  });
});
