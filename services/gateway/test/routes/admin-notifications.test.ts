import express from 'express';
import request from 'supertest';

// Mock dependencies before importing the router
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, _res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  }),
}));

const mockSupabase = {
  from: jest.fn(),
};

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true }),
  notifyUsersAsync: jest.fn(),
}));

import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { requireAdmin } from '../../src/middleware/auth';

describe('Admin Notifications Router', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/admin/notifications', adminNotificationsRouter);
  });

  describe('POST /compose', () => {
    it('should use the requireAdmin middleware', async () => {
      await request(app).post('/admin/notifications/compose').send({ title: 'a', body: 'b', recipient_ids: ['1'] });
      expect(requireAdmin).toHaveBeenCalled();
    });

    it('should fail if title or body is missing', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['user-1'] });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should fail if no recipients are specified', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test Title', body: 'Test Body' });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should send notification to a single user successfully', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test Title', body: 'Test Body', recipient_ids: ['user-1'] });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
    });

    it('should return error if Supabase query fails for role lookup', async () => {
      const eqMock2 = jest.fn().mockResolvedValue({ data: null, error: { message: 'DB Error' } });
      const eqMock1 = jest.fn().mockReturnValue({ eq: eqMock2 });
      mockSupabase.from.mockReturnValue({
        select: jest.fn().mockReturnValue({ eq: eqMock1 }),
      });

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Body', recipient_role: 'user', tenant_id: 't1' });
      
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const rangeMock = jest.fn().mockResolvedValue({ data: [{ id: 1 }], count: 1, error: null });
      const orderMock = jest.fn().mockReturnValue({ range: rangeMock });
      const gteMock = jest.fn().mockReturnValue({ order: orderMock });
      mockSupabase.from.mockReturnValue({
        select: jest.fn().mockReturnValue({ gte: gteMock }),
      });

      const res = await request(app).get('/admin/notifications/sent');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return stats correctly', async () => {
      const mockGte = jest.fn();
      mockGte.mockReturnValueOnce(Promise.resolve({ count: 5 }));
      mockGte.mockReturnValueOnce({ not: jest.fn().mockResolvedValue({ count: 1 }) });

      mockSupabase.from.mockImplementation((table) => {
        if (table === 'user_notification_preferences') {
          return {
            select: jest.fn().mockResolvedValue({ data: [{ push_enabled: true }], error: null }),
          };
        }
        if (table === 'user_notifications') {
          return {
            select: jest.fn().mockReturnValue({ gte: mockGte }),
          };
        }
      });

      const res = await request(app).get('/admin/notifications/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(5);
    });
  });
});