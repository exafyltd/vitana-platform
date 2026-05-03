import request from 'supertest';
import express from 'express';

// Mock requireAdmin BEFORE importing router
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    if (auth === 'Bearer non-admin') return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    
    req.user = { id: 'admin-123', email: 'admin@example.com' };
    next();
  }
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true })
}));

const createMockSupabase = () => {
  const chain: any = {};
  const methods = ['from', 'select', 'order', 'eq', 'is', 'or', 'single', 'insert', 'update', 'delete', 'limit'];
  methods.forEach(method => {
    chain[method] = jest.fn(() => chain);
  });
  chain.then = (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve);
  return chain;
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => createMockSupabase())
}));

import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

beforeAll(() => {
  process.env.SUPABASE_URL = 'http://localhost';
  process.env.SUPABASE_SERVICE_ROLE = 'test-key';
});

describe('Admin Notification Categories Auth Boundary', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('rejects non-admin authenticated requests with 403', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer non-admin');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('allows authenticated admin requests (GET) with 200', async () => {
    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});