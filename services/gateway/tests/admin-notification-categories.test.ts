import request from 'supertest';
import express from 'express';
import { requireAdmin } from '../src/middleware/requireAdmin';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

jest.mock('@supabase/supabase-js', () => {
  const mSupabase = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  };
  return { createClient: jest.fn(() => mSupabase) };
});

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 for unauthenticated request', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const response = await request(app).get('/admin-notification-categories');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('returns 403 for authenticated non-admin request', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const response = await request(app).get('/admin-notification-categories');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('returns 200 for GET as authenticated admin', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient();
    supabase.order.mockResolvedValueOnce({ data: [], error: null });

    const response = await request(app).get('/admin-notification-categories');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, data: { chat: [], calendar: [], community: [] }, total: 0 });
  });

  it('returns 201 for POST as authenticated admin', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient();
    supabase.single.mockResolvedValueOnce({
      data: { id: 'cat-123', slug: 'test-category', type: 'chat' },
      error: null
    });

    const response = await request(app)
      .post('/admin-notification-categories')
      .send({ type: 'chat', display_name: 'Test Category' });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
  });
});