import request from 'supertest';
import express from 'express';

process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE = 'anon-key';

// Mock the middleware
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

class MockQueryBuilder {
  from() { return this; }
  select() { return this; }
  order() { return this; }
  eq() { return this; }
  or() { return this; }
  is() { return this; }
  single() { return this; }
  limit() { return this; }
  insert() { return this; }
  update() { return this; }
  delete() { return this; }
  then(resolve: any) {
    return Promise.resolve({ data: [], error: null }).then(resolve);
  }
}

// Mock Supabase
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => new MockQueryBuilder()
}));

// Mock Notification Service
jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({})
}));

import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API Auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 UNAUTHENTICATED without Bearer token', async () => {
    const res = await request(app).get('/admin-notification-categories');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('returns 403 FORBIDDEN for authenticated non-admin', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer non-admin-token');
    
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('returns 200 for authenticated admin on GET /', async () => {
    const res = await request(app)
      .get('/admin-notification-categories')
      .set('Authorization', 'Bearer admin-token');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 201 for authenticated admin on POST /', async () => {
    const res = await request(app)
      .post('/admin-notification-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({ type: 'chat', display_name: 'Chat Group' });
    
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});