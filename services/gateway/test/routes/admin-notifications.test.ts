import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

// Mock the auth middleware
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

// Mock Supabase
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

// Mock Notification Service
jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin-notifications', adminNotificationsRouter);

describe('Admin Notifications Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should require title and body', async () => {
      const mockSupabase = {
        from: jest.fn()
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app)
        .post('/admin-notifications/compose')
        .send({
          recipient_ids: ['user-1']
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('INVALID_INPUT');
    });

    it('should call notifyUser for a single recipient', async () => {
      const mockSupabase = {
        from: jest.fn()
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/admin-notifications/compose')
        .send({
          recipient_ids: ['user-1'],
          title: 'Hello',
          body: 'World'
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        { title: 'Hello', body: 'World', data: undefined },
        mockSupabase
      );
    });

    it('should call notifyUsersAsync for multiple recipients', async () => {
      const mockSupabase = {
        from: jest.fn()
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app)
        .post('/admin-notifications/compose')
        .send({
          recipient_ids: ['user-1', 'user-2'],
          title: 'Hello',
          body: 'World'
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
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
    it('should fetch sent notifications', async () => {
      const mockSelect = jest.fn().mockReturnThis();
      const mockGte = jest.fn().mockReturnThis();
      const mockOrder = jest.fn().mockReturnThis();
      const mockRange = jest.fn().mockResolvedValue({
        data: [{ id: 'notif-1' }],
        count: 1,
        error: null
      });

      const mockSupabase = {
        from: jest.fn().mockReturnValue({
          select: mockSelect,
          gte: mockGte,
          order: mockOrder,
          range: mockRange
        })
      };

      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin-notifications/sent');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(mockSupabase.from).toHaveBeenCalledWith('user_notifications');
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return preference stats', async () => {
      const mockSupabase = {
        from: jest.fn().mockImplementation((table) => {
          if (table === 'user_notification_preferences') {
            return {
              select: jest.fn().mockResolvedValue({
                data: [
                  { push_enabled: true },
                  { push_enabled: false }
                ],
                error: null
              })
            };
          }
          if (table === 'user_notifications') {
            return {
              select: jest.fn().mockReturnThis(),
              gte: jest.fn().mockReturnValue(
                Object.assign(Promise.resolve({ count: 10 }), {
                  not: jest.fn().mockResolvedValue({ count: 5 })
                })
              )
            };
          }
        })
      };

      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin-notifications/preferences/stats');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.stats.total_users_with_prefs).toBe(2);
    });
  });
});