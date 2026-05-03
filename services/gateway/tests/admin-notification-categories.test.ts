import request from 'supertest';
import express from 'express';
import adminNotificationCategories from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => next()),
}));

jest.mock('@supabase/supabase-js', () => {
  const mQuery = {
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: 'mock-id', type: 'chat', slug: 'test' }, error: null }),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
  };
  
  // Make the query builder thenable so `await query` resolves to an array of mock data
  (mQuery as any).then = function(resolve: any) {
    return Promise.resolve({ data: [{ id: 'mock-id', type: 'chat', slug: 'test' }], error: null }).then(resolve);
  };

  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => mQuery),
    })),
  };
});

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ success: true }),
}));

const app = express();
app.use(express.json());
app.use('/admin/categories', adminNotificationCategories);

describe('Admin Notification Categories - Auth Boundary', () => {
  const mockRequireAdmin = requireAdmin as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 for unauthenticated request', async () => {
    mockRequireAdmin.mockImplementationOnce((req, res) => {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const response = await request(app).get('/admin/categories');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 for authenticated non-admin', async () => {
    mockRequireAdmin.mockImplementationOnce((req, res) => {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const response = await request(app).get('/admin/categories');
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('FORBIDDEN');
  });

  it('should return 200 on GET and 201 on POST for authenticated admin', async () => {
    mockRequireAdmin.mockImplementation((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@exafy.com' };
      next();
    });

    const getResponse = await request(app).get('/admin/categories');
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.ok).toBe(true);

    const postResponse = await request(app)
      .post('/admin/categories')
      .send({
        type: 'chat',
        display_name: 'Test Chat'
      });
    expect(postResponse.status).toBe(201);
    expect(postResponse.body.ok).toBe(true);
  });
});