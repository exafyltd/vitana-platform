import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn(),
}));

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  }),
}));

const app = express();
app.use(express.json());
app.use('/admin-notifications', adminNotificationsRouter);

describe('Admin Notifications Routes', () => {
  let mockQuery: any;
  let mockSupabase: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      then: jest.fn((resolve) => resolve({ data: [], error: null })),
    };

    mockSupabase = {
      from: jest.fn().mockReturnValue(mockQuery),
    };

    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  describe('POST /compose', () => {
    it('returns 400 if title or body is missing', async () => {
      const response = await request(app)
        .post('/admin-notifications/compose')
        .send({ recipient_ids: ['user-1'] });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
    });

    it('returns 400 if no recipients specified', async () => {
      const response = await request(app)
        .post('/admin-notifications/compose')
        .send({ title: 'Hello', body: 'World' });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
    });

    it('sends notification to single user', async () => {
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/admin-notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['user-1'],
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        { title: 'Hello', body: 'World', data: undefined },
        mockSupabase
      );
    });

    it('sends notification to role', async () => {
      mockQuery.then.mockImplementation((resolve: any) => resolve({
        data: [{ user_id: 'user-2' }, { user_id: 'user-3' }],
        error: null,
      }));

      const response = await request(app)
        .post('/admin-notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_role: 'member',
          tenant_id: 'tenant-1',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user-2', 'user-3'],
        'tenant-1',
        'welcome_to_vitana',
        { title: 'Hello', body: 'World', data: undefined },
        mockSupabase
      );
    });
  });

  describe('GET /sent', () => {
    it('fetches sent notifications', async () => {
      mockQuery.then.mockImplementation((resolve: any) => resolve({
        data: [{ id: 'notif-1' }],
        count: 1,
        error: null,
      }));

      const response = await request(app).get('/admin-notifications/sent');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('fetches preference stats', async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        const mq = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gte: jest.fn().mockReturnThis(),
          not: jest.fn().mockReturnThis(),
          then: jest.fn(),
        };
        if (table === 'user_notification_preferences') {
          mq.then.mockImplementation((resolve: any) => resolve({
            data: [
              { push_enabled: true, live_room_notifications: true },
              { push_enabled: false, live_room_notifications: false },
            ],
            error: null,
          }));
        } else {
          mq.then.mockImplementation((resolve: any) => resolve({
            count: 10,
            error: null,
          }));
        }
        return mq;
      });

      const response = await request(app).get('/admin-notifications/preferences/stats');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.stats.total_users_with_prefs).toBe(2);
      expect(response.body.stats.push_enabled).toBe(1);
      expect(response.body.delivery.total_sent_30d).toBe(10);
    });
  });
});