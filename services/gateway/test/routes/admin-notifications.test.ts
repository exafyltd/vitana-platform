import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    (req as any).user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications Routes', () => {
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
      then: jest.fn((resolve) => resolve({ data: [], error: null, count: 0 }))
    };
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  describe('POST /compose', () => {
    it('returns 400 if title or body is missing', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['user1']
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns 400 if no recipient criteria is provided', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World'
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('sends notification to single user', async () => {
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World',
        recipient_ids: ['user1']
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(notifyUser).toHaveBeenCalledWith(
        'user1',
        '',
        'welcome_to_vitana',
        { title: 'Hello', body: 'World', data: undefined },
        mockSupabase
      );
    });

    it('sends notification to multiple users via role', async () => {
      mockSupabase.then = jest.fn((resolve) => resolve({
        data: [{ user_id: 'user1' }, { user_id: 'user2' }],
        error: null
      }));

      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World',
        recipient_role: 'member',
        tenant_id: 't1'
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user1', 'user2'],
        't1',
        'welcome_to_vitana',
        { title: 'Hello', body: 'World', data: undefined },
        mockSupabase
      );
    });
  });

  describe('GET /sent', () => {
    it('returns sent notifications', async () => {
      mockSupabase.then = jest.fn((resolve) => resolve({
        data: [{ id: 'notif1' }],
        count: 1,
        error: null
      }));

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toEqual([{ id: 'notif1' }]);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns preferences stats', async () => {
      mockSupabase.then = jest.fn()
        .mockImplementationOnce((resolve) => resolve({
          data: [{ push_enabled: true }, { push_enabled: false }],
          error: null
        }))
        .mockImplementationOnce((resolve) => resolve({ count: 10, error: null }))
        .mockImplementationOnce((resolve) => resolve({ count: 5, error: null }));
      
      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.delivery.total_sent_30d).toBe(10);
      expect(res.body.delivery.total_read_30d).toBe(5);
    });
  });
});