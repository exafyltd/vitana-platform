/**
 * VTID-02950 — "Recommend & Earn" route tests.
 *
 * Verifies:
 *   - Both routes are behind requireAuth (401 when unauthenticated).
 *   - POST /recommendations validates the body (400 on invalid product_id).
 *   - POST /recommendations 404s when the product doesn't exist / isn't active.
 *   - POST /recommendations creates a new recommendation + sharing link on
 *     first call, emits an OASIS event, and returns a share_url.
 *   - POST /recommendations reuses an existing (user, product) recommendation
 *     on a repeat call — no duplicate insert, no duplicate OASIS emit.
 *   - GET /my-recommendations maps rows to the expected shape.
 *   - GET /my-recommendations 503s when Supabase is unavailable.
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import router from '../../src/routes/discover-recommendations';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn(),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

function authenticate(req: Request, _res: Response, next: NextFunction) {
  (req as any).identity = { user_id: 'user-1', tenant_id: 'tenant-1' };
  next();
}

// Flexible fluent mock — resolves to whatever `result` is set to at the
// point `.maybeSingle()` / `.single()` / the thenable is invoked.
function createMockQuery(result: { data: any; error: any }) {
  const q: any = {};
  q.select = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.eq = jest.fn(() => q);
  q.order = jest.fn(() => q);
  q.maybeSingle = jest.fn().mockResolvedValue(result);
  q.single = jest.fn().mockResolvedValue(result);
  q.then = (resolve: any) => Promise.resolve(result).then(resolve);
  return q;
}

const app = express();
app.use(express.json());
app.use('/api/v1/discover', router);

describe('VTID-02950 — Discover recommendations routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST /recommendations returns 401 when unauthenticated', async () => {
    (requireAuth as jest.Mock).mockImplementation((_req: Request, res: Response) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).post('/api/v1/discover/recommendations').send({ product_id: 'p-1' });
    expect(res.status).toBe(401);
  });

  it('GET /my-recommendations returns 401 when unauthenticated', async () => {
    (requireAuth as jest.Mock).mockImplementation((_req: Request, res: Response) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/api/v1/discover/my-recommendations');
    expect(res.status).toBe(401);
  });

  describe('authenticated', () => {
    beforeEach(() => {
      (requireAuth as jest.Mock).mockImplementation(authenticate);
    });

    it('POST /recommendations returns 400 for an invalid body', async () => {
      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn(() => createMockQuery({ data: null, error: null })),
      });
      const res = await request(app).post('/api/v1/discover/recommendations').send({ product_id: 'not-a-uuid' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('INVALID_BODY');
    });

    it('POST /recommendations returns 404 when the product does not exist', async () => {
      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn(() => createMockQuery({ data: null, error: null })),
      });

      const res = await request(app)
        .post('/api/v1/discover/recommendations')
        .send({ product_id: '11111111-1111-1111-1111-111111111111' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
    });

    it('POST /recommendations creates a new recommendation, emits an OASIS event, and returns a share_url', async () => {
      const productId = '11111111-1111-1111-1111-111111111111';
      const from = jest.fn((table: string) => {
        if (table === 'products') {
          return createMockQuery({ data: { id: productId, merchant_id: 'm-1', title: 'Test Product', is_active: true }, error: null });
        }
        if (table === 'product_recommendations') {
          // First call: find-existing -> none. Second call: insert -> created row.
          const q = createMockQuery({ data: null, error: null });
          let call = 0;
          const original = q.maybeSingle;
          q.maybeSingle = jest.fn(() => {
            call += 1;
            return call === 1 ? Promise.resolve({ data: null, error: null }) : original();
          });
          q.single = jest.fn().mockResolvedValue({ data: { id: 'rec-1' }, error: null });
          return q;
        }
        if (table === 'sharing_links') {
          return createMockQuery({ data: { id: 'link-1' }, error: null });
        }
        return createMockQuery({ data: null, error: null });
      });
      (getSupabase as jest.Mock).mockReturnValue({ from });

      const res = await request(app).post('/api/v1/discover/recommendations').send({ product_id: productId });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.recommendation_id).toBe('rec-1');
      expect(res.body.share_url).toContain(productId);
      expect(res.body.share_url).toContain('rec=rec-1');
      expect(emitOasisEvent).toHaveBeenCalledTimes(1);
      expect((emitOasisEvent as jest.Mock).mock.calls[0][0]).toMatchObject({
        vtid: 'VTID-02950',
        payload: expect.objectContaining({ product_id: productId, recommendation_id: 'rec-1' }),
      });
    });

    it('POST /recommendations reuses an existing recommendation without re-inserting or re-emitting', async () => {
      const productId = '11111111-1111-1111-1111-111111111111';
      const from = jest.fn((table: string) => {
        if (table === 'products') {
          return createMockQuery({ data: { id: productId, merchant_id: 'm-1', title: 'Test Product', is_active: true }, error: null });
        }
        if (table === 'product_recommendations') {
          return createMockQuery({ data: { id: 'rec-existing', sharing_link_id: 'link-existing' }, error: null });
        }
        return createMockQuery({ data: null, error: null });
      });
      (getSupabase as jest.Mock).mockReturnValue({ from });

      const res = await request(app).post('/api/v1/discover/recommendations').send({ product_id: productId });

      expect(res.status).toBe(200);
      expect(res.body.recommendation_id).toBe('rec-existing');
      expect(emitOasisEvent).not.toHaveBeenCalled();
    });

    it('GET /my-recommendations returns 503 when Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).get('/api/v1/discover/my-recommendations');
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('DB_UNAVAILABLE');
    });

    it('GET /my-recommendations maps rows to the expected shape', async () => {
      const row = {
        id: 'rec-1',
        product_id: 'p-1',
        status: 'active',
        click_count: 3,
        conversion_count: 1,
        commission_earned_minor: 500,
        commission_currency: 'EUR',
        created_at: '2026-07-01T00:00:00.000Z',
        products: { title: 'Test Product', images: ['https://example.com/img.jpg'] },
      };
      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn(() => createMockQuery({ data: [row], error: null })),
      });

      const res = await request(app).get('/api/v1/discover/my-recommendations');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.items).toEqual([
        {
          id: 'rec-1',
          product_id: 'p-1',
          product_title: 'Test Product',
          product_thumbnail_url: 'https://example.com/img.jpg',
          status: 'active',
          click_count: 3,
          conversion_count: 1,
          commission_earned_minor: 500,
          currency: 'EUR',
          created_at: '2026-07-01T00:00:00.000Z',
        },
      ]);
    });
  });
});
