import express from 'express';
import request from 'supertest';
import router from '../../../src/routes/admin-notifications';
import { notifyUser, notifyUsersAsync } from '../../../src/services/notification-service';

// Mock the shared authentication middleware
jest.mock('../../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req: any, res: any, next: any) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

// Mock Supabase with chainable queries
const mockSupabase = {
  from: jest.fn((table: string) => {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
    };
    
    // Allow the chain to be awaited directly
    chain.then = function(resolve: any) {
      if (table === 'user_notifications') {
        // If checking unread vs total
        if (this.not.mock.calls.length > 0) {
          return resolve({ data: [], count: 50, error: null });
        }
        return resolve({ data: [{ id: 'notif-1' }], count: 100, error: null });
      }
      if (table === 'user_notification_preferences') {
        return resolve({ data: [{ push_enabled: true }], error: null });
      }
      return resolve({ data: [], error: null });
    };
    
    return chain;
  })
};

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: () => mockSupabase
}));

// Mock Notification Service
jest.mock('../../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true }),
  notifyUsersAsync: jest.fn().mockResolvedValue({ success: true })
}));

const app = express();
app.use(express.json());
app.use('/admin-notifications', router);

describe('Admin Notifications Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should send notification to a single user successfully', async () => {
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          title: 'Test Title',
          body: 'Test Body',
          recipient_ids: ['user1']
        });
        
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(notifyUser).toHaveBeenCalled();
    });

    it('should reject request without title or body', async () => {
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          recipient_ids: ['user1']
        });
        
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should reject request without recipients criteria', async () => {
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          title: 'Test Title',
          body: 'Test Body'
        });
        
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications with total count', async () => {
      const res = await request(app)
        .get('/admin-notifications/sent')
        .query({ limit: 10, offset: 0 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(100);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return aggregate preference statistics', async () => {
      const res = await request(app)
        .get('/admin-notifications/preferences/stats');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(100);
      expect(res.body.delivery.total_read_30d).toBe(50);
      expect(res.body.delivery.read_rate).toBe(50); // 50 / 100 * 100
    });
  });
});