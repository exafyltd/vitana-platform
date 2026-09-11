/**
 * Storage Bridge route (Aurora migration B6, VTID-03815 continuation) —
 * object-storage facade for vitana-v1 edge functions.
 *
 * Pins:
 *   1. Every operation is auth-gated exactly like ai-bridge (requireServiceOrAdmin)
 *      — no anonymous caller can read/write/enumerate storage on this
 *      codebase's behalf.
 *   2. Request validation rejects malformed bodies with 400s before ever
 *      touching storage-provider.ts.
 *   3. A storage-provider error surfaces as a 502 with a stable `error` code,
 *      not a thrown exception or a 200 with a lie inside it.
 *   4. Successful responses carry the shape the vitana-v1 client (drop-in
 *      replacement for the direct `.storage.*` calls) actually reads.
 */

import express from 'express';
import request from 'supertest';

const mockStorageUpload = jest.fn();
const mockStorageRemove = jest.fn();
const mockStoragePublicUrl = jest.fn();
const mockStorageList = jest.fn();
const mockStorageSignedUrl = jest.fn();

jest.mock('../src/services/storage/storage-provider', () => ({
  storageUpload: (...args: unknown[]) => mockStorageUpload(...args),
  storageRemove: (...args: unknown[]) => mockStorageRemove(...args),
  storagePublicUrl: (...args: unknown[]) => mockStoragePublicUrl(...args),
  storageList: (...args: unknown[]) => mockStorageList(...args),
  storageSignedUrl: (...args: unknown[]) => mockStorageSignedUrl(...args),
}));

// Deterministic JWT path — every test here exercises the service-token leg.
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (_req: any, res: any, next: () => void) => next(),
}));

import storageBridgeRouter from '../src/routes/storage-bridge';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/storage-bridge', storageBridgeRouter);
  return app;
}

describe('storage-bridge auth gating', () => {
  const ORIGINAL_TOKEN = process.env.GATEWAY_SERVICE_TOKEN;
  beforeEach(() => {
    process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';
    jest.clearAllMocks();
  });
  afterAll(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.GATEWAY_SERVICE_TOKEN;
    else process.env.GATEWAY_SERVICE_TOKEN = ORIGINAL_TOKEN;
  });

  it('rejects an unauthenticated /upload with 401, never calling storageUpload', async () => {
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/upload')
      .send({ bucket: 'covers', path: 'x.jpg', contentBase64: 'aGk=' });
    expect(res.status).toBe(401);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated /list with 401, never calling storageList', async () => {
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/list')
      .send({ bucket: 'avatars', prefix: 'u1' });
    expect(res.status).toBe(401);
    expect(mockStorageList).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/storage-bridge/upload', () => {
  beforeEach(() => {
    process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';
    jest.clearAllMocks();
  });

  const auth = () => ({ Authorization: 'Bearer test-service-token' });

  it('decodes base64, uploads, and returns ok:true', async () => {
    mockStorageUpload.mockResolvedValueOnce({ error: null });
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/upload')
      .set(auth())
      .send({ bucket: 'covers', path: 'x.jpg', contentBase64: Buffer.from('hello').toString('base64'), contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockStorageUpload).toHaveBeenCalledWith(
      'covers',
      'x.jpg',
      Buffer.from('hello'),
      expect.objectContaining({ contentType: 'image/jpeg' }),
    );
  });

  it('400s on missing contentBase64 without calling storageUpload', async () => {
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/upload')
      .set(auth())
      .send({ bucket: 'covers', path: 'x.jpg' });
    expect(res.status).toBe(400);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('400s on invalid base64 (bytes decodable but the string is not real base64) without calling storageUpload', async () => {
    // Node's Buffer.from(str, 'base64') never throws — it silently decodes
    // whatever valid characters it finds and drops the rest, so this must
    // be rejected by a charset check, not a try/catch around the decode.
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/upload')
      .set(auth())
      .send({ bucket: 'covers', path: 'x.jpg', contentBase64: '!!!not-base64!!!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('contentBase64 is not valid base64');
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('accepts base64 with internal whitespace/newlines (a common copy-paste artifact)', async () => {
    mockStorageUpload.mockResolvedValueOnce({ error: null });
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/upload')
      .set(auth())
      .send({ bucket: 'covers', path: 'x.jpg', contentBase64: 'aG\nVsbG8=' });
    expect(res.status).toBe(200);
  });

  it('502s with a stable error code when storageUpload fails', async () => {
    mockStorageUpload.mockResolvedValueOnce({ error: new Error('AccessDenied') });
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/upload')
      .set(auth())
      .send({ bucket: 'covers', path: 'x.jpg', contentBase64: 'aGk=' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'upload_failed', message: 'AccessDenied' });
  });
});

describe('POST /api/v1/storage-bridge/remove', () => {
  beforeEach(() => {
    process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';
    jest.clearAllMocks();
  });
  const auth = () => ({ Authorization: 'Bearer test-service-token' });

  it('removes and returns the count', async () => {
    mockStorageRemove.mockResolvedValueOnce({ error: null });
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/remove')
      .set(auth())
      .send({ bucket: 'avatars', paths: ['u1/a.png', 'u1/b.png'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 2 });
    expect(mockStorageRemove).toHaveBeenCalledWith('avatars', ['u1/a.png', 'u1/b.png']);
  });

  it('400s when paths is not an array of strings', async () => {
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/remove')
      .set(auth())
      .send({ bucket: 'avatars', paths: [123] });
    expect(res.status).toBe(400);
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/storage-bridge/public-url', () => {
  beforeEach(() => {
    process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';
    jest.clearAllMocks();
  });
  const auth = () => ({ Authorization: 'Bearer test-service-token' });

  it('returns the url from storagePublicUrl', async () => {
    mockStoragePublicUrl.mockReturnValueOnce('https://example/covers/x.jpg');
    const res = await request(buildApp())
      .get('/api/v1/storage-bridge/public-url')
      .set(auth())
      .query({ bucket: 'covers', path: 'x.jpg' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, url: 'https://example/covers/x.jpg' });
  });

  it('400s when path is missing', async () => {
    const res = await request(buildApp())
      .get('/api/v1/storage-bridge/public-url')
      .set(auth())
      .query({ bucket: 'covers' });
    expect(res.status).toBe(400);
  });

  it('502s when storagePublicUrl throws', async () => {
    mockStoragePublicUrl.mockImplementationOnce(() => { throw new Error('Supabase client unavailable'); });
    const res = await request(buildApp())
      .get('/api/v1/storage-bridge/public-url')
      .set(auth())
      .query({ bucket: 'covers', path: 'x.jpg' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('public_url_failed');
  });
});

describe('POST /api/v1/storage-bridge/list', () => {
  beforeEach(() => {
    process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';
    jest.clearAllMocks();
  });
  const auth = () => ({ Authorization: 'Bearer test-service-token' });

  it('returns files from storageList', async () => {
    mockStorageList.mockResolvedValueOnce({ data: [{ name: 'a.png' }], error: null });
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/list')
      .set(auth())
      .send({ bucket: 'avatars', prefix: 'u1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, files: [{ name: 'a.png' }] });
    expect(mockStorageList).toHaveBeenCalledWith('avatars', 'u1', { limit: undefined });
  });

  it('returns an empty files array (not a 502) when the prefix has nothing', async () => {
    mockStorageList.mockResolvedValueOnce({ data: [], error: null });
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/list')
      .set(auth())
      .send({ bucket: 'avatars', prefix: 'nobody' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, files: [] });
  });

  it('400s when prefix is missing', async () => {
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/list')
      .set(auth())
      .send({ bucket: 'avatars' });
    expect(res.status).toBe(400);
    expect(mockStorageList).not.toHaveBeenCalled();
  });

  it('502s with a stable error code when storageList fails', async () => {
    mockStorageList.mockResolvedValueOnce({ data: null, error: new Error('AccessDenied') });
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/list')
      .set(auth())
      .send({ bucket: 'avatars', prefix: 'u1' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'list_failed', message: 'AccessDenied' });
  });
});

describe('POST /api/v1/storage-bridge/signed-url', () => {
  beforeEach(() => {
    process.env.GATEWAY_SERVICE_TOKEN = 'test-service-token';
    jest.clearAllMocks();
  });
  const auth = () => ({ Authorization: 'Bearer test-service-token' });

  it('rejects an unauthenticated request with 401, never calling storageSignedUrl', async () => {
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/signed-url')
      .send({ bucket: 'voucher-pdfs', path: 'x.pdf' });
    expect(res.status).toBe(401);
    expect(mockStorageSignedUrl).not.toHaveBeenCalled();
  });

  it('returns the url and echoes the resolved expiresInSeconds', async () => {
    mockStorageSignedUrl.mockResolvedValueOnce({ url: 'https://signed.example/x.pdf', error: null });
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/signed-url')
      .set(auth())
      .send({ bucket: 'voucher-pdfs', path: 'x.pdf', expiresInSeconds: 60 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, url: 'https://signed.example/x.pdf', expiresInSeconds: 60 });
    expect(mockStorageSignedUrl).toHaveBeenCalledWith('voucher-pdfs', 'x.pdf', 60);
  });

  it('defaults expiresInSeconds to 3600 when omitted or invalid', async () => {
    mockStorageSignedUrl.mockResolvedValueOnce({ url: 'https://signed.example/x.pdf', error: null });
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/signed-url')
      .set(auth())
      .send({ bucket: 'voucher-pdfs', path: 'x.pdf', expiresInSeconds: -5 });
    expect(res.status).toBe(200);
    expect(mockStorageSignedUrl).toHaveBeenCalledWith('voucher-pdfs', 'x.pdf', 3600);
  });

  it('400s when path is missing, without calling storageSignedUrl', async () => {
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/signed-url')
      .set(auth())
      .send({ bucket: 'voucher-pdfs' });
    expect(res.status).toBe(400);
    expect(mockStorageSignedUrl).not.toHaveBeenCalled();
  });

  it('502s with a stable error code when storageSignedUrl fails', async () => {
    mockStorageSignedUrl.mockResolvedValueOnce({ url: null, error: new Error('AccessDenied') });
    const res = await request(buildApp())
      .post('/api/v1/storage-bridge/signed-url')
      .set(auth())
      .send({ bucket: 'voucher-pdfs', path: 'x.pdf' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'signed_url_failed', message: 'AccessDenied' });
  });
});
