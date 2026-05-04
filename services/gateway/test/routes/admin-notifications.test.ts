import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

// Mock middleware
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

describe('Admin Notifications Routes', () => {
  let app: express.Express;
  let mockSupabase: any;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/admin/notifications', adminNotificationsRouter);

    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
    };
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  describe('POST /compose', () => {
    it('requires valid input', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('sends notification to specific recipient', async () => {
      (notifyUser as jest.Mock).mockResolvedValueOnce(true);

      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_ids: ['user-1'],
        title: 'Test',
        body: 'Test body',
      });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        expect.objectContaining({ title: 'Test', body: 'Test body' }),
        mockSupabase
      );
    });

    it('sends to multiple users', async () => {
      mockSupabase.from.mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValueOnce({
          data: [{ user_id: 'user-2' }, { user_id: 'user-3' }],
          error: null,
        }),
      });

      const res = await request(app).post('/admin/notifications/compose').send({
        recipient_role: 'community',
        tenant_id: 'tenant-1',
        title: 'Test',
        body: 'Test body',
      });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalled();
    });
  });

  describe('GET /sent', () => {
    it('returns sent notifications', async () => {
      mockSupabase.range.mockResolvedValueOnce({
        data: [{ id: 'notif-1' }],
        count: 1,
        error: null,
      });

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns preference stats', async () => {
      // Mock preferences
      mockSupabase.select.mockResolvedValueOnce({
        data: [{ push_enabled: true }, { push_enabled: false }],
        error: null,
      });

      // Mock count 1
      mockSupabase.gte.mockResolvedValueOnce({ count: 10, error: null });
      // Mock count 2
      mockSupabase.not.mockResolvedValueOnce({ count: 5, error: null });

      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(10);
      expect(res.body.delivery.read_rate).toBe(50);
    });
  });
});