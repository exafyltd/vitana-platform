import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

let mockSupabase: any;
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabase)
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      single: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      then: jest.fn((resolve) => resolve({ data: [], error: null }))
    };
  });

  it('should return 401 for unauthenticated request', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 for authenticated non-admin request', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 for authenticated admin request on GET /', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@exafy.com' };
      next();
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 for authenticated admin request on POST /', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@exafy.com' };
      next();
    });

    mockSupabase.then.mockImplementationOnce((resolve: any) => resolve({
      data: { id: 'cat-1', type: 'chat', display_name: 'Chat Cat' },
      error: null
    }));

    const res = await request(app)
      .post('/admin/notification-categories')
      .send({ type: 'chat', display_name: 'Chat Cat' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});