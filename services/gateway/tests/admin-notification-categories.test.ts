import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

// Mock Supabase
const mockQuery = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: { id: 'cat-1', type: 'chat', slug: 'test' }, error: null }),
  then: jest.fn((resolve) => resolve({ data: [], error: null }))
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockQuery)
}));

// Mock Notification Service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

// Mock Auth Middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (auth === 'Bearer admin') {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  })
}));

import router from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Auth Boundaries', () => {
    it('should return 401 for unauthenticated request', async () => {
      const res = await request(app).get('/admin/notification-categories');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('should return 403 for authenticated non-admin', async () => {
      const res = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer non-admin');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('should return 200 for authenticated admin on GET', async () => {
      const res = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer admin');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('should return 201 for authenticated admin on POST', async () => {
      const res = await request(app)
        .post('/admin/notification-categories')
        .set('Authorization', 'Bearer admin')
        .send({
          type: 'chat',
          display_name: 'Test Chat'
        });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    });
  });
});