import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req: any, res: any, next: any) => {
    req.user = { id: 'admin-123', email: 'admin@test.com' };
    next();
  })
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications API', () => {
  let mockSupabase: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis()
    };

    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  describe('POST /compose', () => {
    it('requires title and body', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['u1'] });
        
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('requires recipients', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B' });
        
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('sends to single recipient', async () => {
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });
      
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
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
      mockSupabase.eq.mockResolvedValue({ data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null });
      
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_role: 'member',
          tenant_id: 't1'
        });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['u1', 'u2'],
        't1',
        'welcome_to_vitana',
        { title: 'Hello', body: 'World', data: undefined },
        mockSupabase
      );
    });
  });

  describe('GET /sent', () => {
    it('returns sent notifications', async () => {
      mockSupabase.range.mockResolvedValue({ data: [{ id: 1 }], error: null, count: 1 });
      
      const res = await request(app)
        .get('/admin/notifications/sent')
        .query({ limit: 10, offset: 0 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toEqual([{ id: 1 }]);
    });
  });

  describe('GET /preferences/stats', () => {
    it('returns preference stats', async () => {
      mockSupabase.select
        .mockResolvedValueOnce({ data: [{ push_enabled: true }, { push_enabled: false }], error: null }) // prefs
        .mockResolvedValueOnce({ count: 100 }) // notifications count
        .mockResolvedValueOnce({ count: 50 }); // read count
        
      const res = await request(app).get('/admin/notifications/preferences/stats');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.delivery.read_rate).toBe(50);
    });
  });
});