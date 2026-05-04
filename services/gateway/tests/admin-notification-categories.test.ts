import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

// Mock requireAdmin middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer non-admin-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer admin-token') {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

const mockQuery = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  single: jest.fn(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  then: jest.fn(function (resolve) {
    resolve({ data: [], error: null });
  })
};

// Mock Supabase client
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockQuery)
  }))
}));

// Mock notifyUser
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API - Auth Boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 UNAUTHENTICATED when no Bearer token is provided', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 403 FORBIDDEN when authenticated user is not an admin', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('returns 200 OK on GET when authenticated as admin', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token');
      
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ chat: [], calendar: [], community: [] });
    expect(res.body.total).toBe(0);
  });

  it('returns 201 Created on POST when authenticated as admin', async () => {
    const mockCat = {
      id: 'cat-123',
      type: 'chat',
      slug: 'test_chat',
      display_name: 'Test Chat',
      created_by: 'admin-123'
    };

    mockQuery.single.mockResolvedValueOnce({ data: mockCat, error: null });

    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({
        type: 'chat',
        display_name: 'Test Chat'
      });
      
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual(mockCat);
  });
});