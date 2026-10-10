/**
 * VTID-05023 (Aurora cutover, owner decision R1(b)) — outward-facing URLs keep
 * the public Supabase origin after SUPABASE_URL moves to the internal proxy.
 *
 * Cutover shape under test:
 *   SUPABASE_URL        = http://postgrest-aurora-prod.internal:8080  (VPC-only)
 *   SUPABASE_PUBLIC_URL = https://inmkhvwdcuyhnxkgfvsb.supabase.co
 *
 * supabase-js builds storage public/signed URLs from the client's base URL,
 * i.e. the INTERNAL proxy. Every one of them must come out on the public
 * origin and never contain the internal host: they are stored in rows,
 * rendered by members' browsers, and handed to third parties.
 */

import express from 'express';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';

const INTERNAL = 'http://postgrest-aurora-prod.internal:8080';
const INTERNAL_HOST = 'postgrest-aurora-prod.internal';
const PUBLIC = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';

const mockGetSupabase = jest.fn();
jest.mock('../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

// ffprobe / ffmpeg are faked: ffprobe prints a video stream, ffmpeg writes a
// non-empty JPEG to its last argument (the local thumbnail path).
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: jest.fn((cmd: string, args: string[]) => {
      const { EventEmitter: EE } = jest.requireActual('events');
      const child: any = new EE();
      child.stdout = new EE();
      child.stderr = new EE();
      child.kill = jest.fn();
      setImmediate(() => {
        if (cmd === 'ffprobe') {
          child.stdout.emit('data', Buffer.from(JSON.stringify({
            streams: [{ width: 720, height: 1280, duration: '12.4' }],
            format: { duration: '12.4' },
          })));
        } else if (cmd === 'ffmpeg') {
          jest.requireActual('fs').writeFileSync(args[args.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        }
        child.emit('close', 0);
      });
      return child;
    }),
  };
});

import { storagePublicUrl, storageSignedUrl } from '../src/services/storage/storage-provider';
import { extractThumbnail } from '../src/services/video-thumbnail-service';
import authRouter from '../src/routes/auth';

/**
 * A real supabase-js client on the INTERNAL base (getPublicUrl is computed
 * locally, no network), with download/upload/createSignedUrl stubbed so the
 * test never touches the network. createSignedUrl returns a URL on the
 * internal origin, exactly as supabase-js would against the proxy.
 */
function internalClient() {
  const client = createClient(INTERNAL, 'test-service-role-key', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const realFrom = client.storage.from.bind(client.storage);
  (client.storage as any).from = (bucket: string) => {
    const api: any = realFrom(bucket);
    api.createSignedUrl = jest.fn(async (path: string, expiresIn: number) => ({
      data: { signedUrl: `${INTERNAL}/storage/v1/object/sign/${bucket}/${path}?token=signed.jwt.value&e=${expiresIn}` },
      error: null,
    }));
    api.download = jest.fn(async () => ({ data: new Blob([Buffer.from('fake-video-bytes')]), error: null }));
    api.upload = jest.fn(async () => ({ data: { path: 'x' }, error: null }));
    return api;
  };
  return client;
}

describe('VTID-05023 R1(b): outward-facing Supabase URLs at the cutover', () => {
  const saved = {
    url: process.env.SUPABASE_URL,
    pub: process.env.SUPABASE_PUBLIC_URL,
    provider: process.env.STORAGE_PROVIDER,
    anon: process.env.SUPABASE_ANON_KEY,
  };

  beforeEach(() => {
    process.env.SUPABASE_URL = INTERNAL;
    process.env.SUPABASE_PUBLIC_URL = PUBLIC;
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    delete process.env.STORAGE_PROVIDER; // supabase backend
    mockGetSupabase.mockReturnValue(internalClient());
  });

  afterAll(() => {
    for (const [k, v] of [
      ['SUPABASE_URL', saved.url],
      ['SUPABASE_PUBLIC_URL', saved.pub],
      ['STORAGE_PROVIDER', saved.provider],
      ['SUPABASE_ANON_KEY', saved.anon],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('sanity: the unwrapped supabase-js public URL really is on the internal origin', () => {
    const raw = internalClient().storage.from('media').getPublicUrl('a.jpg').data.publicUrl;
    expect(raw.startsWith(INTERNAL)).toBe(true);
  });

  it('storagePublicUrl comes out on the public supabase.co origin', () => {
    const url = storagePublicUrl('media', 'user 1/avatar.jpg');
    expect(url).toBe(`${PUBLIC}/storage/v1/object/public/media/user%201/avatar.jpg`);
    expect(url).not.toContain(INTERNAL_HOST);
  });

  it('storageSignedUrl comes out on the public origin with the token intact', async () => {
    const { url, error } = await storageSignedUrl('vouchers', 'v/123.pdf', 600);
    expect(error).toBeNull();
    expect(url).toBe(`${PUBLIC}/storage/v1/object/sign/vouchers/v/123.pdf?token=signed.jwt.value&e=600`);
    expect(url).not.toContain(INTERNAL_HOST);
  });

  it('the video thumbnail URL written to media_videos is on the public origin', async () => {
    const result = await extractThumbnail({} as any, 'u1/clip.mp4');
    expect(result.thumbnail_url).toBe(`${PUBLIC}/storage/v1/object/public/media/u1/clip.jpg`);
    expect(result.thumbnail_url).not.toContain(INTERNAL_HOST);
    expect(result.width).toBe(720);
    expect(result.duration_sec).toBe(12);
  });

  it('GET /auth/config hands the browser the public Supabase URL, never the internal proxy', async () => {
    const app = express();
    app.use('/auth', authRouter);
    const res = await request(app).get('/auth/config');
    expect(res.status).toBe(200);
    expect(res.body.supabase_url).toBe(PUBLIC);
    expect(JSON.stringify(res.body)).not.toContain(INTERNAL_HOST);
  });

  it('without SUPABASE_PUBLIC_URL (today), URLs are byte-identical to supabase-js output', async () => {
    process.env.SUPABASE_URL = PUBLIC;
    delete process.env.SUPABASE_PUBLIC_URL;
    const client = createClient(PUBLIC, 'k', { auth: { persistSession: false, autoRefreshToken: false } });
    mockGetSupabase.mockReturnValue(client);
    expect(storagePublicUrl('media', 'a.jpg')).toBe(client.storage.from('media').getPublicUrl('a.jpg').data.publicUrl);

    const app = express();
    app.use('/auth', authRouter);
    const res = await request(app).get('/auth/config');
    expect(res.body.supabase_url).toBe(PUBLIC);
  });
});
