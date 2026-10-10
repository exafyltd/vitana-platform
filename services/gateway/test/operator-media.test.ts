/**
 * VTID-05067: POST/GET /api/v1/operator/media — images pasted into the Operator Console.
 *
 * The real route and the real media service run against an in-memory Supabase (Storage
 * objects + signing + the operator_media table). Pins: auth 401 JSON; owner-only (403);
 * type by magic bytes (svg refused, a GIF labelled PNG refused, text refused), size (413),
 * empty (400); the object path <user>/<thread>/<uuid>.<ext>; a 1-hour signed URL on the
 * PUBLIC Supabase origin; GET re-signs for the owner only; OASIS gets ids, never bytes;
 * the per-message cap and owner check used where runs and chat turns start; the bucket
 * setup script uses the Storage API and is idempotent.
 */
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'child_process';
import { join } from 'path';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAdminAuth: (req: any, res: any, next: any) => {
    const user = req.header('x-test-user');
    if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: user, exafy_admin: true };
    return next();
  },
}));
const ownership = { owner: null as string | null };
jest.mock('../src/services/kiro/kiro-runs', () => ({
  kiroThreadOwnership: jest.fn(async () => ({ owner: ownership.owner, engine: null, otherRunOwners: [] })),
}));
const oasis: any[] = [];
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async (e: any) => { oasis.push(e); return { ok: true }; }) }));

import router from '../src/routes/operator-media';
import {
  sniffImageType, loadOperatorMediaForUser, readOperatorMediaBase64, OPERATOR_MEDIA_LIMITS,
} from '../src/services/operator-media';

const SUPA = 'http://supa.internal:8000';
const EMPTY_STATUS = 400;
const OWNER = 'd1111111-1111-4111-8111-111111111111';
const OTHER = 'e2222222-2222-4222-8222-222222222222';
const THREAD = 'a5067000-0000-4000-8000-000000000001';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(40, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), Buffer.alloc(40, 4)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

// ---- in-memory Supabase: Storage objects + signing + operator_media rows ----
const objects = new Map<string, { type: string; bytes: Buffer }>();
const rows: any[] = [];
const signCalls: Array<{ path: string; expiresIn: number }> = [];
const realFetch = (global as any).fetch;

async function fakeSupabase(input: any, init: any = {}) {
  const url = new URL(String(input));
  const method = (init.method || 'GET').toUpperCase();
  const auth = (init.headers || {}).Authorization;
  if (auth !== 'Bearer service-key') return new Response('{"message":"no service role"}', { status: 401 });
  const p = decodeURIComponent(url.pathname);
  if (p.startsWith('/storage/v1/object/sign/operator-media/') && method === 'POST') {
    const path = p.slice('/storage/v1/object/sign/operator-media/'.length);
    if (!objects.has(path)) return new Response('{"error":"not_found"}', { status: 400 });
    signCalls.push({ path, expiresIn: JSON.parse(init.body).expiresIn });
    return new Response(JSON.stringify({ signedURL: `/object/sign/operator-media/${path}?token=t1` }), { status: 200 });
  }
  if (p.startsWith('/storage/v1/object/operator-media/')) {
    const path = p.slice('/storage/v1/object/operator-media/'.length);
    if (method === 'POST') { objects.set(path, { type: init.headers['Content-Type'], bytes: Buffer.from(init.body) }); return new Response('{"Key":"x"}', { status: 200 }); }
    const o = objects.get(path);
    return o ? new Response(o.bytes, { status: 200 }) : new Response('{}', { status: 400 });
  }
  if (p === '/rest/v1/operator_media') {
    if (method === 'POST') { rows.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
    const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
    return new Response(JSON.stringify(rows.filter((r) => r.id === id)), { status: 200 });
  }
  return new Response('{}', { status: 404 });
}

function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/v1/operator/media', router);
  return a;
}
const upload = (body: Buffer, type: string, user: string | null = OWNER, thread = THREAD) => {
  let r = request(app()).post(`/api/v1/operator/media?thread_id=${thread}`).set('Content-Type', type);
  if (user) r = r.set('x-test-user', user);
  return r.send(body);
};

beforeEach(() => {
  objects.clear(); rows.length = 0; signCalls.length = 0; oasis.length = 0; ownership.owner = null;
  process.env.SUPABASE_URL = SUPA;
  process.env.SUPABASE_SERVICE_ROLE = 'service-key';
  process.env.SUPABASE_PUBLIC_URL = 'https://project.supabase.co';
  (global as any).fetch = jest.fn(fakeSupabase);
});
afterAll(() => { (global as any).fetch = realFetch; delete process.env.SUPABASE_PUBLIC_URL; });

describe('magic bytes', () => {
  it('recognises png / jpeg / gif / webp and nothing else', () => {
    expect([PNG, JPEG, GIF, WEBP].map(sniffImageType)).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(Buffer.from('hello world, plain text'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(4))).toBeNull();
  });
});

describe('POST /api/v1/operator/media', () => {
  it('401 JSON without a caller (POST and GET)', async () => {
    const res = await upload(PNG, 'image/png', null);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const get = await request(app()).get(`/api/v1/operator/media/${THREAD}`);
    expect(get.status).toBe(401);
    expect(get.headers['content-type']).toMatch(/application\/json/);
    expect(objects.size).toBe(0);
  });

  it('stores a PNG at <user>/<thread>/<uuid>.png and returns media_id, oasis_ref and a 1-hour signed URL on the public origin', async () => {
    const res = await upload(PNG, 'image/png');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, mime_type: 'image/png', size_bytes: PNG.length });
    const id = res.body.media_id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.oasis_ref).toBe(`OASIS-MEDIA-${id.slice(0, 8).toUpperCase()}`);
    const path = `${OWNER}/${THREAD}/${id}.png`;
    expect([...objects.keys()]).toEqual([path]);
    expect(objects.get(path)!.bytes.equals(PNG)).toBe(true);
    expect(rows).toEqual([expect.objectContaining({ id, user_id: OWNER, thread_id: THREAD, object_path: path, mime_type: 'image/png', size_bytes: PNG.length })]);
    expect(signCalls).toEqual([{ path, expiresIn: 3600 }]);
    expect(res.body.url).toBe(`https://project.supabase.co/storage/v1/object/sign/operator-media/${path}?token=t1`);
    expect(oasis).toHaveLength(1);
    expect(oasis[0]).toMatchObject({ type: 'operator.media.uploaded', vtid: 'VTID-05067', actor_id: OWNER, payload: { media_id: id, thread_id: THREAD, mime_type: 'image/png', size_bytes: PNG.length } });
    expect(JSON.stringify(oasis[0])).not.toContain(PNG.toString('base64'));
  });

  it('jpeg, gif and webp are stored with their own extension', async () => {
    for (const [buf, type, ext] of [[JPEG, 'image/jpeg', 'jpg'], [GIF, 'image/gif', 'gif'], [WEBP, 'image/webp', 'webp']] as const) {
      const res = await upload(buf, type);
      expect(res.status).toBe(201);
      expect([...objects.keys()].some((k) => k.endsWith(`${res.body.media_id}.${ext}`))).toBe(true);
    }
  });

  it('refuses by type and magic bytes, by size, and when empty — nothing stored', async () => {
    expect((await upload(SVG, 'image/svg+xml')).body).toEqual({ ok: false, error: 'unsupported_type', allowed: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] });
    const mismatch = await upload(GIF, 'image/png');
    expect(mismatch.status).toBe(415);
    expect(mismatch.body.error).toBe('type_mismatch');
    const text = await upload(Buffer.from('not really a jpeg at all'), 'image/jpeg');
    expect(text.status).toBe(415);
    expect(text.body.error).toBe('unsupported_type');
    const big = await upload(Buffer.concat([PNG, Buffer.alloc(OPERATOR_MEDIA_LIMITS.maxBytes)]), 'image/png');
    expect(big.status).toBe(413);
    expect(big.body.error).toBe('too_large');
    const json = await request(app()).post(`/api/v1/operator/media?thread_id=${THREAD}`).set('x-test-user', OWNER).send({ a: 1 });
    expect(json.status).toBe(415);
    const empty = await upload(Buffer.alloc(0), 'image/png');
    expect(empty.status).toBe(EMPTY_STATUS);
    expect(empty.headers['content-type']).toMatch(/application\/json/);
    expect(objects.size).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it('a bad thread id is 400; another admin\'s thread is 403', async () => {
    expect((await upload(PNG, 'image/png', OWNER, 'not-a-uuid')).status).toBe(400);
    ownership.owner = OTHER;
    const res = await upload(PNG, 'image/png');
    expect(res.status).toBe(403);
    expect(objects.size).toBe(0);
  });

  it('storage down → 503 JSON, no row', async () => {
    (global as any).fetch = jest.fn(async () => new Response('down', { status: 502 }));
    const res = await upload(PNG, 'image/png');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('storage_unavailable');
    expect(rows).toHaveLength(0);
  });
});

describe('GET /api/v1/operator/media/:id', () => {
  it('re-signs for the owner only; 404 unknown; 400 bad id', async () => {
    const id = (await upload(PNG, 'image/png')).body.media_id as string;
    signCalls.length = 0;
    const mine = await request(app()).get(`/api/v1/operator/media/${id}`).set('x-test-user', OWNER);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ ok: true, media_id: id, mime_type: 'image/png', thread_id: THREAD });
    expect(mine.body.url).toMatch(/^https:\/\/project\.supabase\.co\/storage\/v1\/object\/sign\/operator-media\//);
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(signCalls).toHaveLength(1);
    expect(signCalls[0].expiresIn).toBe(3600);
    const theirs = await request(app()).get(`/api/v1/operator/media/${id}`).set('x-test-user', OTHER);
    expect(theirs.status).toBe(403);
    expect(theirs.body).toEqual({ ok: false, error: 'forbidden' });
    expect((await request(app()).get('/api/v1/operator/media/b5067000-0000-4000-8000-0000000000ff').set('x-test-user', OWNER)).status).toBe(404);
    expect((await request(app()).get('/api/v1/operator/media/x').set('x-test-user', OWNER)).status).toBe(400);
  });
});

describe('the per-message checks used where a run or chat turn starts', () => {
  it('at most 4, all the caller\'s own, all existing; bytes read back as base64', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await upload(PNG, 'image/png')).body.media_id);
    expect(await loadOperatorMediaForUser(ids, OWNER)).toEqual({ ok: false, error: 'too_many' });
    const four = await loadOperatorMediaForUser(ids.slice(0, 4), OWNER);
    expect(four.ok && four.media.map((m) => m.id)).toEqual(ids.slice(0, 4));
    expect(await loadOperatorMediaForUser([ids[0]], OTHER)).toEqual({ ok: false, error: 'forbidden' });
    expect(await loadOperatorMediaForUser([ids[0]], null)).toEqual({ ok: false, error: 'forbidden' });
    expect(await loadOperatorMediaForUser(['b5067000-0000-4000-8000-0000000000ee'], OWNER)).toEqual({ ok: false, error: 'not_found' });
    expect(await loadOperatorMediaForUser([], OWNER)).toEqual({ ok: true, media: [] });
    const row = four.ok ? four.media[0] : null;
    expect(await readOperatorMediaBase64(row!)).toEqual({ mimeType: 'image/png', data: PNG.toString('base64') });
  });
});

describe('scripts/supabase/setup-operator-media-bucket.mjs (Storage API, idempotent)', () => {
  const SCRIPT = join(__dirname, '../../../scripts/supabase/setup-operator-media-bucket.mjs');
  /** Runs the script's exported function in a real node ESM process against a scripted fetch. */
  function run(getStatus: number, getBody: unknown, opts: { dryRun?: boolean; createStatus?: number } = {}) {
    const code = `
      import { setupOperatorMediaBucket, planBucketSetup, BUCKET_CONFIG } from ${JSON.stringify(SCRIPT)};
      const calls = [];
      const fetchImpl = async (url, init = {}) => {
        calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers && init.headers.Authorization });
        if ((init.method || 'GET') === 'GET') return new Response(JSON.stringify(${JSON.stringify(getBody)}), { status: ${getStatus} });
        return new Response('{}', { status: ${opts.createStatus ?? 200} });
      };
      const r = await setupOperatorMediaBucket({ url: 'https://p.supabase.co/', key: 'k', dryRun: ${!!opts.dryRun}, fetchImpl, log: () => {} });
      console.log(JSON.stringify({ r, calls, config: BUCKET_CONFIG, plan404: planBucketSetup(404, null) }));
    `;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
  }

  it('missing → POST /storage/v1/bucket with a private, 5 MB, image-only bucket', () => {
    const out = run(400, { statusCode: '404', error: 'Bucket not found' });
    expect(out.r).toMatchObject({ ok: true, code: 0, plan: { action: 'create' } });
    expect(out.calls.map((c: any) => `${c.method} ${c.url}`)).toEqual(['GET https://p.supabase.co/storage/v1/bucket/operator-media', 'POST https://p.supabase.co/storage/v1/bucket']);
    expect(out.calls[1].body).toEqual({ id: 'operator-media', name: 'operator-media', public: false, file_size_limit: 5242880, allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] });
    expect(out.calls[1].auth).toBe('Bearer k');
  });

  it('already private → nothing; public → refused (exit 2); dry run → no write', () => {
    expect(run(200, { id: 'operator-media', public: false }).calls).toHaveLength(1);
    const pub = run(200, { id: 'operator-media', public: true });
    expect(pub.r).toMatchObject({ ok: false, code: 2, plan: { action: 'refuse' } });
    expect(pub.calls).toHaveLength(1);
    const dry = run(404, { error: 'not found' }, { dryRun: true });
    expect(dry.r).toMatchObject({ ok: true, plan: { action: 'create' } });
    expect(dry.calls).toHaveLength(1);
  });

  it('the script never touches storage.buckets with SQL', () => {
    const src = (require('fs').readFileSync(SCRIPT, 'utf8') as string).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/insert\s+into\s+storage\.buckets/i);
    expect(src).not.toMatch(/storage\.buckets/);
    expect(src).toContain('/storage/v1/bucket');
  });
});
