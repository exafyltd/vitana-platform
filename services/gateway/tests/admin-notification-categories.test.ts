import request from 'supertest';
import express from 'express';

// Mock the requireAdmin middleware before the router is imported
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer non-admin-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer admin-token') {
      req.user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// Mock Supabase to prevent actual DB calls during the tests
const mockQuery = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: { id: 'test-cat', type: 'chat' }, error: null }),
  then: jest.fn((resolve) => resolve({ data: [], error: null })),
};

const mockSupabase = {
  from: jest.fn(() => mockQuery)
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => mockSupabase
}));

import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 UNAUTHENTICATED when no token is provided', async () => {
    const response = await request(app).get('/admin-notification-categories');
    
    expect(response.status).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 FORBIDDEN when an authenticated non-admin token is provided', async () => {
    const response = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer non-admin-token');
      
    expect(response.status).toBe(403);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 OK when an authenticated admin token is provided', async () => {
    const response = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer admin-token');
      
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toBeDefined();
  });

  it('should allow admin POST requests to successfully pass the boundary', async () => {
    const payload = {
      type: 'chat',
      display_name: 'Test Category'
    };

    // Override the insert mock for this test
    mockQuery.single.mockResolvedValueOnce({ data: { ...payload, id: 'new-id' }, error: null });
    const insertMock = jest.fn(() => mockQuery);
    mockSupabase.from.mockImplementationOnce(() => ({
      ...mockQuery,
      insert: insertMock
    } as any));

    const response = await request(app)
      .post('/admin-notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send(payload);

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
  });
});