import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import adminNotificationsRouter from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

// Mock dependencies
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
    (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
    next();
  })
}));

const app = express();
app.use(express.json());
app.use('/admin/notifications', adminNotificationsRouter);

describe('Admin Notifications Router', () => {
  let mockQuery: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create chainable mock for Supabase
    mockQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      then: jest.fn((resolve) => resolve({ data: [], count: 0, error: null }))
    };

    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn(() => mockQuery)
    });
  });

  describe('POST /compose', () => {
    it('should return 400 if title or body is missing', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ recipient_ids: ['user-1'] });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should return 400 if no recipient targeting is provided', async () => {
      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({ title: 'Test', body: 'Test body' });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_INPUT');
    });

    it('should send direct notification synchronously for a single user', async () => {
      (notifyUser as jest.Mock).mockResolvedValueOnce({ success: true });

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          recipient_ids: ['user-1']
        });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(1);
      expect(notifyUser).toHaveBeenCalledWith(
        'user-1',
        '',
        'welcome_to_vitana', // fallback type
        expect.any(Object),
        expect.anything()
      );
    });

    it('should fetch users and dispatch async for multiple users', async () => {
      mockQuery.then.mockImplementationOnce((resolve: any) => 
        resolve({ data: [{ user_id: 'user-1' }, { user_id: 'user-2' }], error: null })
      );

      const res = await request(app)
        .post('/admin/notifications/compose')
        .send({
          title: 'Hello',
          body: 'World',
          send_to_all: true,
          tenant_id: 'tenant-1'
        });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sent_to).toBe(2);
      expect(notifyUsersAsync).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        'tenant-1',
        'welcome_to_vitana',
        expect.any(Object),
        expect.anything()
      );
    });
  });

  describe('GET /sent', () => {
    it('should fetch paginated sent notifications', async () => {
      mockQuery.then.mockImplementationOnce((resolve: any) => 
        resolve({ data: [{ id: 'notif-1', title: 'Test' }], count: 1, error: null })
      );

      const res = await request(app)
        .get('/admin/notifications/sent')
        .query({ limit: 10, offset: 0, days: 7 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].id).toBe('notif-1');
    });

    it('should return 500 on supabase error', async () => {
      mockQuery.then.mockImplementationOnce((resolve: any) => 
        resolve({ data: null, error: { message: 'DB Error' } })
      );

      const res = await request(app).get('/admin/notifications/sent');

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('DB Error');
    });
  });

  describe('GET /preferences/stats', () => {
    it('should calculate stats properly based on preference records', async () => {
      // Create a specific mock logic for sequential promises
      mockQuery.then
        .mockImplementationOnce((resolve: any) => 
          resolve({ 
            data: [
              { push_enabled: true, dnd_enabled: false },
              { push_enabled: false, dnd_enabled: true }
            ], 
            error: null 
          })
        )
        .mockImplementationOnce((resolve: any) => resolve({ count: 100, error: null }))
        .mockImplementationOnce((resolve: any) => resolve({ count: 45, error: null }));

      const res = await request(app).get('/admin/notifications/preferences/stats');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.stats.total_users_with_prefs).toBe(2);
      expect(res.body.stats.push_enabled).toBe(1);
      expect(res.body.stats.push_disabled).toBe(1);
      expect(res.body.delivery.total_sent_30d).toBe(100);
      expect(res.body.delivery.total_read_30d).toBe(45);
      expect(res.body.delivery.read_rate).toBe(45);
    });
  });
});