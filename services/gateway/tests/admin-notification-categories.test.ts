import request from 'supertest';
import express from 'express';

// 1. Mock requireAdmin before importing the router
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth.includes('nonadmin')) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    req.user = { id: 'admin-123', email: 'admin@example.com' };
    next();
  }
}));

// 2. Mock Supabase client
const mockChain = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  single: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  then: jest.fn((resolve) => resolve({ data: [], error: null }))
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockChain),
    auth: {
      getUser: jest.fn()
    }
  }))
}));

// 3. Mock notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

// 4. Import router and set up Express app
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 FORBIDDEN when authenticated as a non-admin user', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer nonadmin-token');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should return 200 OK when authenticated as an admin user (GET)', async () => {
    // Mock a successful GET resolution
    mockChain.then.mockImplementationOnce((resolve) => resolve({ data: [], error: null }));

    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 Created when authenticated as an admin user (POST)', async () => {
    // Mock a successful POST creation
    mockChain.then.mockImplementationOnce((resolve) => resolve({
      data: { id: 'new-cat', type: 'chat', slug: 'test-cat' },
      error: null
    }));

    const res = await request(app)
      .post('/admin-notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({ type: 'chat', display_name: 'Test Category' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});