import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => next()),
}));

jest.mock('@supabase/supabase-js', () => {
  const mockQuery = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: '123' }, error: null }),
  };
  
  (mockQuery as any).then = function (resolve: any) {
    resolve({ data: [], error: null });
  };

  return {
    createClient: jest.fn(() => mockQuery),
  };
});

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
}));

describe('Admin Notification Categories API Auth Boundary', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/admin/notification-categories', router);
  });

  it('rejects unauthenticated requests with 401', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(403);
  });

  it('allows admin users to access the route', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});