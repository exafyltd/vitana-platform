import request from 'supertest';
import express from 'express';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';
import adminNotificationsRouter from '../../src/routes/admin-notifications';

// Mock the standard admin auth middleware
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, _res, next) => {
    // Populate user object to simulate authorized admin state
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
    it('should return 400 if title and body are missing', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['user-1']
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should compose notification for a single user synchronously', async () => {
      const mockSupabase = {};
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Test Title',
        body: 'Test Body',
        recipient_ids: ['user-1']
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        { title: 'Test Title', body: 'Test Body', data: undefined },
        mockSupabase
      );
    });

    it('should use notifyUsersAsync for multiple recipients', async () => {
      const mockSupabase = {};
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Test Title',
        body: 'Test Body',
        recipient_ids: ['user-1', 'user-2']
      });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        '',
        'welcome_to_vitana',
        { title: 'Test Title', body: 'Test Body', data: undefined },
        mockSupabase
      );
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications properly mapped from Supabase', async () => {
      const mockQuery = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({ data: [{ id: 1, title: 'Sent' }], count: 1, error: null })
      };
      const mockSupabase = {
        from: jest.fn().mockReturnValue(mockQuery)
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/sent?limit=10&offset=0');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toEqual([{ id: 1, title: 'Sent' }]);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should aggregate push notification stats', async () => {
      const mockSupabase = {
        from: jest.fn().mockImplementation((table) => {
          if (table === 'user_notification_preferences') {
            return {
              select: jest.fn().mockResolvedValue({
                data: [
                  { push_enabled: true, dnd_enabled: false },
                  { push_enabled: false, dnd_enabled: true }
                ],
                error: null
              })
            };
          }
          if (table === 'user_notifications') {
            const mQuery = {
              select: jest.fn().mockReturnThis(),
              gte: jest.fn().mockReturnThis(),
              not: jest.fn().mockResolvedValue({ count: 1 }), // readCount mock
              then: jest.fn((resolve) => resolve({ count: 2 })) // notificationCount mock
            };
            return mQuery;
          }
          return { select: jest.fn().mockReturnThis() };
        })
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.stats.push_disabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(2);
      expect(res.body.delivery.total_read_30d).toBe(1);
      expect(res.body.delivery.read_rate).toBe(50);
    });
  });
});