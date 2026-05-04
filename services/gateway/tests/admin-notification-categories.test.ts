import request from 'supertest';
import express from 'express';
import adminNotificationCategories from '../src/routes/admin-notification-categories';

// Mock requireAdmin middleware to simulate auth boundary
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
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

// Mock Supabase
jest.mock('@supabase/supabase-js', () => {
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: 'test-cat', type: 'chat', slug: 'test-cat' }, error: null }),
    then: jest.fn((resolve) => resolve({ data: [], error: null }))
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

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategories);

describe('Admin Notification Categories - Auth Boundary', () => {
  beforeAll(() => {
    process.env.SUPABASE_URL = 'http://localhost:8000';
    process.env.SUPABASE_SERVICE_ROLE = 'service-role-key';
  });

  afterAll(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 FORBIDDEN when a non-admin token is provided', async () => {
    const response = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin-token');
    
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should return 200 OK when an admin token is provided on GET', async () => {
    const response = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token');
    
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('should return 201 Created when an admin token is provided on POST', async () => {
    const response = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({
        type: 'chat',
        display_name: 'Test Cat'
      });
    
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
  });
});