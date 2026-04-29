import request from 'supertest';
import express from 'express';
import router from '../../src/routes/admin-notification-categories';
import { createUserSupabaseClient } from '../../src/lib/supabase-user';
import { createClient } from '@supabase/supabase-js';

// Mock dependencies
jest.mock('../../src/lib/supabase-user');
jest.mock('@supabase/supabase-js');
jest.mock('../../src/services/notification-service');

const mockedCreateUserSupabaseClient = createUserSupabaseClient as jest.Mock;
const mockedCreateClient = createClient as jest.Mock;

const app = express();
app.use(express.json());
app.use('/', router);

describe('Admin Notification Categories API Auth', () => {
  const mockSupabaseQuery = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedCreateClient.mockReturnValue(mockSupabaseQuery);
  });

  it('should return 401 UNAUTHENTICATED for requests without a token', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 401 INVALID_TOKEN for requests with a bad token', async () => {
    mockedCreateUserSupabaseClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: { message: 'Invalid token' } }),
      },
    });

    const response = await request(app)
      .get('/')
      .set('Authorization', 'Bearer INVALID_TOKEN');

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('INVALID_TOKEN');
  });

  it('should return 403 FORBIDDEN for requests from a non-admin user', async () => {
    mockedCreateUserSupabaseClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'user-123',
              email: 'user@example.com',
              app_metadata: { exafy_admin: false },
            },
          },
          error: null,
        }),
      },
    });

    const response = await request(app)
      .get('/')
      .set('Authorization', 'Bearer NON_ADMIN_TOKEN');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('FORBIDDEN');
  });

  it('should allow access for a valid admin user', async () => {
    mockedCreateUserSupabaseClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'admin-456',
              email: 'admin@exafy.com',
              app_metadata: { exafy_admin: true },
            },
          },
          error: null,
        }),
      },
    });

    (mockSupabaseQuery.select as jest.Mock).mockResolvedValue({
      data: [{ id: 1, type: 'chat', display_name: 'Test Category' }],
      error: null,
    });

    const response = await request(app)
      .get('/')
      .set('Authorization', 'Bearer VALID_ADMIN_TOKEN');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.chat[0].display_name).toBe('Test Category');
  });

  it('should pass authUser to downstream handlers on successful auth', async () => {
    const adminUser = {
      id: 'admin-789',
      email: 'creator@exafy.com',
      app_metadata: { exafy_admin: true },
    };

    mockedCreateUserSupabaseClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: adminUser }, error: null }),
      },
    });

    const mockInsert = jest.fn().mockReturnThis();
    const mockSelect = jest.fn().mockResolvedValue({
        data: { id: 'new-id', created_by: adminUser.id },
        error: null,
    });

    mockedCreateClient.mockReturnValue({
        from: jest.fn().mockReturnThis(),
        insert: mockInsert,
        select: mockSelect,
        single: jest.fn().mockReturnThis()
    });

    await request(app)
      .post('/')
      .set('Authorization', 'Bearer VALID_ADMIN_TOKEN')
      .send({ type: 'chat', display_name: 'New Category' });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        created_by: adminUser.id,
      })
    );
  });
});