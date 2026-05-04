import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

// Mock the middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

// Mock Supabase
const mockSupabaseQuery = {
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
    from: jest.fn(() => mockSupabaseQuery)
  }))
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories Auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 for unauthenticated request', async () => {
    // Setup mock to simulate unauthenticated
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('returns 403 for authenticated non-admin', async () => {
    // Setup mock to simulate non-admin
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('returns 200 for authenticated admin on GET /', async () => {
    // Setup mock to simulate admin
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@exafy.com' };
      next();
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});