import request from 'supertest';
import express, { Express } from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({}),
  notifyUsersAsync: jest.fn()
}));

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireExafyAdmin: jest.fn((req, res, next) => {
    req.identity = {
      user_id: 'admin-id',
      email: 'admin@test.com',
      tenant_id: 'test-tenant',
      exafy_admin: true,
      role: 'admin'
    };
    next();
  })
}));

describe('Admin Notifications Router', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/admin-notifications', adminNotificationsRouter);
  });

  const mockSupabaseQuery = (resolvedValue: any) => {
    const chainable: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis()
    };
    chainable.then = (resolve: any) => resolve(resolvedValue);
    return chainable;
  };

  it('POST /compose - requires recipients', async () => {
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(mockSupabaseQuery({ data: [], error: null }))
    });

    const response = await request(app)
      .post('/admin-notifications/compose')
      .send({ title: 'T', body: 'B' });
    
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Must specify recipient_ids/);
  });

  it('POST /compose - direct user', async () => {
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn()
    });

    const response = await request(app)
      .post('/admin-notifications/compose')
      .send({ title: 'T', body: 'B', recipient_ids: ['u1'] });
    
    expect(response.status).toBe(200);
    expect(response.body.sent_to).toBe(1);
  });

  it('GET /sent - returns 200', async () => {
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(mockSupabaseQuery({ data: [{ id: 'n1' }], count: 1, error: null }))
    });

    const response = await request(app)
      .get('/admin-notifications/sent')
      .query({ limit: 10 });
    
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
  });

  it('GET /preferences/stats - returns 200', async () => {
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(mockSupabaseQuery({ data: [], count: 0, error: null }))
    });

    const response = await request(app)
      .get('/admin-notifications/preferences/stats');
    
    expect(response.status).toBe(200);
    expect(response.body.stats).toBeDefined();
    expect(response.body.delivery).toBeDefined();
  });
});