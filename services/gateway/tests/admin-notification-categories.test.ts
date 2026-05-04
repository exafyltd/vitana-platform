import request from 'supertest';
import express from 'express';

// 1. Mock requireAdmin middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));
import { requireAdmin } from '../src/middleware/requireAdmin';
const mockedRequireAdmin = requireAdmin as jest.MockedFunction<any>;

// 2. Mock Supabase client
const createMockBuilder = () => {
  const builder: any = {
    select: jest.fn(() => builder),
    order: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    is: jest.fn(() => builder),
    or: jest.fn(() => builder),
    limit: jest.fn(() => builder),
    single: jest.fn().mockResolvedValue({ data: { id: '1', slug: 'test-category' }, error: null }),
    insert: jest.fn(() => builder),
    update: jest.fn(() => builder),
    then: jest.fn((resolve) => resolve({ data: [], error: null })),
  };
  return builder;
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => createMockBuilder())
  }))
}));

// 3. Mock notification service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

import router from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', router);

describe('Admin Notification Categories API - Auth Boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 for unauthenticated request', async () => {
    mockedRequireAdmin.mockImplementation((req, res, next) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin-notification-categories');
    
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 for authenticated non-admin', async () => {
    mockedRequireAdmin.mockImplementation((req, res, next) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/admin-notification-categories');
    
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should allow request and return 200 for authenticated admin (GET)', async () => {
    mockedRequireAdmin.mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const res = await request(app).get('/admin-notification-categories');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should allow request and return 201 for authenticated admin (POST)', async () => {
    mockedRequireAdmin.mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const res = await request(app)
      .post('/admin-notification-categories')
      .send({ type: 'chat', display_name: 'Test Category' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});