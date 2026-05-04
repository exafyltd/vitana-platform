import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

// Mock requireAdmin middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer admin') {
      req.user = { id: 'admin-id', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// Mock Supabase
jest.mock('@supabase/supabase-js', () => {
  const mockQuery: any = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: null }),
  };
  
  // Make the mock object itself thenable so we can await the chain
  mockQuery.then = jest.fn((resolve) => {
    resolve({ data: [], error: null });
  });

  return {
    createClient: jest.fn(() => mockQuery)
  };
});

// Mock Notification Service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API - Auth Boundary', () => {
  it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
    const response = await request(app).get('/admin/notification-categories');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 FORBIDDEN when an authenticated non-admin token is provided', async () => {
    const response = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should return 200 on GET / when an admin token is provided', async () => {
    const { createClient } = require('@supabase/supabase-js');
    const mockSupabase = createClient();
    
    mockSupabase.then.mockImplementationOnce((resolve: any) => 
      resolve({ data: [{ id: '1', type: 'chat', display_name: 'Chat Notifs' }], error: null })
    );

    const response = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin');
    
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toHaveProperty('chat');
  });

  it('should return 201 on POST / when an admin token is provided', async () => {
    const { createClient } = require('@supabase/supabase-js');
    const mockSupabase = createClient();
    
    mockSupabase.single.mockResolvedValueOnce({
      data: { id: '2', type: 'chat', slug: 'test_chat' },
      error: null
    });

    const response = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin')
      .send({ type: 'chat', display_name: 'Test Chat' });
    
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
  });
});