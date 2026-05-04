import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, _res, next) => {
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

describe('Admin Notifications Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body is missing', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['user-1']
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should compose a notification for a single user', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Test Notification',
        body: 'Test Body',
        recipient_ids: ['user-1']
      });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalled();
    });
    
    it('should handle dispatching to multiple users', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Test Notification',
        body: 'Test Body',
        recipient_ids: ['user-1', 'user-2']
      });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalled();
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const mockQuery = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({ data: [{ id: 1 }], count: 1, error: null }),
        eq: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
      };
      const mockSupabase = {
        from: jest.fn().mockReturnValue(mockQuery)
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return preferences stats', async () => {
      const mockSupabase = {
        from: jest.fn().mockImplementation((table) => {
          if (table === 'user_notification_preferences') {
            return {
              select: jest.fn().mockReturnValue(Promise.resolve({ data: [{ push_enabled: true }], error: null }))
            };
          }
          if (table === 'user_notifications') {
            return {
              select: jest.fn().mockReturnValue({
                gte: jest.fn().mockImplementation(() => {
                  const gteChain: any = Promise.resolve({ count: 10, error: null });
                  gteChain.not = jest.fn().mockResolvedValue({ count: 5, error: null });
                  return gteChain;
                })
              })
            };
          }
        })
      };

      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.push_enabled).toBe(1);
    });
  });
});