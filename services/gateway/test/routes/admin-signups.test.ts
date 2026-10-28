import request from 'supertest';
import express from 'express';
import router from '../../src/routes/admin-signups';
import { getSupabase } from '../../src/lib/supabase';
import { requireExafyAdmin } from '../../src/middleware/auth-supabase-jwt';

// Mock Dependencies
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireExafyAdmin: jest.fn((req, res, next) => {
    if (req.headers.authorization === 'Bearer valid-admin-token') {
      req.identity = { user_id: 'admin-123', email: 'admin@example.com', exafy_admin: true };
      return next();
    }
    return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  }),
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUserAsync: jest.fn(),
}));

jest.mock('../../src/services/automation-executor', () => ({
  dispatchEvent: jest.fn().mockResolvedValue(true),
}));

// Provide a flexible fluent mock for Supabase query chaining
const createMockQuery = () => {
  const q: any = {};
  q.eq = jest.fn(() => q);
  q.or = jest.fn(() => q);
  q.ilike = jest.fn(() => q);
  q.order = jest.fn(() => q);
  q.range = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.gte = jest.fn(() => q);
  q.single = jest.fn().mockResolvedValue({ 
    data: { id: 'mock-id', tenant_id: 't-1', email: 'test@example.com' }, 
    error: null 
  });
  q.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
  q.then = jest.fn((resolve) => resolve({ data: [], error: null, count: 0 }));
  return q;
};

// Mount the app
const app = express();
app.use(express.json());
app.use('/admin-signups', router);

describe('Admin Signups Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn(() => createMockQuery()),
      auth: {
        admin: {
          getUserById: jest.fn().mockResolvedValue({ data: { user: { email: 'auth@example.com' } } })
        }
      }
    });
  });

  describe('Protected Routes', () => {
    it('should reject unauthenticated access to /', async () => {
      const res = await request(app).get('/admin-signups/');
      expect(res.status).toBe(403);
      expect(requireExafyAdmin).toHaveBeenCalled();
    });

    it('should reject unauthenticated access to /stats', async () => {
      const res = await request(app).get('/admin-signups/stats');
      expect(res.status).toBe(403);
      expect(requireExafyAdmin).toHaveBeenCalled();
    });

    it('should reject unauthenticated access to /attempts', async () => {
      const res = await request(app).get('/admin-signups/attempts');
      expect(res.status).toBe(403);
      expect(requireExafyAdmin).toHaveBeenCalled();
    });

    it('should allow authenticated access to /stats', async () => {
      const res = await request(app)
        .get('/admin-signups/stats')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(requireExafyAdmin).toHaveBeenCalled();
    });

    it('should allow authenticated access to /invitations', async () => {
      const res = await request(app)
        .get('/admin-signups/invitations')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(requireExafyAdmin).toHaveBeenCalled();
    });
  });

  describe('Public Routes', () => {
    it('should allow POST /log-attempt without authentication', async () => {
      const res = await request(app)
        .post('/admin-signups/log-attempt')
        .send({ email: 'newuser@example.com', tenant_id: 't-1' });

      expect(requireExafyAdmin).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('should allow POST /log-result without authentication', async () => {
      const res = await request(app)
        .post('/admin-signups/log-result')
        .send({ attempt_id: 'att-123', status: 'started' });

      expect(requireExafyAdmin).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});