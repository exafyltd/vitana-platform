import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
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
  requireAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
    (req as any).user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('requires title and body', async () => {
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['u1'] });
      
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('title and body are required');
    });

    it('requires recipients', async () => {
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Hello', body: 'World' });
      
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Must specify recipient_ids, recipient_role, or send_to_all');
    });

    it('sends to single recipient synchronously', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Hello', body: 'World', recipient_ids: ['u1'] });
      
      expect(response.status).toBe(200);
      expect(response.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith('u1', '', 'welcome_to_vitana', { title: 'Hello', body: 'World', data: undefined }, expect.anything());
    });

    it('sends to multiple recipients via role asynchronously', async () => {
      const mockSupabase = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [{ user_id: 'u1' }, { user_id: 'u2' }],
                error: null
              })
            })
          })
        })
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Hello', body: 'World', recipient_role: 'admin', tenant_id: 't1' });
      
      expect(response.status).toBe(200);
      expect(response.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(['u1', 'u2'], 't1', 'welcome_to_vitana', { title: 'Hello', body: 'World', data: undefined }, expect.anything());
    });
  });

  describe('GET /sent', () => {
    it('returns sent notifications', async () => {
      const mockSupabase = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            gte: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({
                range: jest.fn().mockResolvedValue({ data: [{ id: 1 }], count: 1, error: null })
              })
            })
          })
        })
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/sent');
      
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([{ id: 1 }]);
      expect(response.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns preference stats', async () => {
      const mockSupabase = {
        from: jest.fn().mockImplementation((table) => {
          if (table === 'user_notification_preferences') {
            return {
              select: jest.fn().mockResolvedValue({ data: [{ push_enabled: true }], error: null })
            };
          }
          if (table === 'user_notifications') {
            const queryBuilder: any = {
              then: (resolve: any) => resolve({ count: 10 }),
              not: jest.fn().mockResolvedValue({ count: 5 })
            };
            return {
              select: jest.fn().mockReturnValue({
                gte: jest.fn().mockReturnValue(queryBuilder)
              })
            };
          }
        })
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/preferences/stats');
      
      expect(response.status).toBe(200);
      expect(response.body.stats.total_users_with_prefs).toBe(1);
      expect(response.body.delivery.total_sent_30d).toBe(10);
      expect(response.body.delivery.total_read_30d).toBe(5);
    });
  });
});