import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { requireAdmin } from '../../src/middleware/auth';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-123', email: 'admin@test.com' };
    next();
  })
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

describe('Admin Notifications Router', () => {
  let app: express.Application;
  let mockQueryObj: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockQueryObj = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      then: jest.fn((resolve) => resolve({ data: [], error: null }))
    };

    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn(() => mockQueryObj)
    });

    app = express();
    app.use(express.json());
    app.use('/admin-notifications', adminNotificationsRouter);
  });

  describe('POST /compose', () => {
    it('returns 400 if title or body is missing', async () => {
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({ recipient_ids: ['user-1'] });
        
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('sends to single user and returns 200', async () => {
      (notifyUser as jest.Mock).mockResolvedValueOnce({ success: true });
      
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['user-1']
        });
        
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
    });

    it('sends to role and returns 200', async () => {
      mockQueryObj.then = jest.fn((resolve) => resolve({ data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null }));

      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_role: 'admin',
          tenant_id: 't1'
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(['u1', 'u2'], 't1', 'welcome_to_vitana', expect.any(Object), expect.any(Object));
    });

    it('returns 500 if supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['user-1']
        });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('SUPABASE_UNAVAILABLE');
    });
  });

  describe('GET /sent', () => {
    it('returns 200 and data', async () => {
      mockQueryObj.then = jest.fn((resolve) => resolve({
        data: [{ id: 'notif-1' }],
        error: null,
        count: 1
      }));

      const res = await request(app).get('/admin-notifications/sent?limit=10&offset=0&days=30');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it('returns 500 on db error', async () => {
      mockQueryObj.then = jest.fn((resolve) => resolve({
        data: null,
        error: { message: 'DB_ERROR' },
        count: null
      }));

      const res = await request(app).get('/admin-notifications/sent');
      
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB_ERROR');
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns 200 and stats', async () => {
      mockQueryObj.then = jest.fn()
        .mockImplementationOnce((resolve: any) => resolve({
          data: [
            { push_enabled: true, dnd_enabled: false },
            { push_enabled: false, dnd_enabled: true }
          ],
          error: null
        }))
        .mockImplementationOnce((resolve: any) => resolve({ count: 10 }))
        .mockImplementationOnce((resolve: any) => resolve({ count: 5 }));

      const res = await request(app).get('/admin-notifications/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.delivery.total_sent_30d).toBe(10);
      expect(res.body.delivery.total_read_30d).toBe(5);
    });
  });
});