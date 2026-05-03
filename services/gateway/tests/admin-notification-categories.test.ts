import request from 'supertest';
import express from 'express';
import { requireAdmin } from '../src/middleware/auth';
import router from '../src/routes/admin-notification-categories';
import { createClient } from '@supabase/supabase-js';

jest.mock('../src/middleware/auth', () => ({
  requireAdmin: jest.fn(),
}));

jest.mock('@supabase/supabase-js', () => {
  const mBuilder = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: jest.fn((resolve) => resolve({ data: [], error: null })),
  };
  return {
    createClient: jest.fn(() => mBuilder),
  };
});

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(true),
}));

const app = express();
app.use(express.json());
app.use('/admin-notification-categories', router);

describe('Admin Notification Categories Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = 'http://localhost';
    process.env.SUPABASE_SERVICE_ROLE = 'secret';
  });

  it('rejects unauthenticated requests with 401', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const response = await request(app).get('/admin-notification-categories');
    expect(response.status).toBe(401);
  });

  it('rejects authenticated non-admin requests with 403', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const response = await request(app).post('/admin-notification-categories').send({ type: 'chat', display_name: 'Test' });
    expect(response.status).toBe(403);
  });

  it('allows authenticated admin requests (GET) and returns 200', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin123', email: 'admin@example.com' };
      next();
    });

    const response = await request(app).get('/admin-notification-categories');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('allows authenticated admin requests (POST) and returns 201', async () => {
    const mockBuilder = createClient('url', 'key');
    (mockBuilder.then as jest.Mock).mockImplementationOnce((resolve: any) => 
      resolve({ data: { id: 'new-id', slug: 'test' }, error: null })
    );

    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin123', email: 'admin@example.com' };
      next();
    });

    const response = await request(app)
      .post('/admin-notification-categories')
      .send({ type: 'chat', display_name: 'Test Chat' });
      
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
  });
});