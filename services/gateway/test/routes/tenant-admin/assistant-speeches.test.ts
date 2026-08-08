/**
 * Tests for src/routes/tenant-admin/assistant-speeches.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/assistant/speeches
 *   GET    /            — list all speeches with effective text
 *   GET    /:speechKey  — single speech (default + tenant override)
 *   PUT    /:speechKey  — upsert tenant override { text }
 *   DELETE /:speechKey  — clear tenant override
 */
import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('jose');

const mockUserTenantsSingle = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: mockUserTenantsSingle,
          })),
        })),
      })),
    })),
  })),
}));

// Speeches service fully mocked — the router validates keys and delegates.
const mockGetSpeech = jest.fn();
const mockListSpeeches = jest.fn();
const mockUpsertTenantSpeech = jest.fn();
const mockResetTenantSpeech = jest.fn();
jest.mock('../../../src/services/assistant-speeches/service', () => ({
  isValidSpeechKey: (key: string) => ['orb_greeting', 'orb_farewell'].includes(key),
  getSpeech: (...args: any[]) => mockGetSpeech(...args),
  listSpeeches: (...args: any[]) => mockListSpeeches(...args),
  upsertTenantSpeech: (...args: any[]) => mockUpsertTenantSpeech(...args),
  resetTenantSpeech: (...args: any[]) => mockResetTenantSpeech(...args),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_URL = 'http://localhost:54321';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../../src/routes/tenant-admin/assistant-speeches').default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/assistant/speeches', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-aaaa-1111';
const TENANT_B = 'tenant-bbbb-2222';

const tenantAdminClaims = (tenantId: string) => ({
  sub: 'user-a',
  email: 'admin-a@example.com',
  app_metadata: { active_tenant_id: tenantId, exafy_admin: false },
});

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('bad signature'));
}

const url = (tenantId: string, tail = '') =>
  `/api/v1/admin/tenants/${tenantId}/assistant/speeches${tail}`;

const SPEECH = {
  speech_key: 'orb_greeting',
  default_text: 'Hello!',
  override_text: null,
  effective_text: 'Hello!',
  has_override: false,
};

describe('Tenant Assistant Speeches routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    mockInvalidJwt();
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });

    mockGetSpeech.mockReset().mockResolvedValue(SPEECH);
    mockListSpeeches.mockReset().mockResolvedValue([SPEECH]);
    mockUpsertTenantSpeech.mockReset().mockResolvedValue({ ok: true, speech: SPEECH });
    mockResetTenantSpeech.mockReset().mockResolvedValue({ ok: true, speech: SPEECH });
  });

  // --- Auth denial ---

  it('GET / returns 401 without a token', async () => {
    const res = await request(app).get(url(TENANT_A));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(mockListSpeeches).not.toHaveBeenCalled();
  });

  it('PUT /:speechKey returns 403 for a non-admin tenant member', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'member' }, error: null });

    const res = await request(app)
      .put(url(TENANT_A, '/orb_greeting'))
      .set('Authorization', 'Bearer t')
      .send({ text: 'Hi there' });

    expect(res.status).toBe(403);
    expect(mockUpsertTenantSpeech).not.toHaveBeenCalled();
  });

  // --- Tenant isolation ---

  it('tenant-A admin cannot override tenant-B speeches (403, no upsert)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .put(url(TENANT_B, '/orb_greeting'))
      .set('Authorization', 'Bearer t')
      .send({ text: 'Injected greeting' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockUpsertTenantSpeech).not.toHaveBeenCalled();
  });

  it('tenant-A admin cannot list tenant-B speeches (403, service never consulted)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app).get(url(TENANT_B)).set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(mockListSpeeches).not.toHaveBeenCalled();
  });

  // --- GET / ---

  it('GET / lists speeches for the caller tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app).get(url(TENANT_A)).set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ speeches: [SPEECH] });
    expect(mockListSpeeches).toHaveBeenCalledTimes(1);
    expect(mockListSpeeches).toHaveBeenCalledWith(TENANT_A);
  });

  it('GET / returns 500 when the service throws', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockListSpeeches.mockRejectedValue(new Error('db down'));

    const res = await request(app).get(url(TENANT_A)).set('Authorization', 'Bearer t');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

  // --- GET /:speechKey ---

  it('GET /:speechKey returns 400 for an unknown key', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(url(TENANT_A, '/not-a-key'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SPEECH_KEY');
    expect(mockGetSpeech).not.toHaveBeenCalled();
  });

  it('GET /:speechKey returns the speech for the caller tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(url(TENANT_A, '/orb_greeting'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(SPEECH);
    expect(mockGetSpeech).toHaveBeenCalledWith('orb_greeting', TENANT_A);
  });

  it('GET /:speechKey returns 404 when the speech is not registered', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSpeech.mockResolvedValue(null);

    const res = await request(app)
      .get(url(TENANT_A, '/orb_farewell'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SPEECH_NOT_FOUND');
  });

  // --- PUT /:speechKey ---

  it('PUT /:speechKey upserts the override for the caller tenant + user', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const updated = { ...SPEECH, override_text: 'Willkommen!', has_override: true };
    mockUpsertTenantSpeech.mockResolvedValue({ ok: true, speech: updated });

    const res = await request(app)
      .put(url(TENANT_A, '/orb_greeting'))
      .set('Authorization', 'Bearer t')
      .send({ text: 'Willkommen!' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
    expect(mockUpsertTenantSpeech).toHaveBeenCalledWith(
      TENANT_A,
      'orb_greeting',
      'Willkommen!',
      'user-a' // JWT sub
    );
  });

  it('PUT /:speechKey returns 400 EMPTY_TEXT for missing or blank text', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }]) {
      const res = await request(app)
        .put(url(TENANT_A, '/orb_greeting'))
        .set('Authorization', 'Bearer t')
        .send(body as any);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('EMPTY_TEXT');
    }
    expect(mockUpsertTenantSpeech).not.toHaveBeenCalled();
  });

  it('PUT /:speechKey returns 400 for an invalid key without upserting', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .put(url(TENANT_A, '/bogus'))
      .set('Authorization', 'Bearer t')
      .send({ text: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SPEECH_KEY');
    expect(mockUpsertTenantSpeech).not.toHaveBeenCalled();
  });

  it('PUT /:speechKey returns 500 when the service reports failure', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUpsertTenantSpeech.mockResolvedValue({ ok: false, error: 'WRITE_FAILED' });

    const res = await request(app)
      .put(url(TENANT_A, '/orb_greeting'))
      .set('Authorization', 'Bearer t')
      .send({ text: 'Hi' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'WRITE_FAILED' });
  });

  // --- DELETE /:speechKey ---

  it('DELETE /:speechKey resets the override for the caller tenant + user', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .delete(url(TENANT_A, '/orb_greeting'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(SPEECH);
    expect(mockResetTenantSpeech).toHaveBeenCalledWith(TENANT_A, 'orb_greeting', 'user-a');
  });

  it('DELETE /:speechKey cross-tenant is rejected (403, no reset)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .delete(url(TENANT_B, '/orb_greeting'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(mockResetTenantSpeech).not.toHaveBeenCalled();
  });

  it('DELETE /:speechKey returns 500 when the reset fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockResetTenantSpeech.mockResolvedValue({ ok: false, error: 'RESET_FAILED' });

    const res = await request(app)
      .delete(url(TENANT_A, '/orb_greeting'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'RESET_FAILED' });
  });
});
