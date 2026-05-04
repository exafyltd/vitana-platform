import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

// Mock the requireAdmin middleware to simulate standard auth responses
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer non-admin-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (auth === 'Bearer admin-token') {
      req.user = { id: 'admin-user-id', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

// Mock Supabase to ensure isolated routing tests
jest.mock('@supabase/supabase-js', () => {
  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ 
      data: { id: 'cat-123', slug: 'test-category', type: 'chat' }, 
      error: null 
    }),
    then: jest.fn((resolve) => resolve({ data: [], error: null }))
  };
  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQueryBuilder)
    }))
  };
});

// Set up express wrapper
const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories - Auth Boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Unauthenticated requests', () => {
    it('GET / returns 401 when missing Authorization header', async () => {
      const res = await request(app).get('/admin/notification-categories');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('POST / returns 401 when missing Authorization header', async () => {
      const res = await request(app).post('/admin/notification-categories').send({
        type: 'chat',
        display_name: 'Chat Notifications'
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });
  });

  describe('Authenticated non-admin requests', () => {
    it('GET / returns 403 when authenticated as regular user', async () => {
      const res = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer non-admin-token');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });
  });

  describe('Authenticated admin requests', () => {
    it('GET / returns 200 and data when authenticated as admin', async () => {
      const res = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('POST / returns 201 when authenticated as admin', async () => {
      const res = await request(app)
        .post('/admin/notification-categories')
        .set('Authorization', 'Bearer admin-token')
        .send({
          type: 'chat',
          display_name: 'Test Category'
        });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    });
  });
});