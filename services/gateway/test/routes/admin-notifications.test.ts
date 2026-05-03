import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';

// Mock auth middleware
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
    (req as any).user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  })
}));

// Mock variables for Supabase chain
let mockResolveValues: any[] = [];

const createMockChain = () => {
  const chain: any = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    order: jest.fn(() => chain),
    range: jest.fn(() => chain),
    or: jest.fn(() => chain),
    not: jest.fn(() => chain),
    then: jest.fn((resolve) => {
      const val = mockResolveValues.shift() || { data: [], error: null, count: 0 };
      resolve(val);
    })
  };
  return chain;
};

const mockSupabase = {
  from: jest.fn(() => createMockChain())
};

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase)
}));

// Mock Notification Service
jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true }),
  notifyUsersAsync: jest.fn().mockResolvedValue(true)
}));

const app = express();
app.use(express.json());
app.use('/admin-notifications', adminNotificationsRouter);

describe('Admin Notifications Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveValues = [];
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body are missing', async () => {
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({ recipient_ids: ['user-1'] });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('title and body are required');
    });

    it('should send a notification to a single user', async () => {
      mockResolveValues = [{ data: [], error: null }];
      
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          recipient_ids: ['user-1'],
          title: 'Test Title',
          body: 'Test Body'
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
    });

    it('should send notifications to multiple users via role', async () => {
      // Mock lookup response for role
      mockResolveValues = [
        { data: [{ user_id: 'user-1' }, { user_id: 'user-2' }], error: null }
      ];
      
      const res = await request(app)
        .post('/admin-notifications/compose')
        .send({
          recipient_role: 'community',
          tenant_id: 'tenant-1',
          title: 'Role Test',
          body: 'Role Body'
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(2);
    });
  });

  describe('GET /sent', () => {
    it('should fetch sent notifications', async () => {
      mockResolveValues = [
        { data: [{ id: 'notif-1', type: 'test' }], count: 1, error: null }
      ];

      const res = await request(app).get('/admin-notifications/sent?limit=10&offset=0');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should fetch preference statistics', async () => {
      // 1. preferences query
      // 2. notification count query
      // 3. read count query
      mockResolveValues = [
        { data: [{ push_enabled: true }, { push_enabled: false }], error: null },
        { count: 100, error: null },
        { count: 45, error: null }
      ];

      const res = await request(app).get('/admin-notifications/preferences/stats');
      expect(res.status).toBe(200);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.stats.push_disabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(100);
      expect(res.body.delivery.total_read_30d).toBe(45);
      expect(res.body.delivery.read_rate).toBe(45); // (45 / 100) * 100
    });
  });
});