import request from 'supertest';
import express from 'express';

// Mock requireAdmin middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (auth === 'Bearer admin') {
      req.user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// Mock Supabase to prevent real network calls
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({
      data: { id: 'test-id', type: 'chat', slug: 'test-category' },
      error: null
    }),
    limit: jest.fn().mockReturnThis()
  })
}));

// Mock the notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

import router from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories API', () => {
  describe('Auth Boundary', () => {
    it('returns 401 for unauthenticated request', async () => {
      const res = await request(app).get('/admin/notification-categories');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 403 for authenticated non-admin', async () => {
      const res = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer non-admin');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('returns 200 for authenticated admin on GET requests', async () => {
      const getRes = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer admin');
      
      expect(getRes.status).toBe(200);
      expect(getRes.body.ok).toBe(true);
    });

    it('returns 201 for authenticated admin on POST requests', async () => {
      const postRes = await request(app)
        .post('/admin/notification-categories')
        .set('Authorization', 'Bearer admin')
        .send({
          type: 'chat',
          display_name: 'Test Category'
        });
        
      expect(postRes.status).toBe(201);
      expect(postRes.body.ok).toBe(true);
    });
  });
});