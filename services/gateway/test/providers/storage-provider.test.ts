/**
 * VTID-03765 — object storage provider selection (Aurora/AWS migration, B6).
 *
 * Same shape as the TTS_PROVIDER/IMAGE_PROVIDER gating tests (titan-image.test.ts,
 * polly-provider.test.ts): the interesting bug here isn't "does an upload work",
 * it's "does the wrong provider get silently selected" — an unrecognised
 * STORAGE_PROVIDER value or a stale env var flipping traffic between two
 * completely different backends is the failure mode this test suite exists
 * to catch, mirroring the "never allow silent model fallback" discipline
 * this codebase applies to every other provider seam.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

jest.mock('@aws-sdk/client-s3', () => {
  const send = jest.fn();
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send })),
    GetObjectCommand: jest.fn((input) => ({ __type: 'GetObjectCommand', input })),
    PutObjectCommand: jest.fn((input) => ({ __type: 'PutObjectCommand', input })),
    DeleteObjectsCommand: jest.fn((input) => ({ __type: 'DeleteObjectsCommand', input })),
  };
});

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

import { s3BucketName, s3PublicUrl, s3Download, s3Upload, s3Remove } from '../../src/providers/s3-storage';
import {
  getStorageProvider,
  storageDownload,
  storageUpload,
  storageRemove,
  storagePublicUrl,
} from '../../src/services/storage/storage-provider';
import { getSupabase } from '../../src/lib/supabase';

function mockSend(): jest.Mock {
  return (new S3Client({}) as any).send;
}

describe('VTID-03765 STORAGE_PROVIDER gating', () => {
  const original = process.env.STORAGE_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = original;
  });

  it('defaults to supabase — deploying this code flips nothing', () => {
    delete process.env.STORAGE_PROVIDER;
    expect(getStorageProvider()).toBe('supabase');
  });

  it('selects s3 only on the exact opt-in value, case-insensitively', () => {
    process.env.STORAGE_PROVIDER = 'S3';
    expect(getStorageProvider()).toBe('s3');
  });

  it('falls back to supabase on an unrecognised value rather than failing closed', () => {
    process.env.STORAGE_PROVIDER = 'gcs';
    expect(getStorageProvider()).toBe('supabase');
  });

  it('falls back to supabase on an empty string, not a crash', () => {
    process.env.STORAGE_PROVIDER = '';
    expect(getStorageProvider()).toBe('supabase');
  });
});

describe('VTID-03765 s3BucketName / s3PublicUrl', () => {
  it('maps a Supabase bucket name to the vitana-storage-<name> convention', () => {
    expect(s3BucketName('avatars')).toBe('vitana-storage-avatars');
    expect(s3BucketName('media-uploads')).toBe('vitana-storage-media-uploads');
  });

  it('builds a plain, unsigned public URL — same shape as Supabase getPublicUrl()', () => {
    const url = s3PublicUrl('covers', 'user123/cover.jpg');
    expect(url).toBe('https://vitana-storage-covers.s3.eu-central-1.amazonaws.com/user123/cover.jpg');
  });

  it('respects AWS_S3_STORAGE_REGION over the AWS_REGION/default fallback', () => {
    // s3-storage.ts reads REGION once at module load, so re-require after
    // setting the env var to observe the override rather than asserting
    // against the already-loaded eu-central-1 default.
    jest.resetModules();
    process.env.AWS_S3_STORAGE_REGION = 'us-east-1';
    const { s3PublicUrl: s3PublicUrlFresh } = require('../../src/providers/s3-storage');
    expect(s3PublicUrlFresh('avatars', 'x.png')).toContain('.s3.us-east-1.amazonaws.com/');
    delete process.env.AWS_S3_STORAGE_REGION;
    jest.resetModules();
  });
});

describe('VTID-03765 s3Download/s3Upload/s3Remove — error shape, not thrown exceptions', () => {
  afterEach(() => jest.clearAllMocks());

  it('s3Download returns {data, error} on success, never throws', async () => {
    mockSend().mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    const { data, error } = await s3Download('avatars', 'a.png');
    expect(error).toBeNull();
    expect(data).toEqual(Buffer.from([1, 2, 3]));
  });

  it('s3Download returns an error object instead of throwing on SDK failure', async () => {
    mockSend().mockRejectedValueOnce(new Error('NoSuchKey'));
    const { data, error } = await s3Download('avatars', 'missing.png');
    expect(data).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('NoSuchKey');
  });

  it('s3Upload passes contentType and cacheControl through to PutObjectCommand', async () => {
    mockSend().mockResolvedValueOnce({});
    await s3Upload('covers', 'x.jpg', Buffer.from('data'), { contentType: 'image/jpeg', cacheControl: '3600' });
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'vitana-storage-covers',
        Key: 'x.jpg',
        ContentType: 'image/jpeg',
        CacheControl: '3600',
      }),
    );
  });

  it('s3Remove no-ops on an empty path list without calling the SDK', async () => {
    const send = mockSend();
    const { error } = await s3Remove('avatars', []);
    expect(error).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('s3Remove surfaces a rejected delete as an error, not a throw', async () => {
    mockSend().mockRejectedValueOnce(new Error('AccessDenied'));
    const { error } = await s3Remove('avatars', ['a.png']);
    expect(error?.message).toBe('AccessDenied');
  });
});

describe('VTID-03765 storage-provider.ts routing — supabase vs s3 selected correctly', () => {
  const original = process.env.STORAGE_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = original;
    jest.clearAllMocks();
  });

  it('storageUpload routes to S3 when STORAGE_PROVIDER=s3, never touching Supabase', async () => {
    process.env.STORAGE_PROVIDER = 's3';
    mockSend().mockResolvedValueOnce({});
    const { error } = await storageUpload('avatars', 'a.png', Buffer.from('x'));
    expect(error).toBeNull();
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('storageUpload routes to Supabase by default, never touching S3', async () => {
    delete process.env.STORAGE_PROVIDER;
    const send = mockSend();
    const upload = jest.fn().mockResolvedValue({ error: null });
    (getSupabase as jest.Mock).mockReturnValue({ storage: { from: () => ({ upload }) } });

    const { error } = await storageUpload('avatars', 'a.png', Buffer.from('x'));
    expect(error).toBeNull();
    expect(upload).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('storageDownload/storagePublicUrl/storageRemove all fail closed with a clear error when Supabase is unconfigured', async () => {
    delete process.env.STORAGE_PROVIDER;
    (getSupabase as jest.Mock).mockReturnValue(null);

    const dl = await storageDownload('avatars', 'a.png');
    expect(dl.error?.message).toMatch(/Supabase client unavailable/);

    const rm = await storageRemove('avatars', ['a.png']);
    expect(rm.error?.message).toMatch(/Supabase client unavailable/);

    expect(() => storagePublicUrl('avatars', 'a.png')).toThrow(/Supabase client unavailable/);
  });
});
