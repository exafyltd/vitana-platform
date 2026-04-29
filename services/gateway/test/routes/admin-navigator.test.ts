/**
 * Unit tests for admin-navigator routes
 */
import request from 'supertest';
import express from 'express';
import { getSupabase } from '../../src/lib/supabase';
import adminNavigatorRouter from '../../src/routes/admin-navigator';
import * as authMiddleware from '../../src/middleware/auth-supabase-jwt';

jest.mock('../../src/lib/supabase');
jest.mock('../../src/middleware/auth-supabase-jwt');

const app = express();
app.use(express.json());
app.use('/admin/navigator', adminNavigatorRouter);

describe('Admin Navigator Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock requireAdminAuth to skip actual auth
    (authMiddleware.requireAdminAuth as jest.Mock).mockImplementation((req: any, res: any, next: any) => {
      req.identity = { user_id: 'admin-1', email: 'admin@test.com', exafy_admin: true };
      next();
    });
  });

  describe('GET /catalog', () => {
    it('returns catalog entries with i18n', async () => {
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        order: jest.fn(),
        in: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn(),
        insert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        upsert: jest.fn(),
        range: jest.fn(),
        limit: jest.fn(),
        single: jest.fn(),
        count: jest.fn(),
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      // Mock the catalog query
      mockSupabase.order.mockResolvedValueOnce({
        data: [
          { id: '1', screen_id: 'home', tenant_id: null, route: '/home', category: 'public', access: 'public', anonymous_safe: false, priority: 5, related_kb_topics: [], context_rules: {}, override_triggers: [], is_active: true, created_at: '2024-01-01', updated_at: '2024-01-01', updated_by: 'admin' }
        ],
        error: null
      });

      // Mock the i18n query
      mockSupabase.in.mockReturnThis();
      mockSupabase.select.mockReturnThis();
      mockSupabase.order.mockResolvedValueOnce({
        data: [
          { catalog_id: '1', lang: 'en', title: 'Home', description: 'Home page', when_to_visit: 'Always', updated_at: '2024-01-01' }
        ],
        error: null
      });

      const res = await request(app).get('/admin/navigator/catalog').query({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].i18n).toHaveLength(1);
    });

    it('filters by tenant_id', async () => {
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        order: jest.fn(),
        in: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn(),
        insert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        upsert: jest.fn(),
        range: jest.fn(),
        limit: jest.fn(),
        single: jest.fn(),
        count: jest.fn(),
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
      mockSupabase.order.mockResolvedValueOnce({ data: [], error: null });
      mockSupabase.in.mockReturnThis();
      mockSupabase.select.mockReturnThis();
      mockSupabase.order.mockResolvedValueOnce({ data: [], error: null });

      const res = await request(app).get('/admin/navigator/catalog').query({ tenant_id: 'tenant-1' });
      expect(res.status).toBe(200);
      // eq should be called with 'tenant_id', 'tenant-1'
      expect(mockSupabase.eq).toHaveBeenCalledWith('tenant_id', 'tenant-1');
    });

    it('handles no supabase', async () => {
      (getSupabase as jest.Mock).mockReturnValueOnce(null);
      const res = await request(app).get('/admin/navigator/catalog');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('SUPABASE_UNAVAILABLE');
    });
  });
});