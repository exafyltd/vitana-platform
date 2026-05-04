import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';
import { createClient } from '@supabase/supabase-js';

// Mock the auth middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

// Mock Supabase client
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn()
}));

// Mock notification service to avoid side effects
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API - Auth Boundary', () => {
  let mockSupabaseChain: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockSupabaseChain = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      single: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
    };
    
    // Default promise resolution
    mockSupabaseChain.then = jest.fn().mockImplementation((resolve) => resolve({ data: [], error: null }));
    
    (createClient as jest.Mock).mockReturnValue(mockSupabaseChain);
  });

  it('returns 401 for unauthenticated request', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('returns 403 for authenticated non-admin', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('returns 200 for authenticated admin on GET', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@exafy.com' };
      next();
    });

    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('returns 201 for authenticated admin on POST', async () => {
    (requireAdmin as jest.Mock).mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@exafy.com' };
      next();
    });

    // Mock specific resolution for POST so it doesn't fail checks
    mockSupabaseChain.then = jest.fn().mockImplementation((resolve) => resolve({ 
      data: { id: 'cat-1', slug: 'test-category' }, 
      error: null 
    }));

    const response = await request(app).post('/admin/notification-categories').send({
      type: 'chat',
      display_name: 'Test Category'
    });
    
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
  });
});