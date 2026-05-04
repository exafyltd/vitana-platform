import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';

// Mock the shared admin auth middleware
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
  notifyUser: jest.fn().mockResolvedValue(true),
  notifyUsersAsync: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockSupabase = () => {
    const chainable = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({ data: [], error: null, count: 0 }),
      then: jest.fn((resolve) => resolve({ data: [], error: null, count: 0 }))
    };
    return chainable;
  };

  describe('POST /compose', () => {
    it('should return 400 if title and body are missing', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['user-123'] });
      
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('title and body are required');
    });

    it('should succeed for a single user', async () => {
      const { getSupabase } = require('../../src/lib/supabase');
      getSupabase.mockReturnValue(createMockSupabase());

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          recipient_ids: ['user-1'],
          title: 'Test Title',
          body: 'Test Body'
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
    });
  });

  describe('GET /sent', () => {
    it('should return sent notifications', async () => {
      const { getSupabase } = require('../../src/lib/supabase');
      getSupabase.mockReturnValue(createMockSupabase());

      const res = await request(app).get('/admin/notifications/sent');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should return stats', async () => {
      const { getSupabase } = require('../../src/lib/supabase');
      getSupabase.mockReturnValue(createMockSupabase());

      const res = await request(app).get('/admin/notifications/preferences/stats');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats).toBeDefined();
      expect(res.body.delivery).toBeDefined();
    });
  });
});