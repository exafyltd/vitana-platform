import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';

// Mock Supabase to avoid real database queries in unit tests
const mockQuery = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  single: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  // Resolves the promise chain unconditionally
  then: jest.fn((resolve) => resolve({ data: [], error: null }))
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockQuery)
}));

// Mock the notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

// Mock requireAdmin middleware to test boundaries without actual tokens
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer nonadmin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (auth === 'Bearer admin') {
      req.user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories Auth Boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 for unauthenticated request', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 for authenticated non-admin request', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer nonadmin');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should return 200 for authenticated admin request (GET)', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 for authenticated admin request (POST)', async () => {
    // Override the mock response specifically for the INSERT call
    mockQuery.then.mockImplementationOnce((resolve) => resolve({
      data: { id: 'cat-123', type: 'chat', display_name: 'Test Cat' },
      error: null
    }));

    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin')
      .send({
        type: 'chat',
        display_name: 'Test Cat'
      });
    
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});