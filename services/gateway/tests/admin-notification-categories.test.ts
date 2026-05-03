import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import router from '../src/routes/admin-notification-categories';

// Mock requireAdmin middleware to simulate the auth boundary rules
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    if (auth === 'Bearer non-admin-token') return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    if (auth === 'Bearer admin-token') {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

// Mock Supabase to avoid executing real DB queries
jest.mock('@supabase/supabase-js', () => {
  const mockQueryBuilder = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    then: jest.fn(function (resolve) {
      // Simulating a successful query that yields an empty data set
      resolve({ data: [], error: null });
    })
  };

  return {
    createClient: jest.fn(() => mockQueryBuilder)
  };
});

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 UNAUTHENTICATED without a Bearer token', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 FORBIDDEN with an authenticated non-admin token', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin-token');
    
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should proceed to route handler and return 200 with an admin token', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token');

    // Because we mocked Supabase to return { data: [], error: null }, 
    // the route correctly maps it into grouped sets
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(res.body.data).toEqual({ chat: [], calendar: [], community: [] });
  });
});