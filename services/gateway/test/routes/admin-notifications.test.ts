import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

// Mock dependencies
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
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

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body is missing', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['u1'] });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should compose notification for a single user', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Hello', body: 'World', recipient_ids: ['u1'] });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(notifyUser).toHaveBeenCalledWith('u1', '', 'welcome_to_vitana', expect.any(Object), expect.any(Object));
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const mockQuery = {
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({ data: [{ id: '1' }], count: 1 }),
      };
      
      const mockSupabase = {
        from: jest.fn().mockReturnValue(mockQuery),
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/sent');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.length).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return preference stats', async () => {
      const mockSupabase = {
        from: jest.fn().mockImplementation((table) => {
          if (table === 'user_notification_preferences') {
            const mockSelect = {
              eq: jest.fn().mockReturnThis(),
              then: jest.fn((cb) => cb({ data: [{ push_enabled: true }] }))
            };
            return {
              select: jest.fn().mockReturnValue(mockSelect)
            };
          }
          if (table === 'user_notifications') {
            const queryChain: any = {
              select: jest.fn().mockReturnThis(),
              gte: jest.fn().mockReturnThis(),
              not: jest.fn().mockReturnThis(),
              then: jest.fn((cb) => cb({ count: 10 }))
            };
            queryChain.not = jest.fn().mockReturnValue({
              then: jest.fn((cb: any) => cb({ count: 5 }))
            });
            return queryChain;
          }
        }),
      };

      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.push_enabled).toBe(1);
    });
  });
});