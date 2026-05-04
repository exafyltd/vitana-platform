import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer valid-user') {
      req.identity = { user_id: 'user-1', email: 'user@example.com', exafy_admin: false };
      return next();
    }
    if (authHeader === 'Bearer valid-admin') {
      req.identity = { user_id: 'admin-1', email: 'admin@example.com', exafy_admin: true };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  },
  requireExafyAdmin: (req: any, res: any, next: any) => {
    if (!req.identity?.exafy_admin) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    return next();
  }
}));

jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => ({
    from: () => ({
      select: function () { return this; },
      order: function () { return this; },
      eq: function () { return this; },
      or: function () { return this; },
      is: function () { return this; },
      insert: function () { return this; },
      update: function () { return this; },
      limit: function () { return this; },
      single: function () { return Promise.resolve({ data: { id: 'test-cat', type: 'chat', slug: 'test' }, error: null }); },
      then: function (resolve: any, reject: any) {
        return Promise.resolve({ data: [{ id: 'test-cat', type: 'chat', slug: 'test' }], error: null }).then(resolve, reject);
      }
    })
  })
}));

const app = express();
app.use(express.json());
app.use('/api/v1/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API — Auth boundaries', () => {
  it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
    const response = await request(app).get('/api/v1/admin/notification-categories');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 FORBIDDEN when user is an authenticated non-admin', async () => {
    const response = await request(app)
      .get('/api/v1/admin/notification-categories')
      .set('Authorization', 'Bearer valid-user');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should return 200 OK when user is a valid authenticated admin', async () => {
    const response = await request(app)
      .get('/api/v1/admin/notification-categories')
      .set('Authorization', 'Bearer valid-admin');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});