import request from 'supertest';
import express from 'express';
import { requireAdmin } from '../src/middleware/auth';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

process.env.SUPABASE_URL = 'http://localhost:8000';
process.env.SUPABASE_SERVICE_ROLE = 'test-key';

jest.mock('../src/middleware/auth', () => ({
  requireAdmin: jest.fn()
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

jest.mock('@supabase/supabase-js', () => {
  const mockChain = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: '1', slug: 'cat', type: 'chat' }, error: null }),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: function (resolve: any) {
      resolve({ data: [{ id: '1', slug: 'cat', type: 'chat' }], error: null });
    }
  };
  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockChain)
    }))
  };
});

describe('Admin Notification Categories Auth', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/admin/categories', adminNotificationCategoriesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 for unauthenticated request', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin/categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 for authenticated non-admin', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin/categories');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 for authenticated admin on GET /', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const res = await request(app).get('/admin/categories');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.chat).toHaveLength(1);
  });
});