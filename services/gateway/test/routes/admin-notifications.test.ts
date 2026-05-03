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
  let mockSupabase: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSupabase = {
      from: jest.fn(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
    };

    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body is missing', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Hello' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should return 400 if recipient criteria is missing', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Hello', body: 'World' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should send notification to a specific user', async () => {
      (notifyUser as jest.Mock).mockResolvedValue({ id: 'notif-1' });

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['user-1']
        });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        expect.objectContaining({ title: 'Hello', body: 'World' }),
        mockSupabase
      );
    });

    it('should fetch users by role and send to them', async () => {
      mockSupabase.from.mockImplementation(() => {
        const chain: any = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          then: (resolve: any) => resolve({ data: [{ user_id: 'user-2' }, { user_id: 'user-3' }], error: null })
        };
        return chain;
      });

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_role: 'creator',
          tenant_id: 'tenant-1'
        });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user-2', 'user-3'],
        'tenant-1',
        'welcome_to_vitana',
        expect.objectContaining({ title: 'Hello', body: 'World' }),
        mockSupabase
      );
    });

    it('should return 500 if Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['user-1']
        });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('SUPABASE_UNAVAILABLE');
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      mockSupabase.from.mockImplementation(() => {
        const chain: any = {
          select: jest.fn().mockReturnThis(),
          gte: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          range: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          or: jest.fn().mockReturnThis(),
          then: (resolve: any) => resolve({
            data: [{ id: 'notif-1', title: 'Hello' }],
            count: 1,
            error: null
          })
        };
        return chain;
      });

      const res = await request(app).get('/admin/notifications/sent?limit=10&offset=0');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return preference statistics', async () => {
      let callCount = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        const chain: any = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gte: jest.fn().mockReturnThis(),
          not: jest.fn().mockReturnThis(),
        };

        chain.then = (resolve: any) => {
          if (table === 'user_notification_preferences') {
            resolve({
              data: [
                { push_enabled: true, dnd_enabled: false },
                { push_enabled: false, dnd_enabled: true }
              ],
              error: null
            });
          } else if (table === 'user_notifications') {
            if (callCount === 0) {
              callCount++;
              resolve({ count: 10 });
            } else {
              resolve({ count: 5 });
            }
          }
        };

        return chain;
      });

      const res = await request(app).get('/admin/notifications/preferences/stats');

      expect(res.status).toBe(200);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.stats.push_disabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(10);
      expect(res.body.delivery.total_read_30d).toBe(5);
    });
  });
});