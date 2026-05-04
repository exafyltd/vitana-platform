import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

// Mock the auth middleware BEFORE importing the router
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: (req: Request, res: Response, next: NextFunction) => {
    (req as any).user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  }
}));

const mockSupabaseChain = (table: string, overrides: any = {}) => {
  const chain: any = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    or: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    not: jest.fn(() => chain),
    order: jest.fn(() => chain),
    range: jest.fn(() => chain),
    then: jest.fn((resolve) => resolve(overrides))
  };
  return chain;
};

let tableMocks: Record<string, any> = {};

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({
    from: jest.fn((table: string) => mockSupabaseChain(table, tableMocks[table]))
  }))
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true }),
  notifyUsersAsync: jest.fn()
}));

import adminNotificationsRouter from '../../src/routes/admin-notifications';

const app = express();
app.use(express.json());
app.use('/admin', adminNotificationsRouter);

describe('Admin Notifications Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tableMocks = {
      'user_notifications': { data: [{ id: 1 }], count: 1, error: null },
      'user_notification_preferences': { data: [{ push_enabled: true, dnd_enabled: false }], error: null }
    };
  });

  describe('POST /compose', () => {
    it('should send notification to specific users', async () => {
      const res = await request(app)
        .post('/admin/compose')
        .send({
          title: 'Test',
          body: 'Test body',
          recipient_ids: ['user1']
        });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
    });

    it('should fail if missing title or body', async () => {
      const res = await request(app)
        .post('/admin/compose')
        .send({
          recipient_ids: ['user1']
        });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const res = await request(app).get('/admin/sent?limit=10');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return preferences stats', async () => {
      const res = await request(app).get('/admin/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.stats.push_disabled).toBe(0);
    });
  });
});