import express from 'express';
import request from 'supertest';
import adminCategoriesRouter from '../src/routes/admin-notification-categories';

// Mock dependencies
jest.mock('@supabase/supabase-js', () => {
  const mockQueryBuilder: any = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ 
      data: { id: 'test-cat-1', type: 'chat', mapped_types: [] }, 
      error: null 
    }),
    then: jest.fn((resolve) => resolve({ data: [], error: null }))
  };
  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQueryBuilder)
    }))
  };
});

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer user-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (auth === 'Bearer admin-token') {
      req.user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminCategoriesRouter);

describe('Admin Notification Categories API - Auth Boundary', () => {
  it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 FORBIDDEN when a non-admin token is provided', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 OK when an admin token is provided on GET', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 Created when an admin token is provided on POST', async () => {
    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({
        type: 'chat',
        display_name: 'Test Category'
      });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});