/**
 * Tests for src/routes/voice-journey-context.ts (VTID-02909, B0c)
 *
 *   GET /api/v1/voice/journey-context/preview — requireAuthWithTenant + requireExafyAdmin
 *   GET /api/v1/voice/journey-context/state   — requireAuthWithTenant + requireExafyAdmin
 *
 * Both endpoints take userId/tenantId as query params and are gated on
 * global exafy_admin (not tenant-admin), by design ("expose sensitive
 * inferred context across tenants") — an admin may inspect ANY tenant, so
 * there is no per-tenant isolation check to assert here (that IS the
 * intended behavior, unlike the tenant-admin/* routes).
 */
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockIdentity: { user_id: string; exafy_admin: boolean } | null = null;

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: jest.fn((req: any, res: any, next: any) => {
    if (!mockIdentity) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    req.identity = mockIdentity;
    next();
  }),
  requireExafyAdmin: jest.fn((req: any, res: any, next: any) => {
    if (!req.identity?.exafy_admin) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    next();
  }),
}));

const mockCompileContext = jest.fn();
jest.mock('../../src/orb/context/context-compiler', () => ({
  compileContext: (...args: unknown[]) => mockCompileContext(...args),
}));

const mockParseClientContextEnvelope = jest.fn();
jest.mock('../../src/orb/context/client-context-envelope', () => ({
  parseClientContextEnvelope: (...args: unknown[]) => mockParseClientContextEnvelope(...args),
}));

const createChain = () => {
  const responseQueue: any[] = [];
  let defaultData: any = { data: null, error: null };
  const chain: any = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
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

const userAssistantStateChain = createChain();
let mockSupabaseClient: any = { from: jest.fn(() => userAssistantStateChain) };
const mockGetSupabase = jest.fn(() => mockSupabaseClient);
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

import router from '../../src/routes/voice-journey-context';

const app = express();
app.use(express.json());
app.use('/api/v1', router);

const ADMIN_IDENTITY = { user_id: 'admin-1', exafy_admin: true };
const NON_ADMIN_IDENTITY = { user_id: 'user-1', exafy_admin: false };
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity = null;
  userAssistantStateChain.mockReset();
  mockSupabaseClient = { from: jest.fn(() => userAssistantStateChain) };
  mockGetSupabase.mockReturnValue(mockSupabaseClient);
});

// ---------------------------------------------------------------------------
// GET /api/v1/voice/journey-context/preview
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice/journey-context/preview', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get(`/api/v1/voice/journey-context/preview?userId=${USER_ID}&tenantId=${TENANT_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin caller', async () => {
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).get(`/api/v1/voice/journey-context/preview?userId=${USER_ID}&tenantId=${TENANT_ID}`);
    expect(res.status).toBe(403);
    expect(mockCompileContext).not.toHaveBeenCalled();
  });

  it('returns 400 when userId is missing', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app).get(`/api/v1/voice/journey-context/preview?tenantId=${TENANT_ID}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('userId and tenantId are required');
  });

  it('returns 400 when tenantId is missing', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app).get(`/api/v1/voice/journey-context/preview?userId=${USER_ID}`);
    expect(res.status).toBe(400);
  });

  it('compiles with a null envelope when none is supplied', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockCompileContext.mockResolvedValue({ compiled: { a: 1 }, decision: { kind: 'none' }, diagnostics: {} });

    const res = await request(app).get(`/api/v1/voice/journey-context/preview?userId=${USER_ID}&tenantId=${TENANT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      vtid: 'VTID-02909',
      compiled: { a: 1 },
      decision: { kind: 'none' },
      diagnostics: {},
    });
    expect(mockCompileContext).toHaveBeenCalledWith({ userId: USER_ID, tenantId: TENANT_ID, envelope: null });
    expect(mockParseClientContextEnvelope).not.toHaveBeenCalled();
  });

  it('parses and forwards a valid envelope query param', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const envelope = { surface: 'orb' };
    mockParseClientContextEnvelope.mockReturnValue({ ok: true, envelope });
    mockCompileContext.mockResolvedValue({ compiled: {}, decision: {}, diagnostics: {} });

    const res = await request(app)
      .get(`/api/v1/voice/journey-context/preview?userId=${USER_ID}&tenantId=${TENANT_ID}`)
      .query({ envelope: JSON.stringify({ surface: 'orb' }) });

    expect(res.status).toBe(200);
    expect(mockCompileContext).toHaveBeenCalledWith({ userId: USER_ID, tenantId: TENANT_ID, envelope });
  });

  it('falls back to a null envelope when the guard rejects it', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockParseClientContextEnvelope.mockReturnValue({ ok: false, error: 'bad shape' });
    mockCompileContext.mockResolvedValue({ compiled: {}, decision: {}, diagnostics: {} });

    await request(app)
      .get(`/api/v1/voice/journey-context/preview?userId=${USER_ID}&tenantId=${TENANT_ID}`)
      .query({ envelope: JSON.stringify({ bogus: true }) });

    expect(mockCompileContext).toHaveBeenCalledWith({ userId: USER_ID, tenantId: TENANT_ID, envelope: null });
  });

  it('falls back to a null envelope when the envelope query param is not valid JSON', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockCompileContext.mockResolvedValue({ compiled: {}, decision: {}, diagnostics: {} });

    await request(app)
      .get(`/api/v1/voice/journey-context/preview?userId=${USER_ID}&tenantId=${TENANT_ID}`)
      .query({ envelope: '{not-json' });

    expect(mockCompileContext).toHaveBeenCalledWith({ userId: USER_ID, tenantId: TENANT_ID, envelope: null });
    expect(mockParseClientContextEnvelope).not.toHaveBeenCalled();
  });

  it('returns 500 when compileContext throws', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockCompileContext.mockRejectedValue(new Error('compiler crashed'));
    const res = await request(app).get(`/api/v1/voice/journey-context/preview?userId=${USER_ID}&tenantId=${TENANT_ID}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('compiler crashed');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/voice/journey-context/state
// ---------------------------------------------------------------------------
describe('GET /api/v1/voice/journey-context/state', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get(`/api/v1/voice/journey-context/state?userId=${USER_ID}&tenantId=${TENANT_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin caller', async () => {
    mockIdentity = NON_ADMIN_IDENTITY;
    const res = await request(app).get(`/api/v1/voice/journey-context/state?userId=${USER_ID}&tenantId=${TENANT_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns 400 when userId/tenantId are missing', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const res = await request(app).get('/api/v1/voice/journey-context/state');
    expect(res.status).toBe(400);
  });

  it('returns an empty result with source_health when Supabase is unconfigured', async () => {
    mockIdentity = ADMIN_IDENTITY;
    mockGetSupabase.mockReturnValue(null);

    const res = await request(app).get(`/api/v1/voice/journey-context/state?userId=${USER_ID}&tenantId=${TENANT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      vtid: 'VTID-02909',
      rows: [],
      source_health: { user_assistant_state: { available: false, reason: 'supabase_unconfigured' } },
    });
  });

  it('returns durable signal rows scoped to the given tenant + user', async () => {
    mockIdentity = ADMIN_IDENTITY;
    const rows = [{ signal_name: 'onboarding_stage', value: 'complete' }];
    userAssistantStateChain.mockResolvedValueOnce({ data: rows, error: null });

    const res = await request(app).get(`/api/v1/voice/journey-context/state?userId=${USER_ID}&tenantId=${TENANT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      vtid: 'VTID-02909',
      rows,
      source_health: { user_assistant_state: { available: true } },
    });
    expect(userAssistantStateChain.eq).toHaveBeenCalledWith('tenant_id', TENANT_ID);
    expect(userAssistantStateChain.eq).toHaveBeenCalledWith('user_id', USER_ID);
  });

  it('returns 500 when the query errors', async () => {
    mockIdentity = ADMIN_IDENTITY;
    userAssistantStateChain.mockResolvedValueOnce({ data: null, error: { message: 'query failed' } });
    const res = await request(app).get(`/api/v1/voice/journey-context/state?userId=${USER_ID}&tenantId=${TENANT_ID}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('query failed');
  });
});
