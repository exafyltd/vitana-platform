import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';

// Mock the auth middleware to simulate the route scanner requirements
jest.mock('../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader === 'Bearer user-token') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (authHeader === 'Bearer admin-token') {
      // Attach mocked user info as expected by the new route handlers
      req.user = { id: 'admin-123', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }),
}));

// Mock Supabase to prevent actual DB calls during route testing
const mockSupabaseChain = {
  select: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ 
    data: { id: 'cat-123', type: 'chat', slug: 'chat-test' }, 
    error: null 
  }),
  then: jest.fn(function (this: any, resolve) {
    resolve({ 
      data: [{ id: 'cat-123', type: 'chat', slug: 'chat-test' }], 
      error: null 
    });
  }),
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockSupabaseChain),
  })),
}));

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', router);

describe('Admin Notification Categories API - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthenticated requests without a token (401)', async () => {
    const res = await request(app).get('/admin-notification-categories');
    
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('rejects authenticated non-admin requests (403)', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer user-token');
    
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('allows access for authenticated admin users (200 OK on GET)', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer admin-token');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it('allows access for authenticated admin users (201 Created on POST)', async () => {
    const res = await request(app)
      .post('/admin-notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({
        type: 'chat',
        display_name: 'System Chat Category',
      });
    
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});