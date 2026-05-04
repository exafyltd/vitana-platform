import request from 'supertest';
import express from 'express';

// Mock the requireAdmin middleware to test the authentication boundary
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    // Simulate successful authentication
    req.user = { id: 'admin-123', email: 'admin@example.com' };
    next();
  }
}));

// Mock Supabase client to avoid database connections during route testing
jest.mock('@supabase/supabase-js', () => {
  const mSupabase = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: 1, type: 'chat', slug: 'mock-category' }, error: null }),
    then: jest.fn((cb) => cb({ data: [], error: null }))
  };
  return {
    createClient: jest.fn(() => mSupabase)
  };
});

// Mock the notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

describe('Admin Notification Categories - Auth Boundary', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/admin-notification-categories', adminNotificationCategoriesRouter);
  });

  it('should return 401 for unauthenticated request', async () => {
    const res = await request(app).get('/admin-notification-categories');
    
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 for authenticated non-admin', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer non-admin');
      
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 for authenticated admin on GET', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer admin');
      
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 for authenticated admin on POST', async () => {
    const res = await request(app)
      .post('/admin-notification-categories')
      .set('Authorization', 'Bearer admin')
      .send({
        type: 'chat',
        display_name: 'Test Chat Category'
      });
      
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});