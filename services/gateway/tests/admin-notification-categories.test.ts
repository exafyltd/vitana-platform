import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import adminNotificationCategoriesRouter from '../src/routes/admin-notification-categories';
import { requireAdmin } from '../src/middleware/requireAdmin';

// Mock the middleware
jest.mock('../src/middleware/requireAdmin', () => ({
  requireAdmin: jest.fn()
}));

// Mock Supabase to avoid real DB calls
const mockChain = {
  select: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: { id: 'cat-123', type: 'chat', slug: 'chat-cat' }, error: null }),
  then: jest.fn(function(this: any, resolve: any) {
    return Promise.resolve({ data: [{ id: 'cat-123', type: 'chat', slug: 'chat-cat' }], error: null }).then(resolve);
  })
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => mockChain)
  }))
}));

const app = express();
app.use(express.json());
app.use('/admin/notification-categories', adminNotificationCategoriesRouter);

const mockRequireAdmin = requireAdmin as jest.Mock;

describe('Admin Notification Categories API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Auth Boundary', () => {
    it('should return 401 for unauthenticated requests', async () => {
      mockRequireAdmin.mockImplementation((req: Request, res: Response, next: NextFunction) => {
        res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      });

      const response = await request(app).get('/admin/notification-categories');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('should return 403 for authenticated non-admin requests', async () => {
      mockRequireAdmin.mockImplementation((req: Request, res: Response, next: NextFunction) => {
        res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      });

      const response = await request(app).get('/admin/notification-categories');
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('FORBIDDEN');
    });

    it('should return 200 for authenticated admin requests on GET', async () => {
      mockRequireAdmin.mockImplementation((req: Request, res: Response, next: NextFunction) => {
        (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
        next();
      });

      const response = await request(app).get('/admin/notification-categories');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    it('should return 201 for authenticated admin requests on POST', async () => {
      mockRequireAdmin.mockImplementation((req: Request, res: Response, next: NextFunction) => {
        (req as any).user = { id: 'admin-123', email: 'admin@example.com' };
        next();
      });

      const response = await request(app)
        .post('/admin/notification-categories')
        .send({ type: 'chat', display_name: 'Chat Category' });
      
      expect(response.status).toBe(201);
      expect(response.body.ok).toBe(true);
    });
  });
});