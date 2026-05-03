import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn(),
}));

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  }),
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications Route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should compose a notification for a single user', async () => {
      const mockSupabase = {
        from: jest.fn(),
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
      (notifyUser as jest.Mock).mockResolvedValue({ id: 'notif-id' });

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Test',
          body: 'Test Body',
          recipient_ids: ['user-1'],
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        { title: 'Test', body: 'Test Body', data: undefined },
        mockSupabase
      );
    });

    it('should require title and body', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          recipient_ids: ['user-1'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({ data: [{ id: 'notif-1' }], error: null, count: 1 }),
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/sent');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return preference stats', async () => {
      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn((table) => {
          const chain: any = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            gte: jest.fn().mockReturnThis(),
            not: jest.fn().mockReturnThis(),
          };
          chain.then = function (cb: any) {
            if (table === 'user_notification_preferences') {
              return Promise.resolve({ data: [{ push_enabled: true }], error: null }).then(cb);
            }
            return Promise.resolve({ count: 10, error: null }).then(cb);
          };
          return chain;
        })
      });

      const res = await request(app).get('/admin/notifications/preferences/stats');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(10);
    });
  });
});