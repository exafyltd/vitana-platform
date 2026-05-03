import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer admin') {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => {
      const builder: any = {
        select: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
      };
      builder.then = jest.fn().mockImplementation((resolve) => {
        return Promise.resolve(resolve({ data: [], error: null }));
      });
      return builder;
    })
  }))
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 FORBIDDEN when an authenticated non-admin attempts access', async () => {
    const response = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin');
    
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should proceed to handler and return 200 when an admin token is provided', async () => {
    const response = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin');
    
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toEqual({ chat: [], calendar: [], community: [] });
  });
});