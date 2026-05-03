import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications API', () => {
  const mockSupabase = {
    from: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  describe('POST /compose', () => {
    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('title and body are required');
    });

    it('should send notification to specific user IDs', async () => {
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Test Title',
          body: 'Test Body',
          recipient_ids: ['user-1']
        });

      expect(response.status).toBe(200);
      expect(response.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        { title: 'Test Title', body: 'Test Body', data: undefined },
        mockSupabase
      );
    });

    it('should send notifications to all users with a role in a tenant', async () => {
      const mockQuery: any = {
        select: jest.fn().mockReturnThis()
      };
      mockQuery.eq = jest.fn().mockImplementation((field, value) => {
        if (field === 'active_role') {
          return Promise.resolve({ data: [{ user_id: 'user-2' }, { user_id: 'user-3' }] });
        }
        return mockQuery;
      });

      mockSupabase.from.mockReturnValue(mockQuery);

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Role Test',
          body: 'Role Body',
          recipient_role: 'community',
          tenant_id: 'tenant-1'
        });

      expect(response.status).toBe(200);
      expect(response.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user-2', 'user-3'],
        'tenant-1',
        'welcome_to_vitana',
        { title: 'Role Test', body: 'Role Body', data: undefined },
        mockSupabase
      );
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const mockQuery = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({ data: [{ id: 'notif-1' }], count: 1 })
      };
      mockSupabase.from.mockReturnValue(mockQuery);

      const response = await request(app)
        .get('/admin/notifications/sent');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return preference statistics', async () => {
      const mockPrefsQuery = {
        select: jest.fn().mockResolvedValue({ data: [{ push_enabled: true }, { push_enabled: false }] })
      };

      const mockGte = jest.fn().mockImplementation(() => {
        const promise = Promise.resolve({ count: 50 });
        (promise as any).not = jest.fn().mockResolvedValue({ count: 20 });
        return promise;
      });

      const mockNotifsQuery = {
        select: jest.fn().mockReturnThis(),
        gte: mockGte
      };

      mockSupabase.from.mockImplementation((table) => {
        if (table === 'user_notification_preferences') return mockPrefsQuery;
        if (table === 'user_notifications') return mockNotifsQuery;
      });

      const response = await request(app)
        .get('/admin/notifications/preferences/stats');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.stats.total_users_with_prefs).toBe(2);
      expect(response.body.delivery.total_sent_30d).toBe(50);
      expect(response.body.delivery.total_read_30d).toBe(20);
      expect(response.body.delivery.read_rate).toBe(40);
    });
  });
});