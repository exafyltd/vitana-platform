import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

// Mock dependencies
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
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

describe('Admin Notifications API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body is missing', async () => {
      (getSupabase as jest.Mock).mockReturnValue({}); // Mock supabase
      
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          recipient_ids: ['user-1']
        });
      
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('title and body are required');
    });

    it('should return 400 if no recipients specified', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World'
        });
      
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Must specify recipient_ids, recipient_role, or send_to_all');
    });

    it('should send notification to a single user synchronously', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      (notifyUser as jest.Mock).mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          recipient_ids: ['user-1'],
          title: 'Hello',
          body: 'World'
        });

      expect(response.status).toBe(200);
      expect(response.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana',
        expect.objectContaining({ title: 'Hello', body: 'World' }),
        expect.any(Object)
      );
    });

    it('should send notifications asynchronously to multiple users', async () => {
      (getSupabase as jest.Mock).mockReturnValue({});
      
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          recipient_ids: ['user-1', 'user-2'],
          title: 'Hello',
          body: 'World'
        });

      expect(response.status).toBe(200);
      expect(response.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        '',
        'welcome_to_vitana',
        expect.objectContaining({ title: 'Hello', body: 'World' }),
        expect.any(Object)
      );
    });
  });

  describe('GET /sent', () => {
    it('should return paginated sent notifications', async () => {
      const mockQuery = Promise.resolve({ data: [{ id: 1 }], count: 1, error: null });
      (mockQuery as any).select = jest.fn().mockReturnValue(mockQuery);
      (mockQuery as any).gte = jest.fn().mockReturnValue(mockQuery);
      (mockQuery as any).order = jest.fn().mockReturnValue(mockQuery);
      (mockQuery as any).range = jest.fn().mockReturnValue(mockQuery);

      const mockSupabase = {
        from: jest.fn().mockReturnValue(mockQuery)
      };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/sent?limit=10&offset=0');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return preferences stats and delivery metrics', async () => {
      const mockSupabase = {
        from: jest.fn((table: string) => {
          if (table === 'user_notification_preferences') {
            const mockPref = Promise.resolve({ data: [{ push_enabled: true }], error: null });
            (mockPref as any).select = jest.fn().mockReturnValue(mockPref);
            (mockPref as any).eq = jest.fn().mockReturnValue(mockPref);
            return mockPref;
          } else if (table === 'user_notifications') {
            const query = Promise.resolve({ count: 5, data: [], error: null });
            (query as any).select = jest.fn().mockReturnValue(query);
            (query as any).gte = jest.fn().mockReturnValue(query);
            (query as any).not = jest.fn().mockReturnValue(Promise.resolve({ count: 3, error: null }));
            return query;
          }
        })
      };

      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      const response = await request(app).get('/admin/notifications/preferences/stats');

      expect(response.status).toBe(200);
      expect(response.body.stats.push_enabled).toBe(1);
      expect(response.body.delivery.total_sent_30d).toBe(5);
      expect(response.body.delivery.total_read_30d).toBe(3);
      expect(response.body.delivery.read_rate).toBe(60); // (3 / 5) * 100
    });
  });
});