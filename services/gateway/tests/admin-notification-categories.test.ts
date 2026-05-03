import request from 'supertest';
import express from 'express';

// Mock the auth middleware before importing the router
jest.mock('../src/middleware/auth', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer user-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer admin-token') {
      req.user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// Mock Supabase to bypass DB calls
const mockChain = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  single: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  then: function (resolve: any) {
    resolve({ data: [], error: null });
  }
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockChain)
  }))
}));

// Mock notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

import adminCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminCategoriesRouter);

describe('Admin Notification Categories Auth Boundaries', () => {
  it('returns 401 UNAUTHENTICATED without Bearer token', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 403 FORBIDDEN with non-admin token', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('returns 200 OK with admin token on GET', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 201 CREATED with admin token on POST', async () => {
    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({ type: 'chat', display_name: 'Test Category' });
    
    // Test successfully verifies that authorization works before hitting DB
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});