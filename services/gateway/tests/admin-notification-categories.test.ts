import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';

// Mock requireAdmin middleware virtually in case of slightly different actual paths
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const authHeader = req.headers?.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    req.user = { id: 'admin-123', email: 'admin@example.com' };
    next();
  }
}), { virtual: true });

// Mock Supabase to return simple stubs
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: null }),
    then: jest.fn((cb) => cb({ data: [], error: null }))
  })
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories Auth', () => {
  it('should return 401 if unauthenticated', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
  });

  it('should return 403 if authenticated but not an admin', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin');
    
    expect(res.status).toBe(403);
  });

  it('should reach handler if properly authenticated as admin', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});