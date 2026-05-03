process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE = 'test-key';

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

// Mock the requireAdmin middleware BEFORE importing the router
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer non-admin-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (auth === 'Bearer admin-token') {
      (req as any).user = { id: 'admin-id', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// Mock Supabase
const mockQuery = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: { id: 'test-cat', slug: 'test-cat', type: 'chat' }, error: null }),
  then: jest.fn((resolve) => resolve({ data: [{ id: 'test-cat', slug: 'test-cat', type: 'chat' }], error: null }))
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockQuery)
  }))
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 UNAUTHENTICATED when no token is provided', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('returns 403 FORBIDDEN when authenticated as a non-admin user', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin-token');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('returns 200 OK when authenticated as an admin user (GET)', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it('returns 201 Created when authenticated as an admin user (POST)', async () => {
    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({
        type: 'chat',
        display_name: 'Test Chat'
      });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});