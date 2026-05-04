import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';

const mockThen = jest.fn();

const chainable = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  gte: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  range: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  not: jest.fn().mockReturnThis(),
  then: mockThen
};

const mockSupabase = {
  from: jest.fn().mockReturnValue(chainable)
};

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase)
}));

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true }),
  notifyUsersAsync: jest.fn().mockResolvedValue(true)
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThen.mockImplementation((cb) => cb({ data: [], error: null }));
  });

  describe('POST /compose', () => {
    it('returns 400 if title or body is missing', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['user1'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns 400 if no recipients criteria provided', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B' });
      expect(res.status).toBe(400);
    });

    it('sends directly to specific recipient_ids', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B', recipient_ids: ['user1'] });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
    });

    it('sends to role based recipients', async () => {
      mockThen.mockImplementationOnce((cb) => cb({
        data: [{ user_id: 'user1' }, { user_id: 'user2' }],
        error: null
      }));

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B', recipient_role: 'admin', tenant_id: 'tenant1' });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(2);
    });

    it('sends to all users in tenant', async () => {
      mockThen.mockImplementationOnce((cb) => cb({
        data: [{ user_id: 'user1' }, { user_id: 'user2' }, { user_id: 'user3' }],
        error: null
      }));

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B', send_to_all: true, tenant_id: 'tenant1' });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(3);
    });
  });

  describe('GET /sent', () => {
    it('returns sent notifications', async () => {
      mockThen.mockImplementationOnce((cb) => cb({
        data: [{ id: 'notif1', title: 'Test' }],
        count: 1,
        error: null
      }));

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns stats', async () => {
      // 1. prefs
      mockThen.mockImplementationOnce((cb) => cb({
        data: [
          { push_enabled: true, dnd_enabled: false },
          { push_enabled: false, dnd_enabled: true }
        ],
        error: null
      }));
      // 2. total notifications 30d
      mockThen.mockImplementationOnce((cb) => cb({
        count: 100,
        error: null
      }));
      // 3. read notifications 30d
      mockThen.mockImplementationOnce((cb) => cb({
        count: 50,
        error: null
      }));

      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.stats.push_disabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(100);
      expect(res.body.delivery.total_read_30d).toBe(50);
      expect(res.body.delivery.read_rate).toBe(50);
    });
  });
});