import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';

// Mock requireAdmin to test auth boundaries
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer invalid') {
      return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
    }
    if (authHeader === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer admin') {
      req.user = { id: 'user-123', email: 'admin@exafy.test' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }
}));

jest.mock('@supabase/supabase-js', () => {
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    then: jest.fn((resolve) => resolve({ data: [], error: null }))
  };
  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQuery)
    }))
  };
});

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories API Auth Boundaries', () => {
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

  it('returns 200 for authenticated admin on GET', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 201 for authenticated admin on POST', async () => {
    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin')
      .send({ type: 'chat', display_name: 'Chat Notifications' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});