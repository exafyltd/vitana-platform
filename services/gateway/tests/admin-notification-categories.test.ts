import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

// Mock requireAdmin middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

// Mock Supabase
const mockQuery: any = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  single: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
};

// Make mockQuery a thenable object
mockQuery.then = jest.fn((resolve) => resolve({ data: [], error: null }));

const mockSupabase = {
  from: jest.fn().mockReturnValue(mockQuery)
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockSupabase,
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true }),
}));

describe('Admin Notification Categories API Auth', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/admin-notification-categories', router);
  });

  it('should return 401 for unauthenticated request', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 for authenticated non-admin', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 for authenticated admin on GET', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    mockQuery.then.mockImplementationOnce((resolve: any) => resolve({ data: [], error: null }));

    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 for authenticated admin on POST', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    mockQuery.then.mockImplementationOnce((resolve: any) => resolve({ data: { id: 'cat-123' }, error: null }));

    const res = await request(app)
      .post('/admin-notification-categories')
      .send({ type: 'chat', display_name: 'Chat Notifications' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});