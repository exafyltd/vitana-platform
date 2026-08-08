import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

// ---------------------------------------------------------------------------
// Mocks — the router auths via requireAuth/requireExafyAdmin middleware
// (auth-supabase-jwt), which verifies the JWT with jose against
// SUPABASE_JWT_SECRET and uses getSupabase() for all DB access.
// ---------------------------------------------------------------------------

// Per-table thenable query-chain mock for the service-role client
const createChain = () => {
  const responseQueue: any[] = [];
  let defaultData: any = { data: null, error: null };

  const chain: any = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    order: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    or: jest.fn(() => chain),
    is: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: (v: any) => any) => {
      const value = responseQueue.length > 0 ? responseQueue.shift() : defaultData;
      return Promise.resolve(value).then(resolve);
    }),
    mockResolvedValue(v: any) {
      defaultData = v;
      return chain;
    },
    mockResolvedValueOnce(v: any) {
      responseQueue.push(v);
      return chain;
    },
    mockReset() {
      responseQueue.length = 0;
      defaultData = { data: null, error: null };
    },
  };

  return chain;
};

const tableChains: Record<string, ReturnType<typeof createChain>> = {};
const chainFor = (table: string) => (tableChains[table] ??= createChain());

const mockSupabase = { from: jest.fn((table: string) => chainFor(table)) };
const mockGetSupabase = jest.fn(() => mockSupabase as any);

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

jest.mock('jose');

// Fire-and-forget active-day tracker invoked by requireAuth — keep it inert
jest.mock('../../src/services/guide/active-usage', () => ({
  upsertActiveDay: jest.fn().mockResolvedValue(undefined),
  countActiveUsageDays: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));

import router from '../../src/routes/admin-notification-categories';

const app = express();
app.use(express.json());
app.use('/', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_CLAIMS = {
  sub: 'admin-123',
  email: 'admin@example.com',
  app_metadata: { exafy_admin: true },
};

const NON_ADMIN_CLAIMS = {
  sub: 'user-123',
  email: 'test@example.com',
  app_metadata: { exafy_admin: false },
};

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
}

describe('Admin Notification Categories Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    // Default: unverifiable token
    mockInvalidJwt();
  });

  // --- Auth Middleware Tests ---

  it('should return 401 if no Authorization header is provided', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 401 if the token is invalid', async () => {
    mockInvalidJwt();

    const response = await request(app).get('/').set('Authorization', 'Bearer invalid-token');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('UNAUTHENTICATED');
  });

  it('should return 403 if the user is not an exafy_admin', async () => {
    mockVerifiedJwt(NON_ADMIN_CLAIMS);

    const response = await request(app).get('/').set('Authorization', 'Bearer valid-non-admin-token');
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('FORBIDDEN');
  });

  it('should allow access if the user is an exafy_admin', async () => {
    mockVerifiedJwt(ADMIN_CLAIMS);
    chainFor('notification_categories').mockResolvedValue({ data: [], error: null });

    const response = await request(app).get('/').set('Authorization', 'Bearer valid-admin-token');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toEqual({ chat: [], calendar: [], community: [] }); // Check handler response
    // Middleware verified the exact token from the Authorization header
    expect(jose.jwtVerify).toHaveBeenCalledWith(
      'valid-admin-token',
      expect.anything(),
      expect.objectContaining({ algorithms: ['HS256'] })
    );
  });

  it('GET / groups categories by type', async () => {
    mockVerifiedJwt(ADMIN_CLAIMS);
    const rows = [
      { id: '1', type: 'chat', slug: 'mentions' },
      { id: '2', type: 'calendar', slug: 'reminders' },
      { id: '3', type: 'chat', slug: 'replies' },
    ];
    chainFor('notification_categories').mockResolvedValue({ data: rows, error: null });

    const response = await request(app).get('/').set('Authorization', 'Bearer valid-admin-token');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(3);
    expect(response.body.data.chat).toHaveLength(2);
    expect(response.body.data.calendar).toHaveLength(1);
    expect(response.body.data.community).toHaveLength(0);
  });

  // --- Example handler test to confirm passthrough ---

  it('POST / should create a category for an admin user', async () => {
    mockVerifiedJwt({ ...ADMIN_CLAIMS, sub: 'admin-user-id' });

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

    const categoriesChain = chainFor('notification_categories');
    categoriesChain.mockResolvedValueOnce({ data: createdCategory, error: null });

    const response = await request(app)
      .post('/')
      .set('Authorization', 'Bearer valid-admin-token')
      .send(newCategory);

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toMatchObject(newCategory);
    expect(categoriesChain.insert).toHaveBeenCalledWith(expect.objectContaining({
      ...newCategory,
      slug: 'new_test_category',
      created_by: 'admin-user-id', // confirms user is passed from middleware
    }));
  });

  it('POST / should return 400 for a missing display_name', async () => {
    mockVerifiedJwt(ADMIN_CLAIMS);

    const response = await request(app)
      .post('/')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ type: 'chat' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('INVALID_INPUT');
  });

  it('POST / should return 409 on slug conflict', async () => {
    mockVerifiedJwt(ADMIN_CLAIMS);
    chainFor('notification_categories').mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    const response = await request(app)
      .post('/')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ type: 'chat', display_name: 'Mentions' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('SLUG_CONFLICT');
  });
});
