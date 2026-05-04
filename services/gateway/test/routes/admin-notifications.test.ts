import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    (req as any).user = { id: 'admin-id', email: 'admin@test.com' };
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

describe('Admin Notifications Router', () => {
  let mockSupabase: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis()
    };
    
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  describe('POST /compose', () => {
    it('should return 400 if title and body are missing', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('title and body are required');
    });

    it('should return 400 if no recipients specified', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World'
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Must specify recipient_ids, recipient_role, or send_to_all');
    });

    it('should send notification directly for a single recipient', async () => {
      (notifyUser as jest.Mock).mockResolvedValueOnce({ success: true });

      const res = await request(app).post('/admin/notifications/compose').send({
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
        { title: 'Hello', body: 'World', data: undefined },
        mockSupabase
      );
    });

    it('should send notifications async for multiple recipients', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World',
        recipient_ids: ['user-1', 'user-2']
      });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        '',
        'welcome_to_vitana',
        { title: 'Hello', body: 'World', data: undefined },
        mockSupabase
      );
    });
  });

  describe('GET /sent', () => {
    it('should fetch paginated sent notifications', async () => {
      mockSupabase.range.mockResolvedValueOnce({
        data: [{ id: 'notif-1' }],
        count: 1,
        error: null
      } as any);

      const res = await request(app).get('/admin/notifications/sent').query({ limit: 10 });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.limit).toBe(10);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return aggregate stats for notification preferences', async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'user_notification_preferences') {
          return {
            select: jest.fn().mockResolvedValue({
              data: [
                { push_enabled: true, live_room_notifications: true },
                { push_enabled: false, dnd_enabled: true }
              ],
              error: null
            })
          };
        }
        if (table === 'user_notifications') {
          const chain: any = {
            select: jest.fn().mockReturnThis(),
            gte: jest.fn().mockImplementation(() => {
              const promise = Promise.resolve({ count: 100 }) as any;
              promise.not = jest.fn().mockResolvedValue({ count: 80 });
              return promise;
            })
          };
          return chain;
        }
      });

      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(100);
      expect(res.body.delivery.total_read_30d).toBe(80);
      expect(res.body.delivery.read_rate).toBe(80);
    });
  });
});