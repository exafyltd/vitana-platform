import express from 'express';
import request from 'supertest';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser } from '../../src/services/notification-service';

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn(),
}));

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-123', email: 'admin@test.com' };
    next();
  }),
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('returns 400 if title or body is missing', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['user-1'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns 400 if no recipient criteria provided', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Test body' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('sends to single recipient synchronously', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Body', recipient_ids: ['user-1'] });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith('user-1', '', 'welcome_to_vitana', {
        title: 'Test',
        body: 'Body',
        data: undefined
      }, expect.anything());
    });
  });

  describe('GET /sent', () => {
    it('returns 500 if supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(500);
    });

    it('returns paginated results', async () => {
      const mockQuery = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({ data: [{ id: 1 }], count: 1 })
      };
      (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn().mockReturnValue(mockQuery) });

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns stats', async () => {
      const mockPrefsQuery = {
        select: jest.fn().mockResolvedValue({ data: [{ push_enabled: true }, { push_enabled: false }] })
      };

      const mockNotificationsQuery = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockImplementation(() => {
          const promise = Promise.resolve({ count: 10 }) as any;
          promise.not = jest.fn().mockResolvedValue({ count: 5 });
          return promise;
        })
      };

      const mockFrom = jest.fn((table) => {
        if (table === 'user_notification_preferences') return mockPrefsQuery;
        if (table === 'user_notifications') return mockNotificationsQuery;
        return { select: jest.fn() };
      });

      (getSupabase as jest.Mock).mockReturnValue({ from: mockFrom });

      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(10);
      expect(res.body.delivery.total_read_30d).toBe(5);
    });
  });
});