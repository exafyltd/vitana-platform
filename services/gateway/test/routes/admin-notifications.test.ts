import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';

// Mock the shared requireAdmin middleware to simulate an authenticated admin user
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-1', email: 'admin@test.com' };
    next();
  })
}));

// Mock Supabase
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

// Mock Notification Service
jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

const { getSupabase } = require('../../src/lib/supabase');
const { notifyUser, notifyUsersAsync } = require('../../src/services/notification-service');

describe('Admin Notifications Router', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/admin/notifications', adminNotificationsRouter);
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body is missing', async () => {
      getSupabase.mockReturnValue({});
      
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['user-1'] });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should return 400 if no recipients specified', async () => {
      getSupabase.mockReturnValue({});
      
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Test body' });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should send notification to specific users', async () => {
      getSupabase.mockReturnValue({});
      notifyUser.mockResolvedValue(true);

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Test',
          body: 'Test body',
          recipient_ids: ['user-1']
        });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(notifyUser).toHaveBeenCalled();
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({ data: [{ id: 1 }], count: 1 })
      };
      getSupabase.mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/sent');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return aggregate stats', async () => {
      const mockSupabase = {
        from: jest.fn().mockImplementation((table) => {
          if (table === 'user_notification_preferences') {
            return {
              select: jest.fn().mockResolvedValue({
                data: [{ push_enabled: true }, { push_enabled: false }]
              })
            };
          }
          if (table === 'user_notifications') {
            return {
              select: jest.fn().mockReturnThis(),
              gte: jest.fn().mockImplementation(() => {
                const p: any = Promise.resolve({ count: 10 });
                p.not = jest.fn().mockResolvedValue({ count: 5 });
                return p;
              })
            };
          }
        })
      };
      getSupabase.mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin/notifications/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.push_enabled).toBe(1);
    });
  });
});