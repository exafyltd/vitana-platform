import request from 'supertest';
import express from 'express';
import router from '../src/routes/admin-notification-categories';

// 1. Mock standard requireAdmin middleware
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
      req.user = { id: 'admin-123', email: 'admin@exafy.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// 2. Mock Supabase Client chain cleanly
jest.mock('@supabase/supabase-js', () => {
  const createMockChain = (data: any) => {
    const chain: any = {
      select: jest.fn(() => chain),
      order: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      is: jest.fn(() => chain),
      or: jest.fn(() => chain),
      single: jest.fn(() => {
        // Unpack array to a single object when .single() is called
        chain.then = jest.fn((resolve: any) => 
          resolve({ data: Array.isArray(data) ? data[0] : data, error: null })
        );
        return chain;
      }),
      insert: jest.fn(() => chain),
      update: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      // Default to returning the full array for list queries
      then: jest.fn((resolve: any) => resolve({ data, error: null }))
    };
    return chain;
  };

  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => createMockChain([{ 
        id: '1', 
        slug: 'test-category', 
        type: 'chat', 
        mapped_types: [] 
      }]))
    }))
  };
});

// 3. Mock Notification Service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

const app = express();
app.use(express.json());
app.use('/admin-categories', router);

describe('Admin Notification Categories API - Authentication Boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 UNAUTHENTICATED when no token is provided', async () => {
    const res = await request(app).get('/admin-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 403 FORBIDDEN when accessed by an authenticated non-admin user', async () => {
    const res = await request(app)
      .get('/admin-categories')
      .set('Authorization', 'Bearer non-admin-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('allows access and returns 200 for an authenticated admin user (GET)', async () => {
    const res = await request(app)
      .get('/admin-categories')
      .set('Authorization', 'Bearer admin-token');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Verifies the route returned mocked data
    expect(res.body.data.chat).toHaveLength(1);
  });

  it('allows access and returns 201 for an authenticated admin user (POST)', async () => {
    const res = await request(app)
      .post('/admin-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({ type: 'chat', display_name: 'Chat Category' });
    
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});