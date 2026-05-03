import request from 'supertest';
import express from 'express';

// Mock the requireAdmin middleware BEFORE importing the router
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
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

const app = express();
app.use(express.json());
app.use('/admin-notifications', adminNotificationsRouter);

describe('Admin Notifications Router', () => {
  const mockGetSupabase = getSupabase as jest.Mock;
  const mockNotifyUser = notifyUser as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createChainableMock = (resolvedValue: any) => {
    const chain: any = {
      select: jest.fn(() => chain),
      gte: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      not: jest.fn(() => chain),
      order: jest.fn(() => chain),
      range: jest.fn(() => chain),
      or: jest.fn(() => chain),
      then: (resolve: any) => resolve(resolvedValue),
    };
    return chain;
  };

  describe('POST /compose', () => {
    it('should send notification to a specific user', async () => {
      const mockSupabase = {};
      mockGetSupabase.mockReturnValue(mockSupabase);
      mockNotifyUser.mockResolvedValue({ ok: true });

      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          title: 'Test',
          body: 'Test body',
          recipient_ids: ['user-1']
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockNotifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        { title: 'Test', body: 'Test body', data: undefined },
        mockSupabase
      );
    });

    it('should return 400 if title or body is missing', async () => {
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          recipient_ids: ['user-1']
        });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toBe('title and body are required');
    });
  });

  describe('GET /sent', () => {
    it('should return a list of sent notifications', async () => {
      const mockSupabase = {
        from: jest.fn().mockReturnValue(createChainableMock({
          data: [{ id: 1, title: 'Notification 1' }],
          count: 1,
          error: null
        }))
      };
      mockGetSupabase.mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin-notifications/sent');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return aggregate stats', async () => {
      const mockSupabase = {
        from: jest.fn((table: string) => {
          if (table === 'user_notification_preferences') {
            return createChainableMock({ data: [{ push_enabled: true }], error: null });
          }
          if (table === 'user_notifications') {
            return createChainableMock({ count: 10, error: null });
          }
          return createChainableMock({});
        })
      };
      mockGetSupabase.mockReturnValue(mockSupabase);

      const res = await request(app).get('/admin-notifications/preferences/stats');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(10);
    });
  });
});