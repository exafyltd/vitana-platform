import request from 'supertest';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import router from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

// Mock dependencies
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn()
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin-categories', router);

describe('Admin Notification Categories - Auth Boundary', () => {
  let mockRequireAdmin: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdmin = requireAdmin as jest.Mock;

    // Build a mock Supabase query chain resolving with an empty set
    const mockQuery: any = {
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      single: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis()
    };
    mockQuery.then = jest.fn().mockImplementation((resolve) => resolve({ data: [], error: null }));

    (createClient as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(mockQuery)
    });
  });

  it('should return 401 UNAUTHENTICATED when requesting without a token', async () => {
    mockRequireAdmin.mockImplementation((req, res) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin-categories');
    
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
  });

  it('should return 403 FORBIDDEN when requesting with a non-admin token', async () => {
    mockRequireAdmin.mockImplementation((req, res) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app)
      .get('/admin-categories')
      .set('Authorization', 'Bearer invalid-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
  });

  it('should return 200 OK when requesting with a valid admin token', async () => {
    mockRequireAdmin.mockImplementation((req, res, next) => {
      // Attach admin user payload and proceed
      (req as any).user = { id: 'admin-123', email: 'admin@test.com' };
      next();
    });

    const res = await request(app)
      .get('/admin-categories')
      .set('Authorization', 'Bearer valid-admin-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Evaluates the grouped empty sets generated from mockQuery default empty data response
    expect(res.body.data).toEqual({ chat: [], calendar: [], community: [] });
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
  });
});