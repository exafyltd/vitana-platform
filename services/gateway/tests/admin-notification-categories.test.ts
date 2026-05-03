import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

// Mock the requireAdmin middleware before importing the router
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer admin') {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }),
}));

// Mock Supabase
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => {
      const mockQuery: any = Promise.resolve({ data: [], error: null });
      mockQuery.select = jest.fn().mockReturnValue(mockQuery);
      mockQuery.order = jest.fn().mockReturnValue(mockQuery);
      mockQuery.is = jest.fn().mockReturnValue(mockQuery);
      mockQuery.eq = jest.fn().mockReturnValue(mockQuery);
      mockQuery.or = jest.fn().mockReturnValue(mockQuery);
      mockQuery.insert = jest.fn().mockReturnValue(mockQuery);
      mockQuery.update = jest.fn().mockReturnValue(mockQuery);
      mockQuery.single = jest.fn().mockReturnValue(
        Promise.resolve({
          data: { id: 1, type: 'chat', slug: 'test_category' },
          error: null,
        })
      );
      return mockQuery;
    }),
  })),
}));

// Mock notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true),
}));

import router from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', router);

describe('Admin Notification Categories API - Auth Boundaries', () => {
  it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 FORBIDDEN when an authenticated non-admin attempts access', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer non-admin');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should return 200 OK for GET when authenticated as admin', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 Created for POST when authenticated as admin', async () => {
    const res = await request(app)
      .post('/admin-notification-categories')
      .set('Authorization', 'Bearer admin')
      .send({ type: 'chat', display_name: 'Test Category' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});