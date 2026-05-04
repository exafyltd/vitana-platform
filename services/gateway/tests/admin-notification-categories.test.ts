import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';

// Mock the requireAdmin middleware to test the auth boundary
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const token = req.headers.authorization;
    if (!token) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (token === 'Bearer user-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (token === 'Bearer admin-token') {
      req.user = { id: 'admin-123', email: 'admin@exafy.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// Mock Supabase to prevent actual DB calls during route testing
jest.mock('@supabase/supabase-js', () => {
  const mockQuery: any = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ 
      data: { id: '1', type: 'chat', slug: 'test-cat' }, 
      error: null 
    })
  };
  
  // Support for `await query` syntax used in `GET /`
  mockQuery.then = function(resolve: any) {
    resolve({ data: [{ id: '1', type: 'chat', slug: 'test-cat' }], error: null });
  };

  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQuery)
    }))
  };
});

// Mock the notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', router);

describe('Admin Notification Categories API - Auth Boundary', () => {
  it('should return 401 UNAUTHENTICATED when missing an Authorization header', async () => {
    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 FORBIDDEN when authenticated with a non-admin token', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 OK when authenticated with an admin token on GET', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 Created when authenticated with an admin token on POST', async () => {
    const res = await request(app)
      .post('/admin-notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({
        type: 'chat',
        display_name: 'Test Category'
      });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});