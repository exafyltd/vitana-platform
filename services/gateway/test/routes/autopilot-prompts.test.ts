/**
 * Tests for src/routes/autopilot-prompts.ts (VTID-01089)
 *
 * This router does NOT use the shared requireAuth/requireExafyAdmin
 * middleware (unlike admin-notification-categories / admin-autopilot). It
 * implements its own inline `getUserContext(req)`:
 *   1. No Bearer token -> { ok:false, error:'UNAUTHENTICATED' }
 *   2. createUserSupabaseClient(token).rpc('me_context') succeeds with a row
 *      -> tenant_id = data.tenant_id || x-tenant-id header || Maxina default;
 *         user_id = data.user_id || data.id
 *   3. rpc('me_context') errors -> falls back to supabase.auth.getUser():
 *      - getUser also fails/no user -> { ok:false, error:'Failed to get user context' }
 *      - getUser succeeds -> tenant_id = x-tenant-id header || Maxina default;
 *        user_id = authData.user.id
 *   4. Any thrown exception -> caught, { ok:false, error:'Failed to get user context' }
 *
 * All five business-logic endpoints call getUserContext first and 401 with
 * `{ ok:false, error }` when it fails. The route layer itself is otherwise a
 * thin adapter: Zod-validate body -> call the mocked service -> map the
 * service's { ok } to an HTTP status. The service module
 * (autopilot-prompts-service) is mocked wholesale since it is out of scope
 * for this file.
 */

import request from 'supertest';
import express from 'express';

const MAXINA_DEFAULT_TENANT = '11111111-1111-1111-1111-111111111111';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRpc = jest.fn();
const mockGetUser = jest.fn();
const mockCreateUserSupabaseClient = jest.fn(() => ({
  rpc: mockRpc,
  auth: { getUser: mockGetUser },
}));

jest.mock('../../src/lib/supabase-user', () => ({
  createUserSupabaseClient: (token: string) => mockCreateUserSupabaseClient(token),
}));

const mockGetPromptPrefs = jest.fn();
const mockUpdatePromptPrefs = jest.fn();
const mockGeneratePrompts = jest.fn();
const mockGetTodayPrompts = jest.fn();
const mockExecutePromptAction = jest.fn();

jest.mock('../../src/services/autopilot-prompts-service', () => ({
  getPromptPrefs: (...args: any[]) => mockGetPromptPrefs(...args),
  updatePromptPrefs: (...args: any[]) => mockUpdatePromptPrefs(...args),
  generatePrompts: (...args: any[]) => mockGeneratePrompts(...args),
  getTodayPrompts: (...args: any[]) => mockGetTodayPrompts(...args),
  executePromptAction: (...args: any[]) => mockExecutePromptAction(...args),
}));

import router from '../../src/routes/autopilot-prompts';

const app = express();
app.use(express.json());
app.use('/', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockMeContextOk(tenant_id: string, user_id: string) {
  mockRpc.mockResolvedValue({ data: { tenant_id, user_id }, error: null });
}

function mockMeContextError() {
  mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc down' } });
}

function mockAuthGetUserOk(userId: string) {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
}

function mockAuthGetUserFail() {
  mockGetUser.mockResolvedValue({ data: null, error: { message: 'no session' } });
}

const AUTH_HEADER = { Authorization: 'Bearer valid-token' };

beforeEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// getUserContext auth gate — exercised once via GET /prefs, applies to all
// =============================================================================

describe('auth gate (getUserContext) — GET /prefs as the representative endpoint', () => {
  it('401s with UNAUTHENTICATED when no Authorization header is present', async () => {
    const res = await request(app).get('/prefs');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    expect(mockCreateUserSupabaseClient).not.toHaveBeenCalled();
  });

  it('401s with UNAUTHENTICATED when the Authorization header is not a Bearer token', async () => {
    const res = await request(app).get('/prefs').set('Authorization', 'Basic abc123');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('uses me_context tenant_id/user_id when the RPC succeeds', async () => {
    mockMeContextOk('tenant-rpc', 'user-rpc');
    mockGetPromptPrefs.mockResolvedValue({ ok: true, prefs: { enabled: true } });

    const res = await request(app).get('/prefs').set(AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(mockGetPromptPrefs).toHaveBeenCalledWith('tenant-rpc', 'user-rpc');
  });

  it('me_context tenant_id wins over an x-tenant-id header when both are present', async () => {
    mockMeContextOk('tenant-from-rpc', 'user-rpc');
    mockGetPromptPrefs.mockResolvedValue({ ok: true, prefs: {} });

    await request(app)
      .get('/prefs')
      .set(AUTH_HEADER)
      .set('x-tenant-id', 'tenant-from-header');

    expect(mockGetPromptPrefs).toHaveBeenCalledWith('tenant-from-rpc', 'user-rpc');
  });

  it('falls back to auth.getUser() when me_context RPC errors, using the x-tenant-id header', async () => {
    mockMeContextError();
    mockAuthGetUserOk('user-from-auth');
    mockGetPromptPrefs.mockResolvedValue({ ok: true, prefs: {} });

    await request(app)
      .get('/prefs')
      .set(AUTH_HEADER)
      .set('x-tenant-id', 'tenant-from-header');

    expect(mockGetPromptPrefs).toHaveBeenCalledWith('tenant-from-header', 'user-from-auth');
  });

  it('falls back to the Maxina default tenant when me_context errors and no x-tenant-id header is sent', async () => {
    mockMeContextError();
    mockAuthGetUserOk('user-from-auth');
    mockGetPromptPrefs.mockResolvedValue({ ok: true, prefs: {} });

    await request(app).get('/prefs').set(AUTH_HEADER);

    expect(mockGetPromptPrefs).toHaveBeenCalledWith(MAXINA_DEFAULT_TENANT, 'user-from-auth');
  });

  it('401s with "Failed to get user context" when both me_context and auth.getUser fail', async () => {
    mockMeContextError();
    mockAuthGetUserFail();

    const res = await request(app).get('/prefs').set(AUTH_HEADER);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'Failed to get user context' });
    expect(mockGetPromptPrefs).not.toHaveBeenCalled();
  });

  it('401s with "Failed to get user context" when an exception is thrown building the client', async () => {
    mockCreateUserSupabaseClient.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const res = await request(app).get('/prefs').set(AUTH_HEADER);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'Failed to get user context' });
  });

  it('401s when me_context resolves but yields no usable user_id', async () => {
    mockRpc.mockResolvedValue({ data: { tenant_id: 'tenant-x' }, error: null }); // no user_id, no id
    const res = await request(app).get('/prefs').set(AUTH_HEADER);

    expect(res.status).toBe(401);
    expect(mockGetPromptPrefs).not.toHaveBeenCalled();
  });

  it('falls back to data.id when me_context has no user_id field', async () => {
    mockRpc.mockResolvedValue({ data: { tenant_id: 'tenant-x', id: 'user-via-id-field' }, error: null });
    mockGetPromptPrefs.mockResolvedValue({ ok: true, prefs: {} });

    await request(app).get('/prefs').set(AUTH_HEADER);

    expect(mockGetPromptPrefs).toHaveBeenCalledWith('tenant-x', 'user-via-id-field');
  });
});

// All other endpoints reuse getUserContext; a single 401 smoke check each is
// enough to confirm the gate is wired in, without repeating the full matrix.
describe('auth gate applies to every business endpoint', () => {
  const cases: Array<[string, string, any]> = [
    ['get', '/prefs', {}],
    ['post', '/prefs', {}],
    ['get', '/prompts/today', {}],
    ['post', '/prompts/generate', {}],
    ['post', '/prompts/p1/action', { action: 'yes' }],
  ];

  it.each(cases)('%s %s -> 401 without a token', async (method, url, body) => {
    const res = await (request(app) as any)[method](url).send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });
});

// =============================================================================
// GET /prefs
// =============================================================================

describe('GET /prefs', () => {
  beforeEach(() => mockMeContextOk('tenant-1', 'user-1'));

  it('returns the service result on success', async () => {
    const prefs = { id: 'p1', enabled: true, max_prompts_per_day: 5 };
    mockGetPromptPrefs.mockResolvedValue({ ok: true, prefs });

    const res = await request(app).get('/prefs').set(AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, prefs });
  });

  it('returns 500 when the service reports failure', async () => {
    mockGetPromptPrefs.mockResolvedValue({ ok: false, error: 'db exploded' });

    const res = await request(app).get('/prefs').set(AUTH_HEADER);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'db exploded' });
  });

  it('falls back to a generic error message when the service omits one', async () => {
    mockGetPromptPrefs.mockResolvedValue({ ok: false });

    const res = await request(app).get('/prefs').set(AUTH_HEADER);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to get preferences');
  });
});

// =============================================================================
// POST /prefs
// =============================================================================

describe('POST /prefs', () => {
  beforeEach(() => mockMeContextOk('tenant-1', 'user-1'));

  it('validates the body and forwards parsed data to the service', async () => {
    mockUpdatePromptPrefs.mockResolvedValue({ ok: true, prefs: { enabled: false } });

    const res = await request(app)
      .post('/prefs')
      .set(AUTH_HEADER)
      .send({ enabled: false, max_prompts_per_day: 3 });

    expect(res.status).toBe(200);
    expect(mockUpdatePromptPrefs).toHaveBeenCalledWith('tenant-1', 'user-1', {
      enabled: false,
      max_prompts_per_day: 3,
    });
  });

  it('400s with details when max_prompts_per_day is out of range', async () => {
    const res = await request(app)
      .post('/prefs')
      .set(AUTH_HEADER)
      .send({ max_prompts_per_day: 999 });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toEqual(expect.stringContaining('max_prompts_per_day'));
    expect(mockUpdatePromptPrefs).not.toHaveBeenCalled();
  });

  it('400s when quiet_hours has a malformed time string', async () => {
    const res = await request(app)
      .post('/prefs')
      .set(AUTH_HEADER)
      .send({ quiet_hours: { from: '25:99', to: '08:00' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('400s when allow_types contains an unknown match type', async () => {
    const res = await request(app)
      .post('/prefs')
      .set(AUTH_HEADER)
      .send({ allow_types: ['person', 'not_a_type'] });

    expect(res.status).toBe(400);
  });

  it('returns 500 when the service update fails', async () => {
    mockUpdatePromptPrefs.mockResolvedValue({ ok: false, error: 'update failed' });

    const res = await request(app).post('/prefs').set(AUTH_HEADER).send({ enabled: true });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('update failed');
  });
});

// =============================================================================
// GET /prompts/today
// =============================================================================

describe('GET /prompts/today', () => {
  beforeEach(() => mockMeContextOk('tenant-1', 'user-1'));

  it('returns prompts and rate_limit_info on success', async () => {
    const payload = {
      ok: true,
      prompts: [{ id: 'pr1' }],
      rate_limit_info: { max_per_day: 5, used_today: 1, remaining: 4, in_quiet_hours: false },
    };
    mockGetTodayPrompts.mockResolvedValue(payload);

    const res = await request(app).get('/prompts/today').set(AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(mockGetTodayPrompts).toHaveBeenCalledWith('tenant-1', 'user-1');
  });

  it('returns 500 when the service reports failure', async () => {
    mockGetTodayPrompts.mockResolvedValue({ ok: false, error: 'lookup failed' });

    const res = await request(app).get('/prompts/today').set(AUTH_HEADER);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('lookup failed');
  });
});

// =============================================================================
// POST /prompts/generate
// =============================================================================

describe('POST /prompts/generate', () => {
  beforeEach(() => mockMeContextOk('tenant-1', 'user-1'));

  it('applies Zod defaults when the body is empty', async () => {
    mockGeneratePrompts.mockResolvedValue({ ok: true, generated: 0, prompts: [] });

    const res = await request(app).post('/prompts/generate').set(AUTH_HEADER).send();

    expect(res.status).toBe(200);
    expect(mockGeneratePrompts).toHaveBeenCalledWith('tenant-1', 'user-1', {
      score_threshold: 75,
      limit: 5,
    });
  });

  it('forwards explicit overrides', async () => {
    mockGeneratePrompts.mockResolvedValue({ ok: true, generated: 2, prompts: [] });

    await request(app)
      .post('/prompts/generate')
      .set(AUTH_HEADER)
      .send({ score_threshold: 90, limit: 2 });

    expect(mockGeneratePrompts).toHaveBeenCalledWith('tenant-1', 'user-1', {
      score_threshold: 90,
      limit: 2,
    });
  });

  it('400s when limit exceeds the max of 10', async () => {
    const res = await request(app)
      .post('/prompts/generate')
      .set(AUTH_HEADER)
      .send({ limit: 50 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(mockGeneratePrompts).not.toHaveBeenCalled();
  });

  it('400s when score_threshold is out of the 0-100 range', async () => {
    const res = await request(app)
      .post('/prompts/generate')
      .set(AUTH_HEADER)
      .send({ score_threshold: 150 });

    expect(res.status).toBe(400);
  });

  it('returns 500 when generation fails', async () => {
    mockGeneratePrompts.mockResolvedValue({ ok: false, error: 'generation failed' });

    const res = await request(app).post('/prompts/generate').set(AUTH_HEADER).send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('generation failed');
  });
});

// =============================================================================
// POST /prompts/:id/action
// =============================================================================

describe('POST /prompts/:id/action', () => {
  beforeEach(() => mockMeContextOk('tenant-1', 'user-1'));

  it('forwards the prompt id and validated action to the service', async () => {
    mockExecutePromptAction.mockResolvedValue({
      ok: true,
      prompt_id: 'prompt-123',
      action: 'yes',
      new_state: 'accepted',
    });

    const res = await request(app)
      .post('/prompts/prompt-123/action')
      .set(AUTH_HEADER)
      .send({ action: 'yes' });

    expect(res.status).toBe(200);
    expect(mockExecutePromptAction).toHaveBeenCalledWith('tenant-1', 'user-1', 'prompt-123', { action: 'yes' });
    expect(res.body.new_state).toBe('accepted');
  });

  it('400s when action is not one of yes|not_now|options', async () => {
    const res = await request(app)
      .post('/prompts/prompt-123/action')
      .set(AUTH_HEADER)
      .send({ action: 'maybe_later' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(mockExecutePromptAction).not.toHaveBeenCalled();
  });

  it('400s when action is missing entirely', async () => {
    const res = await request(app)
      .post('/prompts/prompt-123/action')
      .set(AUTH_HEADER)
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 404 specifically when the service reports "Prompt not found"', async () => {
    mockExecutePromptAction.mockResolvedValue({ ok: false, error: 'Prompt not found' });

    const res = await request(app)
      .post('/prompts/missing-id/action')
      .set(AUTH_HEADER)
      .send({ action: 'not_now' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'Prompt not found' });
  });

  it('returns 500 for any other service failure', async () => {
    mockExecutePromptAction.mockResolvedValue({ ok: false, error: 'action execution failed' });

    const res = await request(app)
      .post('/prompts/prompt-123/action')
      .set(AUTH_HEADER)
      .send({ action: 'options' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('action execution failed');
  });
});

// =============================================================================
// GET /prompts/health — no auth required
// =============================================================================

describe('GET /prompts/health', () => {
  it('returns a healthy status with capabilities, requiring no Authorization header', async () => {
    const res = await request(app).get('/prompts/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('autopilot-prompts');
    expect(res.body.vtid).toBe('VTID-01089');
    expect(res.body.status).toBe('healthy');
    expect(res.body.capabilities).toEqual({
      prompts: true,
      preferences: true,
      rate_limits: true,
      quiet_hours: true,
      oasis_events: true,
    });
    expect(typeof res.body.timestamp).toBe('string');
    expect(mockCreateUserSupabaseClient).not.toHaveBeenCalled();
  });
});
