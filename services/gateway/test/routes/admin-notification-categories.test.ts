import request from 'supertest';
import express from 'express';
import router from '../../src/routes/admin-notification-categories';
import { createUserSupabaseClient } from '../../src/lib/supabase-user';
import { createClient } from '@supabase/supabase-js';

// Mock dependencies
jest.mock('../../src/lib/supabase-user');
jest.mock('@supabase/supabase-js');
jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));


const mockCreateUserSupabaseClient = createUserSupabaseClient as jest.Mock;
const mockCreateSupabaseClient = createClient as jest.Mock;

const app = express();
app.use(express.json());
app.use('/', router);

describe('Admin Notification Categories Routes', () => {
  let mockSupabase: any;
  
  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock for the service role client
    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { id: '123' }, error: null }),
    };
    mockCreateSupabaseClient.mockReturnValue(mockSupabase);
  });

  // --- Auth Middleware Tests ---

  it('should return 401 if no Authorization header is provided', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 401 if the token is invalid', async () => {
    mockCreateUserSupabaseClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: { message: 'Invalid token' } }),
      },
    });

    const response = await request(app).get('/').set('Authorization', 'Bearer invalid-token');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('INVALID_TOKEN');
  });

  it('should return 403 if the user is not an exafy_admin', async () => {
    mockCreateUserSupabaseClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'user-123',
              email: 'test@example.com',
              app_metadata: { exafy_admin: false },
            },
          },
          error: null,
        }),
      },
    });

    const response = await request(app).get('/').set('Authorization', 'Bearer valid-non-admin-token');
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('FORBIDDEN');
  });

  it('should allow access if the user is an exafy_admin', async () => {
    // Mock user client for auth
    mockCreateUserSupabaseClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'admin-123',
              email: 'admin@example.com',
              app_metadata: { exafy_admin: true },
            },
          },
          error: null,
        }),
      },
    });

    // Mock service client for the handler logic
    mockSupabase.select.mockResolvedValue({ data: [], error: null });

    const response = await request(app).get('/').set('Authorization', 'Bearer valid-admin-token');
    
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toEqual({ chat: [], calendar: [], community: [] }); // Check handler response
    expect(mockCreateUserSupabaseClient).toHaveBeenCalledWith('valid-admin-token');
  });

  // --- Example handler test to confirm passthrough ---

  it('POST / should create a category for an admin user', async () => {
     // Mock user client for auth
    mockCreateUserSupabaseClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'admin-user-id',
              email: 'admin@example.com',
              app_metadata: { exafy_admin: true },
            },
          },
          error: null,
        }),
      },
    });

    const newCategory = {
      type: 'chat',
      display_name: 'New Test Category',
      description: 'A test category',
    };

    const createdCategory = {
      ...newCategory,
      id: 'new-id-123',
      slug: 'new_test_category',
      created_by: 'admin-user-id',
      is_active: true,
      sort_order: 0,
      default_enabled: true,
      mapped_types: [],
      tenant_id: null,
    };

    mockSupabase.single.mockResolvedValue({ data: createdCategory, error: null });

    const response = await request(app)
      .post('/')
      .set('Authorization', 'Bearer valid-admin-token')
      .send(newCategory);

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toMatchObject(newCategory);
    expect(mockSupabase.insert).toHaveBeenCalledWith(expect.objectContaining({
        ...newCategory,
        slug: 'new_test_category',
        created_by: 'admin-user-id' // confirms user is passed from middleware
    }));
  });
});