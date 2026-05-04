import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

// Mock the shared requireAdmin middleware
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ message_id: '123' }),
  notifyUsersAsync: jest.fn()
}));

describe('Admin Notifications API', () => {
  let app: express.Application;
  let mockData: any = [];
  let mockError: any = null;
  let mockCount: number | null = null;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/admin/notifications', adminNotificationsRouter);

    mockData = [];
    mockError = null;
    mockCount = null;

    const chainObj = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      then: jest.fn((resolve) => Promise.resolve({ data: mockData, error: mockError, count: mockCount }).then(resolve))
    };

    const mockSupabase = {
      from: jest.fn(() => chainObj)
    };

    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should require title and body', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['u1'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should return 400 if no recipients found', async () => {
      mockData = [];
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Test body', send_to_all: true, tenant_id: 't1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NO_RECIPIENTS');
    });

    it('should return 400 if too many recipients found (>500)', async () => {
      mockData = Array(501).fill({ user_id: 'ux' });
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Test body', send_to_all: true, tenant_id: 't1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('TOO_MANY_RECIPIENTS');
    });

    it('should compose notification for a single user', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Test body', recipient_ids: ['u1'] });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(notifyUser).toHaveBeenCalledWith(
        'u1',
        '',
        'welcome_to_vitana',
        { title: 'Test', body: 'Test body', data: undefined },
        expect.anything()
      );
    });

    it('should dispatch async for multiple recipients via direct array', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Test body', recipient_ids: ['u1', 'u2'] });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalled();
    });

    it('should fetch and dispatch users by recipient_role', async () => {
      mockData = [{ user_id: 'u3' }, { user_id: 'u4' }];
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Test body', recipient_role: 'admin', tenant_id: 't1' });
      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalled();
    });

    it('should fetch and dispatch to all users in tenant', async () => {
      mockData = [{ user_id: 'u5' }];
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Test body', send_to_all: true, tenant_id: 't1' });
      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
    });

    it('returns 500 if Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B', recipient_ids: ['u1'] });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('SUPABASE_UNAVAILABLE');
    });
  });

  describe('GET /sent', () => {
    it('should fetch sent notifications', async () => {
      mockData = [{ id: 'n1', title: 'Test' }];
      mockCount = 1;
      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(mockData);
    });

    it('returns 500 if Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should fetch preference statistics', async () => {
      mockData = [{ push_enabled: true }, { push_enabled: false }];
      mockCount = 10;
      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.stats.push_disabled).toBe(1);
    });

    it('returns 500 if Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(500);
    });
  });
});