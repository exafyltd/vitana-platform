/**
 * VTID-05023 (Aurora cutover, R1(b)) — SUPABASE_PUBLIC_URL helper.
 *
 * At the cutover the gateway's SUPABASE_URL points at the VPC-only
 * PostgREST-Aurora proxy. Every URL the gateway hands outward must be
 * rewritten onto the public Supabase origin; everything else is untouched.
 */

import {
  getSupabasePublicUrl,
  getSupabasePublicOrigin,
  toPublicSupabaseUrl,
} from '../../src/lib/supabase-public-url';

const INTERNAL = 'http://postgrest-aurora-prod.internal:8080';
const PUBLIC = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
const cutover = { SUPABASE_URL: INTERNAL, SUPABASE_PUBLIC_URL: PUBLIC } as NodeJS.ProcessEnv;

describe('VTID-05023 getSupabasePublicUrl', () => {
  it('defaults to SUPABASE_URL when SUPABASE_PUBLIC_URL is unset (zero behaviour change today)', () => {
    expect(getSupabasePublicUrl({ SUPABASE_URL: PUBLIC } as NodeJS.ProcessEnv)).toBe(PUBLIC);
  });

  it('treats a blank SUPABASE_PUBLIC_URL as unset', () => {
    expect(getSupabasePublicUrl({ SUPABASE_URL: PUBLIC, SUPABASE_PUBLIC_URL: '  ' } as NodeJS.ProcessEnv)).toBe(PUBLIC);
  });

  it('prefers SUPABASE_PUBLIC_URL and strips a trailing slash', () => {
    expect(getSupabasePublicUrl({ SUPABASE_URL: INTERNAL, SUPABASE_PUBLIC_URL: `${PUBLIC}/` } as NodeJS.ProcessEnv)).toBe(PUBLIC);
  });

  it('returns undefined when neither is set', () => {
    expect(getSupabasePublicUrl({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('getSupabasePublicOrigin returns the origin only, or null when unparseable', () => {
    expect(getSupabasePublicOrigin({ ...cutover, SUPABASE_PUBLIC_URL: `${PUBLIC}/some/path` })).toBe(PUBLIC);
    expect(getSupabasePublicOrigin({ SUPABASE_URL: 'not a url' } as NodeJS.ProcessEnv)).toBeNull();
    expect(getSupabasePublicOrigin({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('reads process.env at call time by default', () => {
    const saved = { url: process.env.SUPABASE_URL, pub: process.env.SUPABASE_PUBLIC_URL };
    try {
      process.env.SUPABASE_URL = INTERNAL;
      process.env.SUPABASE_PUBLIC_URL = PUBLIC;
      expect(getSupabasePublicUrl()).toBe(PUBLIC);
      expect(toPublicSupabaseUrl(`${INTERNAL}/storage/v1/object/public/media/x.jpg`)).toBe(
        `${PUBLIC}/storage/v1/object/public/media/x.jpg`,
      );
    } finally {
      if (saved.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = saved.url;
      if (saved.pub === undefined) delete process.env.SUPABASE_PUBLIC_URL;
      else process.env.SUPABASE_PUBLIC_URL = saved.pub;
    }
  });
});

describe('VTID-05023 toPublicSupabaseUrl', () => {
  it('rewrites an internal-origin URL onto the public origin, keeping path, query and fragment byte for byte', () => {
    const signed = `${INTERNAL}/storage/v1/object/sign/media/u%201/v.mp4?token=eyJ.a-b_c%2B&download=v.mp4#t=1`;
    expect(toPublicSupabaseUrl(signed, cutover)).toBe(
      `${PUBLIC}/storage/v1/object/sign/media/u%201/v.mp4?token=eyJ.a-b_c%2B&download=v.mp4#t=1`,
    );
  });

  it('rewrites a bare origin and an origin followed directly by a query', () => {
    expect(toPublicSupabaseUrl(INTERNAL, cutover)).toBe(PUBLIC);
    expect(toPublicSupabaseUrl(`${INTERNAL}?x=1`, cutover)).toBe(`${PUBLIC}?x=1`);
  });

  it('leaves URLs on any other origin untouched (S3, CDN, the public host itself)', () => {
    const s3 = 'https://vitana-storage-media.s3.eu-central-1.amazonaws.com/a.jpg';
    expect(toPublicSupabaseUrl(s3, cutover)).toBe(s3);
    expect(toPublicSupabaseUrl(`${PUBLIC}/storage/v1/object/public/media/a.jpg`, cutover)).toBe(
      `${PUBLIC}/storage/v1/object/public/media/a.jpg`,
    );
    // same host, different port is a different origin
    expect(toPublicSupabaseUrl('http://postgrest-aurora-prod.internal:9090/x', cutover)).toBe(
      'http://postgrest-aurora-prod.internal:9090/x',
    );
  });

  it('leaves relative paths, garbage and empty values untouched', () => {
    expect(toPublicSupabaseUrl('/storage/v1/object/public/media/a.jpg', cutover)).toBe('/storage/v1/object/public/media/a.jpg');
    expect(toPublicSupabaseUrl('not a url', cutover)).toBe('not a url');
    expect(toPublicSupabaseUrl('', cutover)).toBe('');
  });

  it('is a no-op while SUPABASE_PUBLIC_URL is unset or equal to SUPABASE_URL', () => {
    const u = `${PUBLIC}/storage/v1/object/public/media/a.jpg`;
    expect(toPublicSupabaseUrl(u, { SUPABASE_URL: PUBLIC } as NodeJS.ProcessEnv)).toBe(u);
    expect(toPublicSupabaseUrl(u, { SUPABASE_URL: PUBLIC, SUPABASE_PUBLIC_URL: PUBLIC } as NodeJS.ProcessEnv)).toBe(u);
    const internalOnly = `${INTERNAL}/storage/v1/object/public/media/a.jpg`;
    expect(toPublicSupabaseUrl(internalOnly, { SUPABASE_URL: INTERNAL } as NodeJS.ProcessEnv)).toBe(internalOnly);
  });

  it('is a no-op when SUPABASE_URL is unset or unparseable', () => {
    const u = `${INTERNAL}/x`;
    expect(toPublicSupabaseUrl(u, { SUPABASE_PUBLIC_URL: PUBLIC } as NodeJS.ProcessEnv)).toBe(u);
    expect(toPublicSupabaseUrl(u, { SUPABASE_URL: '::', SUPABASE_PUBLIC_URL: PUBLIC } as NodeJS.ProcessEnv)).toBe(u);
  });
});
