import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

// Mock middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

// Mock Supabase
jest.mock('@supabase/supabase-js', () => {
  const mQuery: any = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
  };
  mQuery.then = function (resolve: any) {
    resolve({ data: [], error: null });
  };
  
  const mSupabase = {
    from: jest.fn(() => mQuery)
  };

  return {
    createClient: jest.fn(() => mSupabase),
  };
});

// Mock notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories - Auth Boundary', () => {
  const mockRequireAdmin = requireAdmin as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 UNAUTHENTICATED when no token is provided', async () => {
    mockRequireAdmin.mockImplementation((req, res) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('returns 403 FORBIDDEN when user is authenticated but not an admin', async () => {
    mockRequireAdmin.mockImplementation((req, res) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('returns 200 OK when user is an authenticated admin', async () => {
    mockRequireAdmin.mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});