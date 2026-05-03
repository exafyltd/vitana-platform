import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import router from '../src/routes/admin-notification-categories';

// Mock the requireAdmin middleware to test the auth boundaries
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    // Valid admin
    (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
    next();
  })
}));

// Mock Supabase to avoid real DB calls during testing
jest.mock('@supabase/supabase-js', () => {
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: '1', type: 'chat', slug: 'test' }, error: null }),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: jest.fn((resolve) => resolve({ data: [{ id: '1', type: 'chat' }], error: null })),
  };

  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQuery)
    }))
  };
});

// Mock notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 for unauthenticated request (GET)', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 for authenticated non-admin (GET)', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should return 200 for authenticated admin (GET)', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer valid-admin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 for authenticated admin (POST)', async () => {
    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer valid-admin')
      .send({ type: 'chat', display_name: 'Test Chat' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});