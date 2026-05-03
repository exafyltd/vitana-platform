import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';

jest.mock('@supabase/supabase-js', () => {
  const chainable = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: '1', slug: 'test', type: 'chat', mapped_types: [] }, error: null }),
    then: jest.fn((resolve) => resolve({ data: [{ id: '1', type: 'chat', slug: 'test', mapped_types: [] }], error: null }))
  };
  return { createClient: jest.fn(() => chainable) };
});

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    const token = req.headers.authorization;
    if (!token) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (token === 'Bearer user-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (token === 'Bearer admin-token') {
      req.user = { id: 'admin-123', email: 'admin@test.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories API', () => {
  describe('Auth Boundaries', () => {
    it('returns 401 for unauthenticated request', async () => {
      const res = await request(app).get('/admin/notification-categories');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 403 for authenticated non-admin request', async () => {
      const res = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer user-token');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('returns 200 for authenticated admin request on GET /', async () => {
      const res = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 201 for authenticated admin request on POST /', async () => {
      const res = await request(app)
        .post('/admin/notification-categories')
        .set('Authorization', 'Bearer admin-token')
        .send({ type: 'chat', display_name: 'Test Chat Category' });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    });
  });
});