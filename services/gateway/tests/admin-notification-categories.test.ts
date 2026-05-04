import request from 'supertest';
import express from 'express';

// Mock requireAdmin middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    const authHeader = req.headers?.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer valid-user') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer valid-admin') {
      req.user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

// Mock Supabase
const mockChain = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  single: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  then: jest.fn((resolve: any) => resolve({ data: [], error: null }))
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockChain)
}));

import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 UNAUTHENTICATED without a Bearer token', async () => {
    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 FORBIDDEN with a non-admin token', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer valid-user');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 OK with an admin token on GET', async () => {
    mockChain.then.mockImplementationOnce((resolve: any) => resolve({ data: [], error: null }));
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer valid-admin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 Created with an admin token on POST', async () => {
    mockChain.then.mockImplementationOnce((resolve: any) => resolve({ data: { slug: 'test' }, error: null }));
    const res = await request(app)
      .post('/admin-notification-categories')
      .set('Authorization', 'Bearer valid-admin')
      .send({ type: 'chat', display_name: 'Test Category' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});