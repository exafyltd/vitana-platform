import express from 'express';
import request from 'supertest';

// Mock the requireAdmin middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer admin') {
      req.user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

// Mock Supabase to avoid real DB queries in unit tests
const mockSupabase = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  then: jest.fn((resolve) => resolve({ data: [], error: null })),
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabase)
}));

// Import router AFTER mocking
import router from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/notification-categories', router);

describe('Admin Notification Categories - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 for unauthenticated request', async () => {
    const response = await request(app).get('/notification-categories');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 for authenticated non-admin request', async () => {
    const response = await request(app)
      .get('/notification-categories')
      .set('Authorization', 'Bearer non-admin');
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 for authenticated admin request on GET', async () => {
    const response = await request(app)
      .get('/notification-categories')
      .set('Authorization', 'Bearer admin');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});