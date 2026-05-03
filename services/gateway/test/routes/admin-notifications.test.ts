import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
    (req as any).user = { id: 'admin-id', email: 'admin@test.com' };
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

const createChainable = (resolveValue: any) => {
  const chain: any = Promise.resolve(resolveValue);
  chain.select = jest.fn().mockReturnValue(chain);
  chain.eq = jest.fn().mockReturnValue(chain);
  chain.gte = jest.fn().mockReturnValue(chain);
  chain.order = jest.fn().mockReturnValue(chain);
  chain.range = jest.fn().mockReturnValue(chain);
  chain.or = jest.fn().mockReturnValue(chain);
  chain.not = jest.fn().mockReturnValue(chain);
  return chain;
};

describe('Admin Notifications Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();

    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(createChainable({ data: [], error: null }))
    });

    app = express();
    app.use(express.json());
    app.use('/admin/notifications', adminNotificationsRouter);
  });

  describe('POST /compose', () => {
    it('returns 400 if title or body is missing', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({ recipient_ids: ['user-1'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 if no recipient criteria provided', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({ title: 'Hello', body: 'World' });
      expect(res.status).toBe(400);
    });

    it('sends notification to specific users', async () => {
      (notifyUser as jest.Mock).mockResolvedValue({ id: 'notif-1' });

      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello', body: 'World', recipient_ids: ['user-1']
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(notifyUser).toHaveBeenCalled();
    });

    it('sends to multiple recipients async', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello', body: 'World', recipient_ids: ['user-1', 'user-2']
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(notifyUsersAsync).toHaveBeenCalled();
    });
  });

  describe('GET /sent', () => {
    it('returns sent notifications', async () => {
      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnValue(createChainable({
          data: [{ id: 'notif-1', title: 'Hello' }],
          count: 1,
          error: null
        }))
      });

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('handles supabase error', async () => {
      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnValue(createChainable({
          data: null,
          count: 0,
          error: { message: 'Database error' }
        }))
      });

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns preference statistics', async () => {
      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn().mockImplementation((table) => {
          if (table === 'user_notification_preferences') {
            return createChainable({ data: [{ push_enabled: true }], error: null });
          }
          return createChainable({ count: 10, error: null });
        })
      });

      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.stats.total_users_with_prefs).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(10);
    });
  });
});