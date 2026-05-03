import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-123', email: 'admin@exafy.com' };
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

const createChainableMock = (resolvedValue: any) => {
  const chainable: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    then: (resolve: any) => resolve(resolvedValue)
  };
  return chainable;
};

describe('Admin Notifications Route', () => {
  let app: express.Application;
  let mockSupabase: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSupabase = {
      from: jest.fn().mockImplementation(() => createChainableMock({ data: [], count: 0, error: null }))
    };

    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

    app = express();
    app.use(express.json());
    app.use('/admin/notifications', adminNotificationsRouter);
  });

  describe('POST /compose', () => {
    it('returns 400 if title or body is missing', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('returns 400 if no recipient specified', async () => {
      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World'
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Must specify recipient/);
    });

    it('sends notification to specific recipient_ids', async () => {
      (notifyUser as jest.Mock).mockResolvedValueOnce({ ok: true });

      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World',
        recipient_ids: ['user-1']
      });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        { title: 'Hello', body: 'World', data: undefined },
        mockSupabase
      );
    });
    
    it('sends to multiple recipients via role', async () => {
      mockSupabase.from.mockImplementation(() => createChainableMock({
        data: [{ user_id: 'user-2' }, { user_id: 'user-3' }],
        error: null
      }));

      const res = await request(app).post('/admin/notifications/compose').send({
        title: 'Hello',
        body: 'World',
        recipient_role: 'admin',
        tenant_id: 'tenant-1'
      });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalled();
    });
  });

  describe('GET /sent', () => {
    it('fetches sent notifications', async () => {
      mockSupabase.from.mockImplementation(() => createChainableMock({
        data: [{ id: 1 }],
        count: 1,
        error: null
      }));

      const res = await request(app).get('/admin/notifications/sent');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('fetches stats correctly', async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'user_notification_preferences') {
          return createChainableMock({
            data: [{ push_enabled: true }, { push_enabled: false }],
            error: null
          });
        }
        if (table === 'user_notifications') {
          return createChainableMock({
            count: 50,
            error: null
          });
        }
        return createChainableMock({ data: [], error: null });
      });

      const res = await request(app).get('/admin/notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.delivery.total_sent_30d).toBe(50);
      expect(res.body.delivery.total_read_30d).toBe(50);
    });
  });
});