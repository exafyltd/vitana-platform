import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';

process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE = 'service-role-key';

// Mock the requireAdmin middleware to test the auth boundary constraints
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (auth === 'Bearer admin') {
      req.user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// Mock Supabase to bypass actual database calls post-auth
jest.mock('@supabase/supabase-js', () => {
  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: null }),
    then: jest.fn(function(this: any, resolve) {
      resolve({ data: [], error: null });
    })
  };

  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQueryBuilder)
    }))
  };
});

// Mock notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({})
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Auth Boundaries', () => {
    it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
      const response = await request(app).get('/admin/notification-categories');
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    });

    it('should return 403 FORBIDDEN when a non-admin token is provided', async () => {
      const response = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer non-admin');
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
    });

    it('should return 200 OK when an admin token is provided (GET list)', async () => {
      const response = await request(app)
        .get('/admin/notification-categories')
        .set('Authorization', 'Bearer admin');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    it('should return 201 CREATED when an admin token is provided (POST create)', async () => {
      // Temporarily mock the single() call specifically for the POST insert resolution
      const { createClient } = require('@supabase/supabase-js');
      const mockInsertBuilder = {
        select: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: { id: 'new-id', type: 'chat', slug: 'test_category' },
          error: null
        })
      };
      
      const client = createClient();
      client.from.mockImplementationOnce(() => ({
        insert: jest.fn(() => mockInsertBuilder)
      }));

      const response = await request(app)
        .post('/admin/notification-categories')
        .set('Authorization', 'Bearer admin')
        .send({
          type: 'chat',
          display_name: 'Test Category'
        });

      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
    });
  });
});