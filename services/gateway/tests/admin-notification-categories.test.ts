import request from 'supertest';
import express from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

const mockSelect = jest.fn();
const mockOrder = jest.fn();
const mockEq = jest.fn();
const mockOr = jest.fn();
const mockIs = jest.fn();
const mockSingle = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();

const mockQuery = {
  select: mockSelect,
  order: mockOrder,
  eq: mockEq,
  or: mockOr,
  is: mockIs,
  single: mockSingle,
  insert: mockInsert,
  update: mockUpdate,
  then: jest.fn()
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockQuery)
  }))
}));

// Setup chainable returns
mockSelect.mockReturnValue(mockQuery);
mockOrder.mockReturnValue(mockQuery);
mockEq.mockReturnValue(mockQuery);
mockOr.mockReturnValue(mockQuery);
mockIs.mockReturnValue(mockQuery);
mockInsert.mockReturnValue(mockQuery);
mockUpdate.mockReturnValue(mockQuery);

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories - Auth Boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default resolve for collection queries
    mockQuery.then.mockImplementation((resolve) => resolve({ data: [{ id: '1', type: 'chat', slug: 'test' }], error: null }));
    
    // Default resolve for single queries
    mockSingle.mockResolvedValue({ data: { id: '1', type: 'chat', slug: 'test' }, error: null });
  });

  it('should return 401 UNAUTHENTICATED without a Bearer token', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const res = await request(app).get('/admin/notification-categories');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 403 FORBIDDEN for an authenticated non-admin user', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res) => {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer valid-non-admin-token');
    
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should return 200 OK for an authenticated admin user on GET', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const res = await request(app)
      .get('/admin/notification-categories')
      .set('Authorization', 'Bearer valid-admin-token');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 201 Created for an authenticated admin user on POST', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((req, res, next) => {
      (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
      next();
    });

    const res = await request(app)
      .post('/admin/notification-categories')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({
        type: 'chat',
        display_name: 'Test Category'
      });
    
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});