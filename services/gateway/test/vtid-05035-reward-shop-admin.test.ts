/**
 * VTID-05035 — Rewards shop admin: gateway routes for the admin screen.
 *  - POST /admin/rewards/items/image: exafy_admin only; JPEG/PNG/WebP by magic
 *    bytes, declared type must match; 1.4 MB cap (413 IMAGE_TOO_LARGE);
 *    stored through the storage abstraction in bucket reward-shop-images
 *    under items/<uuid>.<ext>; a storage error is a 500.
 *  - GET /admin/rewards/shipping-fees: every fee row.
 *  - DELETE /admin/rewards/shipping-fees/:country/:currency: validated, removes one row.
 */
import express from 'express';
import request from 'supertest';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'service-role';

jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const identify = (req: any) => {
    const h = String(req.headers.authorization || '');
    if (h === 'Bearer admin') return { user_id: 'admin-1', exafy_admin: true, tenant_id: 't1', email: null };
    if (h === 'Bearer member') return { user_id: '11111111-1111-1111-1111-111111111111', exafy_admin: false, tenant_id: 't1', email: 'm@example.com' };
    return null;
  };
  return {
    requireAuth: (req: any, res: any, next: any) => {
      const id = identify(req);
      if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      req.identity = id;
      return next();
    },
    requireExafyAdmin: (req: any, res: any, next: any) =>
      req.identity?.exafy_admin ? next() : res.status(403).json({ ok: false, error: 'FORBIDDEN' }),
  };
});
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));
jest.mock('../src/services/storage/storage-provider', () => ({
  storageUpload: jest.fn(),
  storagePublicUrl: jest.fn(),
}));
jest.mock('../src/services/rewards/reward-shop-repository', () => ({
  fetchActiveItems: jest.fn(),
  fetchAllItems: jest.fn(),
  fetchShippingFees: jest.fn(),
  fetchAllShippingFees: jest.fn(),
  deleteShippingFee: jest.fn(),
  fetchEarnedBalance: jest.fn(),
  fetchMemberOrders: jest.fn(),
  fetchOrder: jest.fn(),
  fetchOrdersForAdmin: jest.fn(),
  attachStripeSession: jest.fn(),
  upsertItem: jest.fn(),
  upsertShippingFee: jest.fn(),
  rpcRedeem: jest.fn(),
  rpcSettleShipping: jest.fn(),
  rpcReleaseReservation: jest.fn(),
  rpcReleaseExpired: jest.fn(),
  rpcSetStatus: jest.fn(),
}));

import * as repo from '../src/services/rewards/reward-shop-repository';
import * as storage from '../src/services/storage/storage-provider';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const shopRouter = require('../src/routes/rewards-shop').default;
const app = express();
app.use(express.json({ limit: '2mb' })); // same limit as services/gateway/src/index.ts
app.use('/api/v1', shopRouter);

const r = repo as unknown as Record<string, jest.Mock>;
const s = storage as unknown as Record<string, jest.Mock>;

const MAX = 1_468_006;
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_MAGIC = [...Buffer.from('RIFF'), 0x24, 0x00, 0x00, 0x00, ...Buffer.from('WEBPVP8 ')];

function image(magic: number[], size = 256): string {
  const buf = Buffer.alloc(size, 0x11);
  Buffer.from(magic).copy(buf, 0);
  return buf.toString('base64');
}

const IMAGE_URL = '/api/v1/admin/rewards/items/image';
const FEES_URL = '/api/v1/admin/rewards/shipping-fees';
const PATH_RE = /^items\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

beforeEach(() => {
  jest.clearAllMocks();
  s.storageUpload.mockResolvedValue({ error: null });
  s.storagePublicUrl.mockImplementation((bucket: string, path: string) =>
    `https://example.supabase.co/storage/v1/object/public/${bucket}/${path}`);
  r.fetchAllShippingFees.mockResolvedValue({
    data: [
      { country: 'AT', currency: 'EUR', fee_cents: 990, updated_at: '2026-10-10T00:00:00Z' },
      { country: 'DE', currency: 'EUR', fee_cents: 690, updated_at: '2026-10-10T00:00:00Z' },
    ],
    error: null,
  });
  r.deleteShippingFee.mockResolvedValue({ error: null });
});

describe('auth gate on every new route', () => {
  const calls: Array<[string, (t: request.SuperTest<request.Test>) => request.Test]> = [
    ['POST image', (t) => t.post(IMAGE_URL).send({ content_type: 'image/png', data_base64: image(PNG_MAGIC) })],
    ['GET fees', (t) => t.get(FEES_URL)],
    ['DELETE fee', (t) => t.delete(`${FEES_URL}/DE/EUR`)],
  ];

  it.each(calls)('%s: 401 without auth, 403 for a non-exafy member', async (_name, call) => {
    const anon = await call(request(app) as any);
    expect(anon.status).toBe(401);
    expect(anon.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    const member = await call(request(app) as any).set('Authorization', 'Bearer member');
    expect(member.status).toBe(403);
    expect(member.body).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(s.storageUpload).not.toHaveBeenCalled();
    expect(r.fetchAllShippingFees).not.toHaveBeenCalled();
    expect(r.deleteShippingFee).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/admin/rewards/items/image', () => {
  it.each([
    ['image/jpeg', JPEG_MAGIC, 'jpg'],
    ['image/png', PNG_MAGIC, 'png'],
    ['image/webp', WEBP_MAGIC, 'webp'],
  ])('accepts %s and stores it in reward-shop-images under items/<uuid>.%s', async (type, magic, ext) => {
    const res = await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin')
      .send({ content_type: type, data_base64: image(magic as number[]) });
    expect(res.status).toBe(200);
    expect(s.storageUpload).toHaveBeenCalledTimes(1);
    const [bucket, path, bytes, opts] = s.storageUpload.mock.calls[0];
    expect(bucket).toBe('reward-shop-images');
    expect(path).toMatch(PATH_RE);
    expect(path.endsWith(`.${ext}`)).toBe(true);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBe(256);
    expect(opts).toMatchObject({ contentType: type, upsert: false });
    expect(typeof opts.cacheControl).toBe('string');
    expect(s.storagePublicUrl).toHaveBeenCalledWith('reward-shop-images', path);
    expect(res.body).toEqual({
      ok: true,
      path,
      url: `https://example.supabase.co/storage/v1/object/public/reward-shop-images/${path}`,
    });
  });

  it('two uploads never share a path', async () => {
    for (let i = 0; i < 2; i++) {
      await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin')
        .send({ content_type: 'image/png', data_base64: image(PNG_MAGIC) });
    }
    expect(s.storageUpload.mock.calls[0][1]).not.toBe(s.storageUpload.mock.calls[1][1]);
  });

  it('accepts exactly 1.4 MB', async () => {
    const res = await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin')
      .send({ content_type: 'image/jpeg', data_base64: image(JPEG_MAGIC, MAX) });
    expect(res.status).toBe(200);
    expect(s.storageUpload.mock.calls[0][2].length).toBe(MAX);
  });

  it('rejects a photo over 1.4 MB with 413 IMAGE_TOO_LARGE', async () => {
    const res = await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin')
      .send({ content_type: 'image/jpeg', data_base64: image(JPEG_MAGIC, MAX + 1) });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ ok: false, error: 'IMAGE_TOO_LARGE' });
    expect(s.storageUpload).not.toHaveBeenCalled();
  });

  it('rejects a declared type that does not match the magic bytes', async () => {
    const res = await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin')
      .send({ content_type: 'image/jpeg', data_base64: image(PNG_MAGIC) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'IMAGE_TYPE_NOT_ALLOWED' });
    expect(s.storageUpload).not.toHaveBeenCalled();
  });

  it('rejects a type outside jpeg/png/webp even with matching bytes', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]).toString('base64');
    const res = await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin')
      .send({ content_type: 'image/gif', data_base64: gif });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'IMAGE_TYPE_NOT_ALLOWED' });
    expect(s.storageUpload).not.toHaveBeenCalled();
  });

  it('rejects garbage: non-image bytes and non-base64 text', async () => {
    const notImage = Buffer.from('<?php echo "hello"; ?>').toString('base64');
    const a = await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin')
      .send({ content_type: 'image/png', data_base64: notImage });
    expect(a.status).toBe(400);
    expect(a.body).toEqual({ ok: false, error: 'IMAGE_TYPE_NOT_ALLOWED' });
    const b = await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin')
      .send({ content_type: 'image/png', data_base64: '!!not*base64%%' });
    expect(b.status).toBe(400);
    expect(b.body).toEqual({ ok: false, error: 'IMAGE_TYPE_NOT_ALLOWED' });
    expect(s.storageUpload).not.toHaveBeenCalled();
  });

  it('rejects missing data with 400 ARGS_REQUIRED', async () => {
    for (const body of [{}, { content_type: 'image/png' }, { data_base64: image(PNG_MAGIC) }, { content_type: 'image/png', data_base64: '' }]) {
      const res = await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin').send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'ARGS_REQUIRED' });
    }
    expect(s.storageUpload).not.toHaveBeenCalled();
  });

  it('a storage error is a 500 IMAGE_UPLOAD_FAILED', async () => {
    s.storageUpload.mockResolvedValue({ error: new Error('bucket not found') });
    const res = await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin')
      .send({ content_type: 'image/webp', data_base64: image(WEBP_MAGIC) });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'IMAGE_UPLOAD_FAILED' });
  });

  it('a thrown storage error is a 500 IMAGE_UPLOAD_FAILED too', async () => {
    s.storageUpload.mockRejectedValue(new Error('network'));
    const res = await request(app).post(IMAGE_URL).set('Authorization', 'Bearer admin')
      .send({ content_type: 'image/png', data_base64: image(PNG_MAGIC) });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'IMAGE_UPLOAD_FAILED' });
  });
});

describe('GET /api/v1/admin/rewards/shipping-fees', () => {
  it('returns every fee row', async () => {
    const res = await request(app).get(FEES_URL).set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fees).toEqual([
      { country: 'AT', currency: 'EUR', fee_cents: 990, updated_at: '2026-10-10T00:00:00Z' },
      { country: 'DE', currency: 'EUR', fee_cents: 690, updated_at: '2026-10-10T00:00:00Z' },
    ]);
    expect(r.fetchAllShippingFees).toHaveBeenCalledTimes(1);
  });

  it('a read error is a 500', async () => {
    r.fetchAllShippingFees.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await request(app).get(FEES_URL).set('Authorization', 'Bearer admin');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'FEES_READ_FAILED' });
  });
});

describe('DELETE /api/v1/admin/rewards/shipping-fees/:country/:currency', () => {
  it.each([
    ['de', 'EUR'],
    ['DEU', 'EUR'],
    ['D1', 'EUR'],
    ['DE', 'eur'],
    ['DE', 'GBP'],
  ])('rejects %s/%s with 400 ARGS_REQUIRED', async (country, currency) => {
    const res = await request(app).delete(`${FEES_URL}/${country}/${currency}`).set('Authorization', 'Bearer admin');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'ARGS_REQUIRED' });
    expect(r.deleteShippingFee).not.toHaveBeenCalled();
  });

  it.each([['DE', 'EUR'], ['US', 'USD']])('deletes %s/%s', async (country, currency) => {
    const res = await request(app).delete(`${FEES_URL}/${country}/${currency}`).set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(r.deleteShippingFee).toHaveBeenCalledWith(expect.anything(), country, currency);
  });

  it('a database error is reported, not swallowed', async () => {
    r.deleteShippingFee.mockResolvedValue({ error: { message: 'denied' } });
    const res = await request(app).delete(`${FEES_URL}/DE/EUR`).set('Authorization', 'Bearer admin');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'FEE_REJECTED' });
  });
});
