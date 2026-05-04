import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

// Mock middleware
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

// Mock services
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));
jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin-notifications', adminNotificationsRouter);

describe('Admin Notifications Route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('returns 400 for missing title or body', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});

      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({ recipient_ids: ['user1'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns 400 for missing recipient info', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});

      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({ title: 'Test Title', body: 'Test Body' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('dispatches to a single user synchronously', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          title: 'Test',
          body: 'Test Body',
          recipient_ids: ['user1']
        });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'user1',
        '',
        'welcome_to_vitana',
        expect.objectContaining({ title: 'Test', body: 'Test Body' }),
        expect.anything()
      );
    });

    it('dispatches to multiple users asynchronously', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          title: 'Test',
          body: 'Test Body',
          recipient_ids: ['user1', 'user2']
        });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user1', 'user2'],
        '',
        'welcome_to_vitana',
        expect.objectContaining({ title: 'Test', body: 'Test Body' }),
        expect.anything()
      );
    });
  });

  describe('GET /sent', () => {
    it('returns 500 if Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).get('/admin-notifications/sent');
      expect(res.status).toBe(500);
    });

    it('returns fetched notifications', async () => {
      const mockChain = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({
          data: [{ id: 'notif-1' }],
          count: 1,
          error: null
        })
      };

      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnValue(mockChain)
      });

      const res = await request(app).get('/admin-notifications/sent?limit=10&offset=0');
      
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns calculated statistics', async () => {
      let isFirstNotificationsCall = true;

      const mockSupabase = {
        from: jest.fn((table) => {
          if (table === 'user_notification_preferences') {
            return {
              select: jest.fn().mockResolvedValue({
                data: [
                  { push_enabled: true },
                  { push_enabled: false },
                  { push_enabled: true, dnd_enabled: true }
                ],
                error: null
              })
            };
          }
          if (table === 'user_notifications') {
            const chain: any = {
              select: jest.fn().mockReturnThis(),
              gte: jest.fn().mockReturnThis(),
              not: jest.fn().mockReturnThis()
            };
            chain.then = (resolve: any) => {
              if (isFirstNotificationsCall) {
                isFirstNotificationsCall = false;
                resolve({ count: 100 });
              } else {
                resolve({ count: 45 });
              }
            };
            return chain;
          }
        })
      };

      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin-notifications/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.stats.push_enabled).toBe(2);
      expect(res.body.stats.push_disabled).toBe(1);
      expect(res.body.stats.dnd_enabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(100);
      expect(res.body.delivery.total_read_30d).toBe(45);
      expect(res.body.delivery.read_rate).toBe(45);
    });
  });
});