import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

// Mock dependencies
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('returns 400 if title or body is missing', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['user1'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns 400 if no recipients specified', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns 500 if Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B', recipient_ids: ['u1'] });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('SUPABASE_UNAVAILABLE');
    });

    it('successfully dispatches a notification to one user', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B', recipient_ids: ['u1'] });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'u1',
        '',
        'welcome_to_vitana',
        { title: 'T', body: 'B', data: undefined },
        {}
      );
    });

    it('successfully dispatches notifications to multiple users', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B', recipient_ids: ['u1', 'u2'] });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['u1', 'u2'],
        '',
        'welcome_to_vitana',
        { title: 'T', body: 'B', data: undefined },
        {}
      );
    });
  });

  describe('GET /sent', () => {
    it('returns sent notifications', async () => {
      const mockQuery = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        then: jest.fn(cb => cb({ data: [{ id: 'n1' }], count: 1, error: null }))
      };

      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnValue(mockQuery)
      });

      const res = await request(app)
        .get('/admin/notifications/sent')
        .query({ type: 'test', user_id: 'u1', search: 'hello' });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it('handles query errors gracefully', async () => {
      const mockQuery = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        then: jest.fn(cb => cb({ data: null, count: null, error: { message: 'db error' } }))
      };

      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnValue(mockQuery)
      });

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('db error');
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns valid preference stats', async () => {
      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn((table) => {
          if (table === 'user_notification_preferences') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              then: jest.fn(cb => cb({
                data: [
                  { push_enabled: true, dnd_enabled: false },
                  { push_enabled: false, dnd_enabled: true }
                ],
                error: null
              }))
            };
          }
          if (table === 'user_notifications') {
            return {
              select: jest.fn().mockReturnThis(),
              gte: jest.fn().mockReturnThis(),
              not: jest.fn().mockReturnThis(),
              then: jest.fn(cb => cb({ count: 10, error: null }))
            };
          }
        })
      });

      const res = await request(app).get('/admin/notifications/preferences/stats').query({ tenant_id: 't1' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.stats.push_disabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(10);
      expect(res.body.delivery.total_read_30d).toBe(10);
      expect(res.body.delivery.read_rate).toBe(100);
    });
  });
});