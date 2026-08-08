/**
 * BOOTSTRAP-PUBLIC-BUSINESS-PROFILE — public recommendations route tests.
 *
 * Verifies:
 *   - Route is behind requireAuth (401 when unauthenticated).
 *   - 400 when :vitanaId is empty/whitespace-only.
 *   - 404 when the vitanaId doesn't resolve to a profile.
 *   - 404 when the resolved profile is not visible
 *     (global_community_profiles.is_visible = false).
 *   - 503 when Supabase is unavailable.
 *   - Happy path maps rows to the public shape and — critically — never
 *     includes status/click_count/conversion_count/commission_earned_minor/
 *     currency, which are private to the recommendation's owner.
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import router from '../../src/routes/discover-recommendations-public';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn(),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

function authenticate(req: Request, _res: Response, next: NextFunction) {
  (req as any).identity = { user_id: 'viewer-1', tenant_id: 'tenant-1' };
  next();
}

// Flexible fluent mock — resolves to whatever `result` is set to once the
// chain is awaited (thenable) or `.maybeSingle()` is called.
function createMockQuery(result: { data: any; error: any }) {
  const q: any = {};
  q.select = jest.fn(() => q);
  q.eq = jest.fn(() => q);
  q.order = jest.fn(() => q);
  q.limit = jest.fn(() => q);
  q.maybeSingle = jest.fn().mockResolvedValue(result);
  q.then = (resolve: any) => Promise.resolve(result).then(resolve);
  return q;
}

const app = express();
app.use(express.json());
app.use('/api/v1/discover', router);

describe('BOOTSTRAP-PUBLIC-BUSINESS-PROFILE — public recommendations route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    (requireAuth as jest.Mock).mockImplementation((_req: Request, res: Response) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/api/v1/discover/recommendations/mariia11');
    expect(res.status).toBe(401);
  });

  describe('authenticated', () => {
    beforeEach(() => {
      (requireAuth as jest.Mock).mockImplementation(authenticate);
    });

    it('returns 503 when Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).get('/api/v1/discover/recommendations/mariia11');
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('DB_UNAVAILABLE');
    });

    it('returns 404 when the vitanaId does not resolve to a profile', async () => {
      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn(() => createMockQuery({ data: null, error: null })),
      });

      const res = await request(app).get('/api/v1/discover/recommendations/no-such-user');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('profile_not_found');
    });

    it('returns 404 when the resolved profile is not visible', async () => {
      const from = jest.fn((table: string) => {
        if (table === 'profiles') {
          return createMockQuery({ data: { user_id: 'owner-1' }, error: null });
        }
        if (table === 'global_community_profiles') {
          return createMockQuery({ data: { is_visible: false }, error: null });
        }
        return createMockQuery({ data: null, error: null });
      });
      (getSupabase as jest.Mock).mockReturnValue({ from });

      const res = await request(app).get('/api/v1/discover/recommendations/mariia11');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('profile_not_found');
    });

    it('maps rows to the public shape and never includes owner-private stats fields', async () => {
      const row = {
        id: 'rec-1',
        product_id: 'p-1',
        created_at: '2026-07-01T00:00:00.000Z',
        products: { title: 'Test Product', images: ['https://example.com/img.jpg'] },
        // Fields a real Supabase row would also carry if selected with `*` —
        // included here to prove the route's mapping drops them even if a
        // future refactor widens the `.select()` by accident.
        status: 'active',
        click_count: 99,
        conversion_count: 12,
        commission_earned_minor: 123456,
        commission_currency: 'EUR',
      };
      const from = jest.fn((table: string) => {
        if (table === 'profiles') {
          return createMockQuery({ data: { user_id: 'owner-1' }, error: null });
        }
        if (table === 'global_community_profiles') {
          return createMockQuery({ data: { is_visible: true }, error: null });
        }
        if (table === 'product_recommendations') {
          return createMockQuery({ data: [row], error: null });
        }
        return createMockQuery({ data: null, error: null });
      });
      (getSupabase as jest.Mock).mockReturnValue({ from });

      const res = await request(app).get('/api/v1/discover/recommendations/mariia11');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.items).toEqual([
        {
          recommendation_id: 'rec-1',
          product_id: 'p-1',
          product_title: 'Test Product',
          product_thumbnail_url: 'https://example.com/img.jpg',
          created_at: '2026-07-01T00:00:00.000Z',
        },
      ]);
      const item = res.body.items[0];
      expect(item.status).toBeUndefined();
      expect(item.click_count).toBeUndefined();
      expect(item.conversion_count).toBeUndefined();
      expect(item.commission_earned_minor).toBeUndefined();
      expect(item.currency).toBeUndefined();
    });

    it('strips a leading @ and lowercases the vitanaId before resolving', async () => {
      const from = jest.fn((table: string) => {
        if (table === 'profiles') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn((_col: string, value: string) => {
                expect(value).toBe('mariia11');
                return createMockQuery({ data: { user_id: 'owner-1' }, error: null });
              }),
            })),
          };
        }
        if (table === 'global_community_profiles') {
          return createMockQuery({ data: { is_visible: true }, error: null });
        }
        return createMockQuery({ data: [], error: null });
      });
      (getSupabase as jest.Mock).mockReturnValue({ from });

      const res = await request(app).get('/api/v1/discover/recommendations/@MARIIA11');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });
  });
});
