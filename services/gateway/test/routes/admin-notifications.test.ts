import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

// Mock the standard auth middleware
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

// Mock the Supabase client wrapper
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

// Mock the notification service
jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin-notifications', adminNotificationsRouter);

describe('Admin Notifications Routes', () => {
  let mockSupabase: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create a chainable query builder mock for Supabase
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
    it('should return 400 if title and body are missing', async () => {
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({ recipient_ids: ['user1'] });
        
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should send notification to a single user synchronously', async () => {
      (notifyUser as jest.Mock).mockResolvedValueOnce({ success: true });
      
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          recipient_ids: ['user1'],
          title: 'Hello',
          body: 'World'
        });
        
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
      
      expect(notifyUser).toHaveBeenCalledWith(
        'user1',
        '',
        'welcome_to_vitana', // fallback type
        { title: 'Hello', body: 'World', data: undefined },
        mockSupabase
      );
    });

    it('should dispatch to multiple users asynchronously', async () => {
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          recipient_ids: ['user1', 'user2'],
          title: 'Hello Multiple',
          body: 'World Multiple',
          type: 'custom_type'
        });
        
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(2);
      
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user1', 'user2'],
        undefined,
        'custom_type',
        { title: 'Hello Multiple', body: 'World Multiple', data: undefined },
        mockSupabase
      );
    });
  });

  describe('GET /sent', () => {
    it('should return paginated sent notifications', async () => {
      mockSupabase.range.mockResolvedValueOnce({
        data: [{ id: 'notif1', title: 'Test Notif' }],
        error: null,
        count: 1
      });

      const res = await request(app).get('/admin-notifications/sent');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(0);
    });

    it('should pass along query parameters to filters', async () => {
      mockSupabase.range.mockResolvedValueOnce({ data: [], error: null, count: 0 });

      await request(app).get('/admin-notifications/sent?type=test&user_id=123');

      expect(mockSupabase.eq).toHaveBeenCalledWith('type', 'test');
      expect(mockSupabase.eq).toHaveBeenCalledWith('user_id', '123');
    });
  });

  describe('GET /preferences/stats', () => {
    it('should aggregate notification preferences', async () => {
      // Mock preferences response
      mockSupabase.select.mockResolvedValueOnce({
        data: [
          { push_enabled: true, dnd_enabled: false },
          { push_enabled: false, dnd_enabled: true, live_room_notifications: false }
        ],
        error: null
      });

      // Mock total sent notifications
      mockSupabase.gte.mockResolvedValueOnce({ count: 10 });
      // Mock total read notifications
      mockSupabase.not.mockResolvedValueOnce({ count: 5 });

      const res = await request(app).get('/admin-notifications/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      
      const stats = res.body.stats;
      expect(stats.total_users_with_prefs).toBe(2);
      expect(stats.push_enabled).toBe(1);
      expect(stats.push_disabled).toBe(1);
      expect(stats.dnd_enabled).toBe(1);
      expect(stats.categories.live_room_notifications).toBe(1); // One false, one true (by default absent means true)
      
      const delivery = res.body.delivery;
      expect(delivery.total_sent_30d).toBe(10);
      expect(delivery.total_read_30d).toBe(5);
      expect(delivery.read_rate).toBe(50); // 5 / 10 * 100
    });
  });
});