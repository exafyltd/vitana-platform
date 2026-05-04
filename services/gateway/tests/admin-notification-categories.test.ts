import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

// Mock the requireAdmin middleware before importing the router
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    (req as any).user = { id: 'admin-123', email: 'admin@exafy.com' };
    next();
  }
}));

// Mock Supabase to prevent actual database connections during auth tests
jest.mock('@supabase/supabase-js', () => {
  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ 
      data: { id: 'test-1', type: 'chat', slug: 'mock-category' }, 
      error: null 
    }),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
  };

  // Support awaiting the builder directly for GET / list endpoints
  (mockQueryBuilder as any).then = function (resolve: any) {
    resolve({ data: [{ id: 'test-1', type: 'chat', slug: 'mock-category' }], error: null });
  };

  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQueryBuilder),
    }))
  };
});

import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories Auth Boundary', () => {
  beforeAll(() => {
    process.env.SUPABASE_URL = 'http://localhost-mock';
    process.env.SUPABASE_SERVICE_ROLE = 'mock-key';
  });

  describe('Unauthenticated Request', () => {
    it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
      const response = await request(app).get('/admin/notification-categories');
      
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    });
  });

  describe('Authenticated Non-Admin', () => {
    it('should return 403 FORBIDDEN when token lacks admin privileges', async () => {
      const response = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer non-admin');
        
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
    });
  });

  describe('Authenticated Admin', () => {
    it('should return 200 OK for GET requests with valid admin token', async () => {
      const response = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer admin-token');
        
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    it('should return 201 CREATED for POST requests with valid admin token', async () => {
      const response = await request(app)
        .post('/admin/notification-categories')
        .set('Authorization', 'Bearer admin-token')
        .send({
          type: 'chat',
          display_name: 'Admin Test Category'
        });
        
      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
    });
  });
});