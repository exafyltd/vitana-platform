import request from 'supertest';
import express, { Router } from 'express';
import { createClient } from '@supabase/supabase-js';

// Mock external modules
jest.mock('../../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn(),
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn(),
  NotificationPayload: jest.fn(),
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

// Import the router (must be after mocks)
const routerModule = require('../../src/routes/admin-notification-categories').default;

describe('Admin Notification Categories - Auth Middleware', () => {
  let app: express.Express;
  let mockSupabaseClient: any;
  let mockCreateUserClient: jest.Mock;

  beforeAll(() => {
    // Create a minimal express app with just the router
    app = express();
    app.use(express.json());
    app.use('/', routerModule);

    // Setup createClient mock
    mockSupabaseClient = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
    };
    (createClient as jest.Mock).mockReturnValue(mockSupabaseClient);

    mockCreateUserClient = require('../../src/lib/supabase-user').createUserSupabaseClient as jest.Mock;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should return 401 if no Bearer token is provided', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  test('should return 403 if token is valid but user is not exafy_admin', async () => {
    const fakeUserClient = {
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: 'user-123', email: 'user@test.com', app_metadata: { exafy_admin: false } } },
          error: null,
        }),
      },
    };
    mockCreateUserClient.mockReturnValue(fakeUserClient);

    const res = await request(app)
      .get('/')
      .set('Authorization', 'Bearer fake-token');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  test('should pass middleware and reach handler when admin token is valid', async () => {
    const fakeUserClient = {
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: 'admin-1', email: 'admin@test.com', app_metadata: { exafy_admin: true } } },
          error: null,
        }),
      },
    };
    mockCreateUserClient.mockReturnValue(fakeUserClient);

    // Mock getSupabase to return data for the GET / handler
    const mockFrom = jest.fn().mockReturnThis();
    const mockSelect = jest.fn().mockReturnThis();
    const mockOrder = jest.fn().mockReturnThis();
    const mockEq = jest.fn().mockReturnThis();
    const mockOr = jest.fn().mockReturnThis();
    const mockIs = jest.fn().mockReturnThis();
    const mockLimit = jest.fn().mockReturnThis();
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: null });

    mockSupabaseClient.from = mockFrom;
    mockSupabaseClient.select = mockSelect;
    mockSupabaseClient.order = mockOrder;
    mockSupabaseClient.eq = mockEq;
    mockSupabaseClient.or = mockOr;
    mockSupabaseClient.is = mockIs;
    mockSupabaseClient.limit = mockLimit;
    mockSupabaseClient.single = mockSingle;

    // For GET / we need the query to resolve with an empty list
    mockSelect.mockResolvedValue({ data: [], error: null });

    const res = await request(app)
      .get('/')
      .set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ chat: [], calendar: [], community: [] });
    expect(res.body.total).toBe(0);
  });
});