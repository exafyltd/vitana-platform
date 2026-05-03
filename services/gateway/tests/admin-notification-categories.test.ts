import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

// Mock the middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

// Mock Supabase to avoid real database connections
const mockSupabaseClient = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: { id: 'test-1', slug: 'test-slug' }, error: null }),
  then: jest.fn((resolve) => resolve({ data: [], error: null }))
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient)
}));

// Mock Notification Service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 when unauthenticated', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 when authenticated but non-admin', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('FORBIDDEN');
  });

  it('should pass auth and return 200 for admin user on GET', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@exafy.test' };
      next();
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('should pass auth and return 201 for admin user on POST', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@exafy.test' };
      next();
    });

    const response = await request(app).post('/admin/notification-categories').send({
      type: 'chat',
      display_name: 'Test Category'
    });
    
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
  });
});