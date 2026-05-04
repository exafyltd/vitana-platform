import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

jest.mock('@supabase/supabase-js', () => {
  const mQueryBuilder: any = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: 'test-cat', type: 'chat', slug: 'test-cat' }, error: null }),
    then: jest.fn((resolve) => resolve({ data: [{ id: 'test-cat', type: 'chat', slug: 'test-cat' }], error: null }))
  };
  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mQueryBuilder)
    }))
  };
});

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', router);

describe('Admin Notification Categories API Auth Boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated but non-admin', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(403);
  });

  it('returns 200 on GET and 201 on POST for authenticated admin', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin123', email: 'admin@example.com' };
      next();
    });

    const getRes = await request(app).get('/admin-notification-categories');
    expect(getRes.status).toBe(200);
    expect(getRes.body.ok).toBe(true);

    const postRes = await request(app)
      .post('/admin-notification-categories')
      .send({ type: 'chat', display_name: 'Test Chat' });
    expect(postRes.status).toBe(201);
    expect(postRes.body.ok).toBe(true);
  });
});