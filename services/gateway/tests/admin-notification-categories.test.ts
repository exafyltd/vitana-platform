import request from 'supertest';
import express from 'express';

// Set up mock before importing the router to ensure it uses the mocked middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    if (authHeader.includes('non-admin')) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    req.user = { id: 'admin-123', email: 'admin@example.com' };
    next();
  })
}));

const mockQueryObj: any = {
  select: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  single: jest.fn(),
};
mockQueryObj.then = jest.fn((resolve) => resolve({ data: [], error: null }));

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: jest.fn(() => mockQueryObj)
  })
}));

import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/admin-categories', adminNotificationCategoriesRouter);

describe('Admin Notification Categories API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    mockQueryObj.then.mockImplementation((resolve: any) => resolve({ data: [], error: null }));
    mockQueryObj.single.mockResolvedValue({ 
      data: { id: 'cat-123', slug: 'test_cat', type: 'chat' }, 
      error: null 
    });
  });

  it('rejects unauthenticated requests with 401', async () => {
    const response = await request(app).get('/admin-categories');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('rejects non-admin authenticated requests with 403', async () => {
    const response = await request(app)
      .get('/admin-categories')
      .set('Authorization', 'Bearer non-admin-token');
    
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('allows admin requests and returns 200 on GET', async () => {
    const response = await request(app)
      .get('/admin-categories')
      .set('Authorization', 'Bearer admin-token');
    
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('allows admin requests and returns 201 on POST', async () => {
    const response = await request(app)
      .post('/admin-categories')
      .set('Authorization', 'Bearer admin-token')
      .send({
        type: 'chat',
        display_name: 'Test Category'
      });
    
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
  });
});