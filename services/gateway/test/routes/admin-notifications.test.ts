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

describe('Admin Notifications Router', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/admin/notifications', adminNotificationsRouter);
  });

  const createMockSupabase = () => {
    return {
      from: jest.fn().mockImplementation((table) => {
        const chain = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          or: jest.fn().mockReturnThis(),
          gte: jest.fn().mockReturnThis(),
          not: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          range: jest.fn().mockReturnThis()
        };
        (chain as any).then = function (resolve: any) {
          if (table === 'user_notification_preferences') {
            resolve({ data: [{ push_enabled: true }, { push_enabled: false }], error: null });
          } else if (table === 'user_notifications') {
            resolve({ data: [{ id: 'notif-1' }], count: 5, error: null });
          } else if (table === 'user_tenants') {
            resolve({ data: [{ user_id: 'user1' }, { user_id: 'user2' }], error: null });
          }
        };
        return chain;
      })
    };
  };

  describe('POST /compose', () => {
    it('should fail if missing title or body', async () => {
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['user1'] });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_INPUT');
    });

    it('should fail if no recipients specified', async () => {
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Hello', body: 'World' });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_INPUT');
    });

    it('should compose notification for a single recipient', async () => {
      const mockSupabase = createMockSupabase();
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
      (notifyUser as jest.Mock).mockResolvedValue({ id: 'notif-1' });

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['user1']
        });
      
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith('user1', '', 'welcome_to_vitana', expect.any(Object), mockSupabase);
    });

    it('should compose notification for multiple recipients', async () => {
      const mockSupabase = createMockSupabase();
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_role: 'member',
          tenant_id: 'tenant-1'
        });
      
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(['user1', 'user2'], 'tenant-1', 'welcome_to_vitana', expect.any(Object), mockSupabase);
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const mockSupabase = createMockSupabase();
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/sent');
      
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data).toEqual([{ id: 'notif-1' }]);
      expect(response.body.total).toBe(5);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return preference stats', async () => {
      const mockSupabase = createMockSupabase();
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/preferences/stats');
      
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.stats.total_users_with_prefs).toBe(2);
      expect(response.body.stats.push_enabled).toBe(1);
      expect(response.body.stats.push_disabled).toBe(1);
    });
  });
});