import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

const mockQuery: any = {
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  single: jest.fn().mockReturnThis()
};
mockQuery.then = jest.fn((resolve) => resolve({ data: [], error: null }));

const mockSupabase = {
  from: jest.fn(() => ({
    select: jest.fn(() => mockQuery),
    insert: jest.fn(() => ({ select: jest.fn(() => mockQuery) })),
    update: jest.fn(() => ({ select: jest.fn(() => mockQuery) })),
  }))
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabase)
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = 'http://localhost';
    process.env.SUPABASE_SERVICE_ROLE = 'anon';
  });

  it('rejects unauthenticated request (401)', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('rejects authenticated non-admin (403)', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('allows authenticated admin (200 on GET)', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});