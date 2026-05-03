import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import * as supabaseLib from '../../src/lib/supabase';
import * as notificationService from '../../src/services/notification-service';

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  }),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body is missing', async () => {
      (supabaseLib.getSupabase as jest.Mock).mockReturnValue({});
      const res = await request(app).post('/admin/notifications/compose').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should successfully dispatch notification to specific users', async () => {
      const mockSupabase = {};
      (supabaseLib.getSupabase as jest.Mock).mockReturnValue(mockSupabase);
      (notificationService.notifyUser as jest.Mock).mockResolvedValue(true);

      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['user-1'],
        title: 'Hello',
        body: 'World',
      });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
      expect(notificationService.notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        expect.any(Object),
        mockSupabase
      );
    });

    it('should return 500 if supabase is unavailable', async () => {
      (supabaseLib.getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['user-1'],
        title: 'Hello',
        body: 'World',
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('SUPABASE_UNAVAILABLE');
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
        error: null,
      });

      const mockSupabase = {
        from: jest.fn().mockReturnValue({
          select: mockSelect,
          gte: mockGte,
          order: mockOrder,
          range: mockRange,
        }),
      };

      (supabaseLib.getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should fetch preference stats', async () => {
      const mockSupabase = {
        from: jest.fn((table) => {
          if (table === 'user_notification_preferences') {
            return {
              select: jest.fn().mockResolvedValue({
                data: [{ push_enabled: true }, { push_enabled: false }],
                error: null,
              }),
            };
          }
          if (table === 'user_notifications') {
            return {
              select: jest.fn().mockReturnThis(),
              gte: jest.fn().mockImplementation(() => {
                const chain = {
                  not: jest.fn().mockResolvedValue({ count: 3 }),
                };
                (chain as any).then = (resolve: any) => resolve({ count: 10 });
                return chain;
              }),
            };
          }
          return { select: jest.fn() };
        }),
      };

      (supabaseLib.getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.delivery.total_sent_30d).toBe(10);
      expect(res.body.delivery.total_read_30d).toBe(3);
    });
  });
});