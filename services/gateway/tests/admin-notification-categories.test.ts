import request from 'supertest';
import express from 'express';

// Mock Supabase to avoid actual network requests during auth boundary tests
const mockQuery = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ 
    data: { id: 'cat-1', type: 'chat', slug: 'test', display_name: 'Test Category' }, 
    error: null 
  }),
  then: jest.fn((resolve) => resolve({ data: [], error: null }))
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockQuery)
  }))
}));

// Mock the notification service to prevent side effects
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

// Mock the requireAdmin middleware which is the primary system under test for boundaries
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => next())
}));

import router from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', router);

describe('Admin Notification Categories - Auth Boundary', () => {
  beforeAll(() => {
    process.env.SUPABASE_URL = 'http://localhost';
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-key';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 for unauthenticated request', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 for authenticated non-admin request', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should return 200 for authenticated admin on GET /', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('should return 201 for authenticated admin on POST /', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const response = await request(app)
      .post('/admin/notification-categories')
      .send({
        type: 'chat',
        display_name: 'Test Category'
      });
      
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
  });
});