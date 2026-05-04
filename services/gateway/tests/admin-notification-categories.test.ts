import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

// Mock requireAdmin to simulate auth boundary
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer non-admin-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer admin-token') {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

// Mock Supabase Client
const mockChain = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: { id: 'cat-1', type: 'chat', display_name: 'Chat Test', slug: 'chat_test' }, error: null }),
};
// Make mockChain awaitable so that standard DB queries resolve properly in mocked tests
(mockChain as any).then = function(resolve: any) {
  return Promise.resolve({ data: [], error: null }).then(resolve);
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockChain)
  }))
}));

// Mock Notification Service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 FORBIDDEN when a non-admin token is provided', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 OK for GET when an admin token is provided', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 CREATED for POST when an admin token is provided', async () => {
    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({ type: 'chat', display_name: 'Test Chat' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});