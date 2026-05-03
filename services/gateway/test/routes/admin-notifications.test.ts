import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

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
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      then: jest.fn((resolve) => resolve({ data: [], count: 0, error: null }))
    };
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  describe('POST /compose', () => {
    it('returns 400 if title or body is missing', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['user-1'],
        title: 'Hello',
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('title and body are required');
    });

    it('returns 400 if no recipients specified', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World',
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Must specify recipient_ids/);
    });

    it('sends to a single user synchronously', async () => {
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });
      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['user-1'],
        title: 'Hello',
        body: 'World',
      });
      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        expect.any(Object),
        mockSupabase
      );
    });

    it('sends to multiple users asynchronously', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['user-1', 'user-2'],
        title: 'Hello',
        body: 'World',
      });
      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        '',
        'welcome_to_vitana',
        expect.any(Object),
        mockSupabase
      );
    });
  });

  describe('GET /sent', () => {
    it('returns sent notifications', async () => {
      mockSupabase.then = jest.fn((resolve) => resolve({
        data: [{ id: 'notif-1' }],
        count: 1,
        error: null
      }));

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns preferences stats', async () => {
      mockSupabase.then = jest.fn((resolve) => resolve({
        data: [{ push_enabled: true, dnd_enabled: false }],
        count: 10,
        error: null
      }));

      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(10);
      expect(res.body.delivery.total_read_30d).toBe(10);
    });
  });
});