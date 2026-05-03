import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

const mockQuery: any = {};
const chainMethod = jest.fn(() => mockQuery);
mockQuery.select = chainMethod;
mockQuery.order = chainMethod;
mockQuery.eq = chainMethod;
mockQuery.is = chainMethod;
mockQuery.or = chainMethod;
mockQuery.single = chainMethod;
mockQuery.limit = chainMethod;
mockQuery.then = jest.fn((resolve) => resolve({ data: [], error: null }));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockQuery)
  }))
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn()
}));

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

import { requireAdmin } from '../src/middleware/requireAdmin';
import adminNotificationCategories from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategories);

describe('Admin Notification Categories - Auth Boundary', () => {
  const mockRequireAdmin = requireAdmin as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 for unauthenticated request', async () => {
    mockRequireAdmin.mockImplementation((req: Request, res: Response, next: NextFunction) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 for authenticated non-admin', async () => {
    mockRequireAdmin.mockImplementation((req: Request, res: Response, next: NextFunction) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 for authenticated admin', async () => {
    mockRequireAdmin.mockImplementation((req: Request, res: Response, next: NextFunction) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});