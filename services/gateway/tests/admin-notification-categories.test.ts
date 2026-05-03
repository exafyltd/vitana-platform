import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => next())
}));

jest.mock('@supabase/supabase-js', () => {
  const mSupabase = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis()
  };
  return {
    createClient: jest.fn(() => mSupabase)
  };
});

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API Auth Boundary', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 for unauthenticated request', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 403 for authenticated non-admin', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin-categories');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('returns 200 on GET for authenticated admin', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin1', email: 'admin@test.com' };
      next();
    });

    const { createClient } = require('@supabase/supabase-js');
    createClient().is.mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app).get('/admin-categories');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 201 on POST for authenticated admin', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin1', email: 'admin@test.com' };
      next();
    });

    const { createClient } = require('@supabase/supabase-js');
    createClient().single.mockResolvedValueOnce({
      data: { id: '1', type: 'chat', display_name: 'Chat' },
      error: null
    });

    const res = await request(app)
      .post('/admin-categories')
      .send({ type: 'chat', display_name: 'Chat' });
      
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});