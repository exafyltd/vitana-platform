/**
 * Tests for admin-notification-categories routes (auth middleware)
 */

import request from 'supertest';
import express from 'express';

// Mocks must be set up before importing the module under test
jest.mock('../../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn(),
}));

jest.mock('@supabase/supabase-js', () => {
  const mockFrom = jest.fn().mockReturnThis();
  const mockSelect = jest.fn().mockReturnThis();
  const mockOrder = jest.fn().mockReturnThis();
  const mockEq = jest.fn().mockReturnThis();
  const mockOr = jest.fn().mockReturnThis();
  const mockIs = jest.fn().mockReturnThis();
  const mockSingle = jest.fn().mockReturnThis();
  const mockInsert = jest.fn().mockReturnThis();
  const mockUpdate = jest.fn().mockReturnThis();
  const mockLimit = jest.fn().mockReturnThis();
  const mockThen = (callback: any) => callback({ data: [], error: null });
  const mockQuery = {
    from: mockFrom,
    select: mockSelect,
    order: mockOrder,
    eq: mockEq,
    or: mockOr,
    is: mockIs,
    single: mockSingle,
    insert: mockInsert,
    update: mockUpdate,
    limit: mockLimit,
    then: mockThen,
  };
  return {
    createClient: jest.fn(() => ({
      from: () => mockQuery,
      auth: {
        getUser: jest.fn(),
      },
    })),
  };
});

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));

import router from '../../src/routes/admin-notification-categories';
import { createUserSupabaseClient } from '../../src/lib/supabase-user';

const mockedCreateUserSupabaseClient = createUserSupabaseClient as jest.Mock;
const app = express();
app.use(express.json());
app.use('/', router);

describe('Admin Notification Categories — auth middleware', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 when no Bearer token is provided', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should return 401 when token is invalid', async () => {
    const mockClient = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: new Error('invalid token') }),
      },
    };
    mockedCreateUserSupabaseClient.mockReturnValue(mockClient);

    const res = await request(app)
      .get('/')
      .set('Authorization', 'Bearer some-invalid-token');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'INVALID_TOKEN' });
  });

  it('should return 403 when user is not exafy_admin', async () => {
    const mockClient = {
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
    };
    mockedCreateUserSupabaseClient.mockReturnValue(mockClient);

    const res = await request(app)
      .get('/')
      .set('Authorization', 'Bearer some-valid-nonadmin-token');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('should pass middleware and return 200 for valid admin token (GET /)', async () => {
    const mockQuery = jest.fn();
    const mockSelect = jest.fn();
    const mockOrder = jest.fn();
    const mockEq = jest.fn();
    const mockOr = jest.fn();
    const mockIs = jest.fn();
    const mockFrom = jest.fn(() => ({
      select: mockSelect,
      order: mockOrder,
      eq: mockEq,
      or: mockOr,
      is: mockIs,
    }));
    const mockClient = {
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'admin-1',
              email: 'admin@vitana.se',
              app_metadata: { exafy_admin: true },
            },
          },
          error: null,
        }),
      },
    };
    mockedCreateUserSupabaseClient.mockReturnValue(mockClient);

    // mock the getSupabase() calls inside the handler: we already mocked @supabase/supabase-js createClient
    // The mock returns a chain that ends with .then. We need the GET / handler to resolve successfully.
    // We'll set up the mock chain to return an empty array.
    const { createClient } = require('@supabase/supabase-js');
    const fakeSupabaseClient = createClient();

    // Override the chain to return data on the final call
    // The actual handler uses await query, which calls .then under the hood.
    // Our mock's .then returns { data: [], error: null } by default, so it should work.
    // No additional setup needed.

    const res = await request(app)
      .get('/')
      .set('Authorization', 'Bearer valid-admin-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toBeDefined();
  });
});