import request from 'supertest';
import express from 'express';
import router from '../../src/routes/admin-notifications';
import { getSupabase } from '../../src/lib/supabase';
import { notifyUser, notifyUsersAsync } from '../../src/services/notification-service';

jest.mock('../../src/middleware/auth', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    req.user = { id: 'admin1', email: 'admin@example.com' };
    next();
  }
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  notifyUsersAsync: jest.fn()
}));

describe('Admin Notifications Route', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/', router);
    jest.clearAllMocks();
  });

  it('POST /compose handles missing input', async () => {
    (getSupabase as jest.Mock).mockReturnValue({});
    const res = await request(app).post('/compose').send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('title and body are required');
  });

  it('POST /compose calls notifyUser for 1 recipient', async () => {
    (getSupabase as jest.Mock).mockReturnValue({});
    (notifyUser as jest.Mock).mockResolvedValue('ok');
    const res = await request(app).post('/compose').send({
      title: 'T',
      body: 'B',
      recipient_ids: ['u1']
    });
    expect(res.status).toBe(200);
    expect(notifyUser).toHaveBeenCalled();
  });

  it('GET /sent fetches data', async () => {
    const mockQuery = {
      select: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({ data: [], count: 0, error: null })
    };
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue(mockQuery)
    });

    const res = await request(app).get('/sent');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /preferences/stats fetches stats', async () => {
    const mockQuery = {
      select: jest.fn().mockResolvedValue({ data: [], error: null })
    };
    
    const mockUserNotifications = {
      select: jest.fn().mockReturnThis(),
      gte: jest.fn().mockImplementation(() => {
        const p = Promise.resolve({ count: 10 });
        (p as any).not = jest.fn().mockResolvedValue({ count: 5 });
        return p;
      })
    };

    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn().mockImplementation((t) => {
        if (t === 'user_notifications') return mockUserNotifications;
        return mockQuery; 
      })
    });

    const res = await request(app).get('/preferences/stats');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.delivery.total_sent_30d).toBe(10);
  });
});