import request from 'supertest';
import express from 'express';

// Mock middleware first
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer valid-admin') {
      req.user = { id: 'admin-123', email: 'admin@exafy.com' };
      return next();
    }
    if (authHeader === 'Bearer valid-user') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

// Mock Supabase
jest.mock('@supabase/supabase-js', () => {
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: 'test-cat', slug: 'test-cat', type: 'chat' }, error: null }),
    then: jest.fn((resolve) => resolve({ data: [{ id: 'test-cat', slug: 'test-cat', type: 'chat' }], error: null }))
  };
  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQuery)
    }))
  };
});

// Mock notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

import adminNotificationCategories from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategories);

describe('Admin Notification Categories API - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 FORBIDDEN when an authenticated non-admin requests', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer valid-user');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should allow request and return 200 when an authenticated admin requests GET', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer valid-admin');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should allow request and return 201 when an authenticated admin requests POST', async () => {
    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer valid-admin')
      .send({ type: 'chat', display_name: 'Test Category' });
    
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});