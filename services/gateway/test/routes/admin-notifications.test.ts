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
  }),
}));

// Mock Supabase
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

// Mock Notification Service
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
    it('returns 400 if title and body are missing', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['user-1'],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns 400 if no recipients specified', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('sends notification to single user', async () => {
      (notifyUser as jest.Mock).mockResolvedValue(true);
      const mockSupabase = {
        from: jest.fn(),
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World',
        recipient_ids: ['user-1'],
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

    it('fetches users by role and sends to multiple async', async () => {
      const mockQuery: any = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
      };
      mockQuery.then = jest.fn((resolve) => resolve({ data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null }));

      const mockSupabase = {
        from: jest.fn().mockReturnValue(mockQuery),
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Title',
        body: 'Body',
        recipient_role: 'community',
        tenant_id: 't1',
      });

      expect(res.status).toBe(200);
      expect(mockSupabase.from).toHaveBeenCalledWith('user_tenants');
      expect(mockQuery.eq).toHaveBeenCalledWith('tenant_id', 't1');
      expect(mockQuery.eq).toHaveBeenCalledWith('active_role', 'community');
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['u1', 'u2'],
        't1',
        'welcome_to_vitana',
        { title: 'Title', body: 'Body', data: undefined },
        mockSupabase
      );
    });
  });

  describe('GET /sent', () => {
    it('returns sent notifications', async () => {
      const mockQuery: any = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
      };
      mockQuery.then = jest.fn((resolve) => resolve({ data: [{ id: 'n1' }], count: 1, error: null }));

      const mockSupabase = {
        from: jest.fn().mockReturnValue(mockQuery),
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/sent').query({ limit: 10, offset: 0, days: 7 });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns stats', async () => {
      const mockSupabase = {
        from: jest.fn((table) => {
          const query: any = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            gte: jest.fn().mockReturnThis(),
            not: jest.fn().mockReturnThis(),
          };
          if (table === 'user_notification_preferences') {
            query.then = jest.fn((resolve: any) => resolve({
              data: [
                { push_enabled: true, dnd_enabled: false },
                { push_enabled: false, dnd_enabled: true },
              ],
              error: null,
            }));
          } else if (table === 'user_notifications') {
            query.then = jest.fn((resolve: any) => {
              if (query.not.mock.calls.length > 0) {
                resolve({ count: 5 });
              } else {
                resolve({ count: 10 });
              }
            });
          }
          return query;
        })
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/preferences/stats').query({ tenant_id: 't1' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.delivery.total_sent_30d).toBe(10);
      expect(res.body.delivery.total_read_30d).toBe(5);
    });
  });
});