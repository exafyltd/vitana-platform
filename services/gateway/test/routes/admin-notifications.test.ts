import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import * as supabaseLib from '../../src/lib/supabase';
import * as notificationService from '../../src/services/notification-service';

// Mock requireAdmin middleware
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    (req as any).user = { id: 'admin-id', email: 'admin@test.com' };
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

describe('Admin Notifications Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/admin/notifications', adminNotificationsRouter);
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should return 400 if title and body are missing', async () => {
      (supabaseLib.getSupabase as jest.Mock).mockReturnValue({});

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.message).toBe('title and body are required');
    });

    it('should return 400 if recipient criteria is missing', async () => {
      (supabaseLib.getSupabase as jest.Mock).mockReturnValue({});

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test Title', body: 'Test Body' });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.message).toBe('Must specify recipient_ids, recipient_role, or send_to_all');
    });

    it('should compose notification for a single user', async () => {
      (supabaseLib.getSupabase as jest.Mock).mockReturnValue({});
      (notificationService.notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Test Title',
          body: 'Test Body',
          recipient_ids: ['user-1']
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.sent_to).toBe(1);
      expect(notificationService.notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        expect.objectContaining({ title: 'Test Title', body: 'Test Body' }),
        expect.any(Object)
      );
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({
          data: [{ id: 'notif-1' }],
          error: null,
          count: 1
        })
      };

      (supabaseLib.getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/sent');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data).toEqual([{ id: 'notif-1' }]);
      expect(response.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return preferences statistics', async () => {
      const mockSupabase = {
        from: jest.fn().mockImplementation((table) => {
          if (table === 'user_notification_preferences') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              then: (cb: any) => cb({
                data: [{ push_enabled: true }],
                error: null
              })
            };
          }
          if (table === 'user_notifications') {
            const mockChain = {
              select: jest.fn().mockReturnThis(),
              gte: jest.fn().mockReturnThis(),
              not: jest.fn().mockReturnThis(),
              then: (cb: any) => cb({ count: 10 })
            };
            return mockChain;
          }
          return {};
        })
      };

      (supabaseLib.getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/preferences/stats');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.stats).toBeDefined();
      expect(response.body.stats.push_enabled).toBe(1);
      expect(response.body.delivery.total_sent_30d).toBe(10);
    });
  });
});