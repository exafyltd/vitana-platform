import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

// Mock the requireAdmin middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => next()),
}));

jest.mock('@supabase/supabase-js', () => {
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: {}, error: null }),
    then: jest.fn((resolve) => resolve({ data: [], error: null }))
  };
  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQuery)
    })),
  };
});

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories Auth Boundary', () => {
  let mockRequireAdmin: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdmin = requireAdmin as jest.Mock;
  });

  it('returns 401 for unauthenticated request', async () => {
    mockRequireAdmin.mockImplementationOnce((req, res, next) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 403 for authenticated non-admin request', async () => {
    mockRequireAdmin.mockImplementationOnce((req, res, next) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('returns 200 for authenticated admin request on GET', async () => {
    mockRequireAdmin.mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-id', email: 'admin@example.com' };
      next();
    });

    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 201 for authenticated admin request on POST', async () => {
    mockRequireAdmin.mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-id', email: 'admin@example.com' };
      next();
    });

    const { createClient } = require('@supabase/supabase-js');
    const mockSupabase = createClient();
    mockSupabase.from().single.mockResolvedValueOnce({
      data: { id: 'cat-id', type: 'chat', slug: 'test-chat' },
      error: null
    });

    const res = await request(app)
      .post('/admin-notification-categories')
      .send({ type: 'chat', display_name: 'Test Chat' });
    
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});