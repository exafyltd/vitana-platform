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
  })
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications Router', () => {
  let mockSupabase: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSupabase = {
      from: jest.fn((table: string) => {
        const builder: any = {};
        builder.select = jest.fn().mockReturnValue(builder);
        builder.eq = jest.fn().mockReturnValue(builder);
        builder.gte = jest.fn().mockReturnValue(builder);
        builder.not = jest.fn().mockReturnValue(builder);
        builder.order = jest.fn().mockReturnValue(builder);
        builder.range = jest.fn().mockReturnValue(builder);
        builder.or = jest.fn().mockReturnValue(builder);
        
        builder.then = (resolve: any) => {
          if (table === 'user_notification_preferences') {
            resolve({ data: [{ push_enabled: true }, { push_enabled: false }], error: null });
          } else if (table === 'user_notifications') {
            resolve({ data: [{ id: '1' }], count: 1, error: null });
          } else {
            resolve({ data: [], count: 0, error: null });
          }
        };
        return builder;
      })
    };

    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body is missing', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['u1'] });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should return 400 if no recipients specified', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'T', body: 'B' });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should send notification to single user synchronously', async () => {
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['u1'],
          type: 'test_type'
        });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith('u1', '', 'test_type', { title: 'Hello', body: 'World', data: undefined }, mockSupabase);
    });

    it('should dispatch to multiple users asynchronously', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['u1', 'u2'],
          type: 'test_type'
        });

      expect(res.status).toBe(200);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(['u1', 'u2'], '', 'test_type', { title: 'Hello', body: 'World', data: undefined }, mockSupabase);
    });
  });

  describe('GET /sent', () => {
    it('should fetch sent notifications', async () => {
      const res = await request(app).get('/admin/notifications/sent?limit=10&offset=0');
      
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should aggregate preferences', async () => {
      const res = await request(app).get('/admin/notifications/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.stats.push_disabled).toBe(1);
    });
  });
});