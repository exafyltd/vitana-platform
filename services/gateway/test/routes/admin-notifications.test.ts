import request from 'supertest';
import express from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';

// Mock the auth middleware
jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    req.user = { id: 'admin-id', email: 'admin@test.com' };
    next();
  }),
}));

const mockQuery = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  gte: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  range: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  not: jest.fn().mockReturnThis(),
  then: jest.fn((resolve) => resolve({ data: [{ user_id: 'u1' }], count: 1, error: null }))
};

const mockSupabase = {
  from: jest.fn(() => mockQuery)
};

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ id: 'n1' }),
  notifyUsersAsync: jest.fn().mockResolvedValue(undefined),
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /compose', () => {
    it('should send notification to specific users', async () => {
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['u1']
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.sent_to).toBe(1);
    });

    it('should return 400 if title or body is missing', async () => {
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          recipient_ids: ['u1']
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.message).toBe('title and body are required');
    });

    it('should return 400 if no recipients specified', async () => {
      const response = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World'
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
    });
  });

  describe('GET /sent', () => {
    it('should retrieve sent notifications', async () => {
      const response = await request(app)
        .get('/admin/notifications/sent')
        .query({ limit: 10 });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data.length).toBe(1);
    });
  });

  describe('GET /preferences/stats', () => {
    it('should retrieve aggregate stats', async () => {
      const response = await request(app)
        .get('/admin/notifications/preferences/stats');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.stats).toBeDefined();
      expect(response.body.delivery).toBeDefined();
    });
  });
});