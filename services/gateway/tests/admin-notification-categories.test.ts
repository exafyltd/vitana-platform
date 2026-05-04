import request from 'supertest';
import express from 'express';

// 1. Mock the requireAdmin middleware boundary
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (auth === 'Bearer non-admin') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    if (auth === 'Bearer admin') {
      req.user = { id: 'admin-123', email: 'admin@exafy.com' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}));

// 2. Mock external services so handlers don't fail internally
const mockQuery = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: { id: '1', type: 'chat', slug: 'test' }, error: null }),
  then: jest.fn(function(this: any, resolve: any) {
    return Promise.resolve({ data: [{ id: '1', type: 'chat', slug: 'test' }], error: null }).then(resolve);
  })
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockQuery)
  }))
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true)
}));

import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories - Auth Boundary', () => {
  beforeAll(() => {
    process.env.SUPABASE_URL = 'http://localhost';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';
    
    // Silence console logs during tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('rejects unauthenticated requests with 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('rejects authenticated non-admins with 403 FORBIDDEN', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin');
    
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('allows authenticated admins on GET and returns 200', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('allows authenticated admins on POST and returns 201', async () => {
    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer admin')
      .send({ type: 'chat', display_name: 'Test Chat' });
    
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});