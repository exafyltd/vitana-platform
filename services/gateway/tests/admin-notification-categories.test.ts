import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import router from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

const mockQuery = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  single: jest.fn(),
  then: jest.fn((resolve) => resolve({ data: [], error: null }))
};

mockQuery.insert.mockReturnValue({
  select: jest.fn().mockReturnValue({
    single: jest.fn().mockResolvedValue({ data: { id: '1', slug: 'test' }, error: null })
  })
});

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockQuery)
  }))
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories API Auth Boundary', () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env = { ...originalEnv };
    process.env.SUPABASE_URL = 'http://localhost';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 for unauthenticated request', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req: Request, res: Response) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
  });

  it('returns 403 for authenticated non-admin', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req: Request, res: Response) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(403);
  });

  it('returns 200/201 for authenticated admin on GET and POST', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req: Request, res: Response, next: NextFunction) => {
      (req as any).user = { id: 'admin-id', email: 'admin@example.com' };
      next();
    });

    const getRes = await request(app).get('/admin/notification-categories');
    expect(getRes.status).toBe(200);

    const postRes = await request(app)
      .post('/admin/notification-categories')
      .send({ type: 'chat', display_name: 'Test Category' });
    expect(postRes.status).toBe(201);
  });
});