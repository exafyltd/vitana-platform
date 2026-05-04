import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

// Mock the requireAdmin middleware to test the auth boundary
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

// Mock Supabase to bypass actual database connections
jest.mock('@supabase/supabase-js', () => {
  const mockPostgrestBuilder = {
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    then: jest.fn(function(resolve) {
      return resolve({ data: [], error: null });
    })
  };

  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockPostgrestBuilder)
    }))
  };
});

// Mock notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', router);

describe('Admin Notification Categories Routes - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 for unauthenticated requests', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin-notification-categories');
    
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(requireAdmin).toHaveBeenCalled();
  });

  it('should return 403 for authenticated non-admin users', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin-notification-categories');
    
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(requireAdmin).toHaveBeenCalled();
  });

  it('should return 200 for authenticated admin users on GET', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin123', email: 'admin@example.com' };
      next();
    });

    const res = await request(app).get('/admin-notification-categories');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(requireAdmin).toHaveBeenCalled();
  });
});