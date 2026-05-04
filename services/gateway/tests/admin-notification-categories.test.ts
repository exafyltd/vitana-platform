import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

// Mock the auth middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    if (auth === 'Bearer non-admin') return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    if (auth === 'Bearer admin') {
      req.user = { id: 'admin-id', email: 'admin@example.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// Mock supabase client
jest.mock('@supabase/supabase-js', () => {
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ 
      data: { id: 'test-id', slug: 'test-slug', type: 'chat', mapped_types: [] }, 
      error: null 
    }),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  };

  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mockQuery)
    }))
  };
});

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({})
}));

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 UNAUTHENTICATED without Bearer token', async () => {
    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 403 FORBIDDEN with non-admin token', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer non-admin');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('returns 200 OK with admin token on GET', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
  
  it('returns 201 Created with admin token on POST', async () => {
    const res = await request(app)
      .post('/admin-notification-categories')
      .set('Authorization', 'Bearer admin')
      .send({
        type: 'chat',
        display_name: 'Test Category'
      });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});