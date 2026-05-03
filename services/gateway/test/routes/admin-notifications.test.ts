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
app.use('/admin/notifications', adminNotificationsRouter);

// Helper for Supabase query chaining
const createMockQuery = (resolvesTo: any) => {
  const query: any = Promise.resolve(resolvesTo);
  const methods = ['select', 'eq', 'or', 'not', 'gte', 'order', 'range'];
  methods.forEach(method => {
    query[method] = jest.fn().mockReturnValue(query);
  });
  return query;
};

describe('Admin Notifications Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body are missing', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['user-1'] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_INPUT');
    });

    it('should send notification to a single user successfully', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      (notifyUser as jest.Mock).mockResolvedValue({ id: 'notif-1' });

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          recipient_ids: ['user-1'],
          title: 'Hello',
          body: 'World',
          type: 'test_type',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.sent_to).toBe(1);
    });

    it('should send notification to multiple users successfully', async () => {
      const mockQuery = createMockQuery({ data: [{ user_id: 'user-1' }, { user_id: 'user-2' }], error: null });
      const mockSupabase = {
        from: jest.fn().mockReturnValue(mockQuery),
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          recipient_role: 'member',
          tenant_id: 'tenant-1',
          title: 'Hello',
          body: 'World',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalled();
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const mockQuery = createMockQuery({ data: [{ id: 'notif-1' }], error: null, count: 1 });
      const mockSupabase = {
        from: jest.fn().mockReturnValue(mockQuery),
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/sent');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return aggregate preference statistics', async () => {
      let notifCallCount = 0;
      
      const mockSupabase = {
        from: jest.fn((table) => {
          if (table === 'user_notification_preferences') {
            return createMockQuery({
              data: [
                { push_enabled: true, dnd_enabled: false },
                { push_enabled: false, dnd_enabled: true },
              ],
              error: null,
            });
          }
          if (table === 'user_notifications') {
            notifCallCount++;
            if (notifCallCount === 1) {
              return createMockQuery({ count: 10 });
            } else {
              return createMockQuery({ count: 5 });
            }
          }
          return createMockQuery({});
        }),
      };

      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/preferences/stats');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.stats.total_users_with_prefs).toBe(2);
      expect(response.body.delivery.total_sent_30d).toBe(10);
      expect(response.body.delivery.total_read_30d).toBe(5);
    });
  });
});