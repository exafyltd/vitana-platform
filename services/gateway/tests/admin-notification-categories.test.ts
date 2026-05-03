import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

// 1. Mock requireAdmin middleware BEFORE importing the router
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (auth === 'Bearer admin') {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// 2. Mock Supabase so GET / succeeds without hitting DB
const mockQueryBuilder = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis()
};
(mockQueryBuilder as any).then = function (resolve: any) {
  resolve({ data: [], error: null });
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockQueryBuilder)
  }))
}));

// Import router after mocks are established
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories - Auth Boundary', () => {
  it('returns 401 UNAUTHENTICATED when no token is provided', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 403 FORBIDDEN when an authenticated non-admin attempts access', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('returns 200 OK when an authenticated admin accesses GET /', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});