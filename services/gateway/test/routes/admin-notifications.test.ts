import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

// Mock dependencies
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
  notifyUser: jest.fn().mockResolvedValue({ success: true }),
  notifyUsersAsync: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications Router', () => {
  let mockChain: any;
  let mockData: any[];
  let mockCount: number;
  let mockError: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockData = [];
    mockCount = 0;
    mockError = null;

    mockChain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      then: jest.fn((cb) => cb({ data: mockData, error: mockError, count: mockCount })),
    };

    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(mockChain),
    });
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body is missing', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['u1']
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/title and body are required/);
    });

    it('should return 400 if recipients are missing', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World'
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Must specify recipient_ids, recipient_role, or send_to_all/);
    });

    it('should send single notification synchronously', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World',
        recipient_ids: ['u1']
      });
      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalled();
      expect(notifyUsersAsync).not.toHaveBeenCalled();
    });

    it('should send multiple notifications asynchronously', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World',
        recipient_ids: ['u1', 'u2']
      });
      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalled();
    });

    it('should fetch users by role and send asynchronously', async () => {
      mockData = [{ user_id: 'u3' }, { user_id: 'u4' }];
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Role Alert',
        body: 'For all admins',
        recipient_role: 'admin',
        tenant_id: 't1'
      });
      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalled();
    });
  });

  describe('GET /sent', () => {
    it('should fetch sent notifications with pagination', async () => {
      mockData = [{ id: 'n1', title: 'Test Alert' }];
      mockCount = 1;
      const res = await request(app).get('/admin/notifications/sent').query({ limit: 10, offset: 0 });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it('should return 500 on database error', async () => {
      mockError = new Error('Database down');
      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Database down');
    });
  });

  describe('GET /preferences/stats', () => {
    it('should compute aggregate preference statistics', async () => {
      mockData = [
        { push_enabled: true, dnd_enabled: false },
        { push_enabled: false, dnd_enabled: true }
      ];
      mockCount = 2;
      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.stats.push_disabled).toBe(1);
      expect(res.body.stats.dnd_enabled).toBe(1);
    });
  });
});