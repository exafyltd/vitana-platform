import express from 'express';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import { createUserSupabaseClient } from '../../src/lib/supabase-user';
import adminNotificationCategoriesRouter from '../../src/routes/admin-notification-categories';
import { notifyUser } from '../../src/services/notification-service';

// Mock dependencies
jest.mock('@supabase/supabase-js');
jest.mock('../../src/lib/supabase-user');
jest.mock('../../src/services/notification-service');

const mockedCreateUserSupabaseClient = createUserSupabaseClient as jest.Mock;
const mockedCreateSupabaseClient = createClient as jest.Mock;
const mockedNotifyUser = notifyUser as jest.Mock;

const app = express();
app.use(express.json());
// Mount the router at a specific path for testing
app.use('/', adminNotificationCategoriesRouter);

describe('Admin Notification Categories Routes', () => {
  let mockDbClient: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock for the service role Supabase client
    mockDbClient = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: {}, error: null }),
    };
    mockedCreateSupabaseClient.mockReturnValue(mockDbClient);
  });

  describe('Auth Middleware', () => {
    it('should return 401 Unauthorized if no token is provided', async () => {
      const response = await request(app).get('/');
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    });

    it('should return 401 Unauthorized for an invalid token', async () => {
      mockedCreateUserSupabaseClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: { message: 'invalid token' } }),
        },
      });

      const response = await request(app).get('/').set('Authorization', 'Bearer invalid-token');
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ ok: false, error: 'INVALID_TOKEN' });
    });

    it('should return 403 Forbidden for a non-admin user', async () => {
      mockedCreateUserSupabaseClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({
            data: {
              user: {
                id: 'user-123',
                email: 'user@test.com',
                app_metadata: { exafy_admin: false },
              },
            },
            error: null,
          }),
        },
      });

      const response = await request(app).get('/').set('Authorization', 'Bearer non-admin-token');
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ ok: false, error: 'FORBIDDEN' });
    });

    it('should pass through to the handler for an admin user', async () => {
      // Mock auth for an admin user
      mockedCreateUserSupabaseClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({
            data: {
              user: {
                id: 'admin-456',
                email: 'admin@test.com',
                app_metadata: { exafy_admin: true },
              },
            },
            error: null,
          }),
        },
      });

      // Mock the database response for the GET / handler
      const mockCategories = [{ id: 'cat-1', type: 'chat', display_name: 'Chat Notifications' }];
      (mockDbClient.select as jest.Mock).mockResolvedValue({ data: mockCategories, error: null });

      const response = await request(app).get('/').set('Authorization', 'Bearer admin-token');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data.chat).toEqual(mockCategories);
      expect(mockedCreateUserSupabaseClient).toHaveBeenCalledWith('admin-token');
    });
  });

  describe('CRUD operations (with admin auth)', () => {
    beforeEach(() => {
      // Set up admin auth for all tests in this block
      mockedCreateUserSupabaseClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({
            data: {
              user: {
                id: 'admin-456',
                email: 'admin@test.com',
                app_metadata: { exafy_admin: true },
              },
            },
            error: null,
          }),
        },
      });
    });

    it('POST /:id/test should send a notification and use authUser', async () => {
      const mockCategory = {
        id: 'cat-test-1',
        slug: 'test-category',
        display_name: 'Test Category',
        mapped_types: ['test_event'],
      };
      // Mock DB calls in order: 1. get category, 2. get tenant
      (mockDbClient.single as jest.Mock)
        .mockResolvedValueOnce({ data: mockCategory, error: null })
        .mockResolvedValueOnce({ data: { tenant_id: 'tenant-123' }, error: null });

      mockedNotifyUser.mockResolvedValue({ success: true, message: 'sent' });

      const response = await request(app)
        .post('/cat-test-1/test')
        .set('Authorization', 'Bearer admin-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, result: { success: true, message: 'sent' } });
      expect(mockedNotifyUser).toHaveBeenCalledWith(
        'admin-456', // user_id from authUser
        'tenant-123', // tenant_id from lookup
        'test_event', // type from category
        expect.any(Object), // payload
        expect.any(Object)  // supabase client
      );
    });
  });
});