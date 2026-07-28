/**
 * Tests for src/routes/tenant-admin/assistant-config.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/assistant
 *   GET    /             — all surfaces (global + tenant override + effective)
 *   GET    /:surfaceKey  — single surface detail
 *   PUT    /:surfaceKey  — upsert tenant override
 *   DELETE /:surfaceKey  — remove tenant override (tenant_id-scoped delete)
 */
import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
    in: jest.fn(() => chain),
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

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

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

// Personality service is fully mocked — the router only orchestrates it.
const mockGetPersonalityConfig = jest.fn();
const mockGetEffectiveConfig = jest.fn();
const mockGetTenantAssistantConfig = jest.fn();
const mockUpsertTenantAssistantConfig = jest.fn();
jest.mock('../../../src/services/ai-personality-service', () => ({
  VALID_SURFACE_KEYS: ['orb_voice', 'operator_console'],
  getPersonalityConfig: (...args: any[]) => mockGetPersonalityConfig(...args),
  getEffectiveConfig: (...args: any[]) => mockGetEffectiveConfig(...args),
  getTenantAssistantConfig: (...args: any[]) => mockGetTenantAssistantConfig(...args),
  upsertTenantAssistantConfig: (...args: any[]) => mockUpsertTenantAssistantConfig(...args),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_URL = 'http://localhost:54321';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../../src/routes/tenant-admin/assistant-config').default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/assistant', router);

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
  `/api/v1/admin/tenants/${tenantId}/assistant${tail}`;

const GLOBAL_CONFIG = {
  defaults: { tone: 'warm' },
  config: { tone: 'warm' },
  is_customized: false,
};

describe('Tenant Assistant Config routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockInvalidJwt();
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });

    mockGetPersonalityConfig.mockReset().mockResolvedValue(GLOBAL_CONFIG);
    mockGetEffectiveConfig.mockReset().mockResolvedValue({ tone: 'warm' });
    mockGetTenantAssistantConfig.mockReset().mockResolvedValue(null);
    mockUpsertTenantAssistantConfig.mockReset().mockResolvedValue({ ok: true });
  });

  // --- Auth denial ---

  it('GET / returns 401 without a token', async () => {
    const res = await request(app).get(url(TENANT_A));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('PUT /:surfaceKey returns 403 for a non-admin tenant member', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'member' }, error: null });

    const res = await request(app)
      .put(url(TENANT_A, '/orb_voice'))
      .set('Authorization', 'Bearer t')
      .send({ system_prompt_override: 'be nice' });

    expect(res.status).toBe(403);
    expect(mockUpsertTenantAssistantConfig).not.toHaveBeenCalled();
  });

  // --- Tenant isolation ---

  it('tenant-A admin cannot write tenant-B assistant config (403, no upsert)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .put(url(TENANT_B, '/orb_voice'))
      .set('Authorization', 'Bearer t')
      .send({ system_prompt_override: 'evil override' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockUpsertTenantAssistantConfig).not.toHaveBeenCalled();
  });

  it('tenant-A admin cannot read tenant-B assistant config (403, service never consulted)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(url(TENANT_B))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(mockGetTenantAssistantConfig).not.toHaveBeenCalled();
    expect(mockGetEffectiveConfig).not.toHaveBeenCalled();
  });

  it('DELETE scopes the tenant_assistant_config delete to the caller tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_assistant_config').mockResolvedValue({ error: null });

    const res = await request(app)
      .delete(url(TENANT_A, '/orb_voice'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const chain = chainFor('tenant_assistant_config');
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chain.eq).toHaveBeenCalledWith('surface_key', 'orb_voice');
  });

  // --- GET / ---

  it('GET / lists every surface with global, override, and effective config for the tenant', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetTenantAssistantConfig.mockImplementation(
      async (_tenantId: string, surfaceKey: string) =>
        surfaceKey === 'orb_voice' ? { system_prompt_override: 'custom' } : null
    );

    const res = await request(app).get(url(TENANT_A)).set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.surfaces).toHaveLength(2);

    const orbVoice = res.body.surfaces.find((s: any) => s.surface_key === 'orb_voice');
    expect(orbVoice.has_tenant_override).toBe(true);
    expect(orbVoice.tenant_override).toEqual({ system_prompt_override: 'custom' });
    const console_ = res.body.surfaces.find((s: any) => s.surface_key === 'operator_console');
    expect(console_.has_tenant_override).toBe(false);

    // Every service call was made for the caller's tenant only
    for (const call of mockGetTenantAssistantConfig.mock.calls) {
      expect(call[0]).toBe(TENANT_A);
    }
    for (const call of mockGetEffectiveConfig.mock.calls) {
      expect(call[1]).toBe(TENANT_A);
    }
  });

  // --- GET /:surfaceKey ---

  it('GET /:surfaceKey returns 400 for an unknown surface key', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(url(TENANT_A, '/not-a-surface'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SURFACE_KEY');
    expect(mockGetPersonalityConfig).not.toHaveBeenCalled();
  });

  it('GET /:surfaceKey returns the single-surface detail', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetTenantAssistantConfig.mockResolvedValue({ voice_config_override: { speed: 1.2 } });
    mockGetEffectiveConfig.mockResolvedValue({ tone: 'warm', speed: 1.2 });

    const res = await request(app)
      .get(url(TENANT_A, '/operator_console'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      surface_key: 'operator_console',
      global_defaults: GLOBAL_CONFIG.defaults,
      global_config: GLOBAL_CONFIG.config,
      tenant_override: { voice_config_override: { speed: 1.2 } },
      effective_config: { tone: 'warm', speed: 1.2 },
      has_tenant_override: true,
    });
    expect(mockGetTenantAssistantConfig).toHaveBeenCalledWith(TENANT_A, 'operator_console');
  });

  // --- PUT /:surfaceKey ---

  it('PUT /:surfaceKey upserts only the provided override fields for the caller tenant + user', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetEffectiveConfig.mockResolvedValue({ tone: 'edgy' });

    const res = await request(app)
      .put(url(TENANT_A, '/orb_voice'))
      .set('Authorization', 'Bearer t')
      .send({ system_prompt_override: 'be edgy', extra_config: { a: 1 } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, effective_config: { tone: 'edgy' } });
    expect(mockUpsertTenantAssistantConfig).toHaveBeenCalledWith(
      TENANT_A,
      'orb_voice',
      { system_prompt_override: 'be edgy', extra_config: { a: 1 } },
      'user-a' // JWT sub — attributes the change to the authenticated admin
    );
    // Fields not sent must not appear in the update payload
    const updates = mockUpsertTenantAssistantConfig.mock.calls[0][2];
    expect(updates).not.toHaveProperty('voice_config_override');
    expect(updates).not.toHaveProperty('tool_overrides');
    expect(updates).not.toHaveProperty('model_routing_override');
  });

  it('PUT /:surfaceKey returns 400 for an invalid surface key without upserting', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .put(url(TENANT_A, '/bogus'))
      .set('Authorization', 'Bearer t')
      .send({ system_prompt_override: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SURFACE_KEY');
    expect(mockUpsertTenantAssistantConfig).not.toHaveBeenCalled();
  });

  it('PUT /:surfaceKey returns 500 when the upsert fails', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockUpsertTenantAssistantConfig.mockResolvedValue({ ok: false, error: 'DB_WRITE_FAILED' });

    const res = await request(app)
      .put(url(TENANT_A, '/orb_voice'))
      .set('Authorization', 'Bearer t')
      .send({ system_prompt_override: 'x' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'DB_WRITE_FAILED' });
  });

  // --- DELETE /:surfaceKey ---

  it('DELETE /:surfaceKey returns 400 for an invalid surface key without deleting', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .delete(url(TENANT_A, '/bogus'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SURFACE_KEY');
    expect(chainFor('tenant_assistant_config').delete).not.toHaveBeenCalled();
  });

  it('DELETE /:surfaceKey returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .delete(url(TENANT_A, '/orb_voice'))
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });
});
