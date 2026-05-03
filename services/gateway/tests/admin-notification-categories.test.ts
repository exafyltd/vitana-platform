import request from 'supertest';
import express from 'express';

// Mock dependencies before importing the router
jest.mock('@supabase/supabase-js', () => {
  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
  };
  // Make it thenable to act like a Supabase query promise
  (mockQueryBuilder as any).then = function(resolve: any) {
    resolve({ data: [], error: null });
  };
  
  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQueryBuilder)
    }))
  };
});

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer user-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (auth === 'Bearer admin-token') {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories Auth Boundary', () => {
  beforeAll(() => {
    // Suppress console.error and console.log for clean test output
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('should return 401 UNAUTHENTICATED without a token', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 FORBIDDEN for authenticated non-admin', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should allow GET request (return 200) for authenticated admin', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should allow POST request (return 201) for authenticated admin', async () => {
    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({ type: 'chat', display_name: 'Test Category' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});