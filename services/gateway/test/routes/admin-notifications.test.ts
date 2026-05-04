import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

const mockSupabase = {
  from: jest.fn()
};
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase)
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true }),
  notifyUsersAsync: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

const createChainable = (result: any) => {
  const chain: any = {
    select: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    order: jest.fn(() => chain),
    range: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    or: jest.fn(() => chain),
    not: jest.fn(() => chain),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
};

describe('Admin Notifications Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('requires title and body', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['u1'] });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns error if no recipients specified', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B' });
      
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Must specify recipient_ids/);
    });

    it('sends to single user successfully', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B', recipient_ids: ['u1'] });
      
      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
    });
  });

  describe('GET /sent', () => {
    it('returns sent notifications', async () => {
      mockSupabase.from.mockImplementation(() => createChainable({ data: [], count: 0, error: null }));
      
      const res = await request(app).get('/admin/notifications/sent');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.total).toBe(0);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns preferences stats', async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'user_notification_preferences') {
          return createChainable({ data: [{ push_enabled: true }], error: null });
        }
        if (table === 'user_notifications') {
          return createChainable({ count: 1 });
        }
        return createChainable({});
      });

      const res = await request(app).get('/admin/notifications/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(1);
    });
  });
});