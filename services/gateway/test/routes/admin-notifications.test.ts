import request from 'supertest';
import express from 'express';

// Mock dependencies
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, _res, next) => {
    // Attach a mock user
    req.user = { id: 'admin-123', email: 'admin@test.com' };
    next();
  })
}));

import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should return 400 if title and body are missing', async () => {
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('INVALID_INPUT');
    });

    it('should return 400 if no recipient criteria is provided', async () => {
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Hello', body: 'World' });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('INVALID_INPUT');
    });

    it('should return 500 if Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Hello', body: 'World', recipient_ids: ['user-1'] });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('SUPABASE_UNAVAILABLE');
    });

    it('should successfully compose for a single recipient', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['user-1']
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith('user-1', '', 'welcome_to_vitana', expect.any(Object), expect.any(Object));
    });

    it('should successfully compose for multiple recipients', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      (notifyUsersAsync as jest.Mock).mockReturnValue(undefined);

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['user-1', 'user-2']
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(['user-1', 'user-2'], '', 'welcome_to_vitana', expect.any(Object), expect.any(Object));
    });

    it('should fetch users from tenant if send_to_all is used', async () => {
      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        then: function(resolve: any) {
          resolve({
            data: [{ user_id: 'u1' }, { user_id: 'u2' }],
            error: null
          });
        }
      };

      const mockSupabase = {
        from: jest.fn().mockReturnValue(mockQueryBuilder)
      };

      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
      (notifyUsersAsync as jest.Mock).mockReturnValue(undefined);

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          send_to_all: true,
          tenant_id: 't1'
        });

      expect(response.status).toBe(200);
      expect(response.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(['u1', 'u2'], 't1', 'welcome_to_vitana', expect.any(Object), mockSupabase);
    });
  });

  describe('GET /sent', () => {
    it('should return 500 if Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);

      const response = await request(app).get('/admin/notifications/sent');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('SUPABASE_UNAVAILABLE');
    });

    it('should return successfully with data from Supabase', async () => {
      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        then: function(resolve: any) {
          resolve({ data: [{ id: 'notif-1' }], count: 1, error: null });
        }
      };
      
      const mockSupabase = {
        from: jest.fn().mockReturnValue(mockQueryBuilder)
      };

      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/sent');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return aggregate stats successfully', async () => {
      const prefsQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        then: function(resolve: any) {
          resolve({
            data: [
              { push_enabled: true, dnd_enabled: false },
              { push_enabled: false, dnd_enabled: true }
            ],
            error: null
          });
        }
      };

      let notifCallCount = 0;
      const notificationQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnThis(),
        then: function(resolve: any) {
          notifCallCount++;
          if (notifCallCount === 1) {
            resolve({ count: 100, error: null });
          } else {
            resolve({ count: 50, error: null });
          }
        }
      };

      const mockSupabase = {
        from: jest.fn((table) => {
          if (table === 'user_notification_preferences') return prefsQueryBuilder;
          if (table === 'user_notifications') return notificationQueryBuilder;
          return null;
        })
      };

      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/preferences/stats');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.stats.total_users_with_prefs).toBe(2);
      expect(response.body.stats.push_enabled).toBe(1);
      expect(response.body.stats.push_disabled).toBe(1);
      expect(response.body.stats.dnd_enabled).toBe(1);
      expect(response.body.delivery.total_sent_30d).toBe(100);
      expect(response.body.delivery.total_read_30d).toBe(50);
      expect(response.body.delivery.read_rate).toBe(50);
    });
  });
});