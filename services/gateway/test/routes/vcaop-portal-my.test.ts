/**
 * VCAOP merchant self-service portal — /my surface (VTID-03553).
 *
 * The load-bearing assertions are the OWNERSHIP ones: every read filters on
 * partner_tenant.owner_user_id = the caller, creation stamps ownership from
 * the JWT (never the body), and the platform's one-approval activation
 * endpoint does not exist on this surface at all.
 */
import express, { NextFunction, Response } from 'express';
import request from 'supertest';
import vcaopPortalMyRouter from '../../src/routes/vcaop-portal-my';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';
import { detectPlatform } from '../../src/services/platform-detect';
import { discoverSmartConfiguration } from '../../src/services/smart-fhir-oauth';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn() }));
jest.mock('../../src/services/platform-detect', () => ({ detectPlatform: jest.fn() }));
// Only discovery is mocked (it makes a real network call); state
// signing/URL-building stay real, same treatment shopify-oauth gets below —
// those are deterministic pure functions worth exercising for real.
jest.mock('../../src/services/smart-fhir-oauth', () => ({
  ...jest.requireActual('../../src/services/smart-fhir-oauth'),
  discoverSmartConfiguration: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/api/v1/vcaop/portal/my', vcaopPortalMyRouter);

const asMerchant = (id = 'merchant-1', email: string | null = 'owner@example.test') =>
  (requireAuth as jest.Mock).mockImplementation((req: any, _res: Response, next: NextFunction) => {
    req.identity = { user_id: id, tenant_id: 'platform', email, exafy_admin: false };
    next();
  });

/** Chainable Supabase query stub that records every eq() filter applied. */
function tableStub(result: { data?: any; error?: any }) {
  const filters: Record<string, unknown> = {};
  const chain: any = {
    filters,
    select: jest.fn(() => chain),
    insert: jest.fn(() => Promise.resolve({ error: null })),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn((col: string, val: unknown) => { filters[col] = val; return chain; }),
    is: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve({ data: result.data ?? null, error: result.error ?? null })),
    then: (resolve: any) => resolve({ data: result.data ?? null, error: result.error ?? null }),
  };
  return chain;
}

beforeEach(() => jest.clearAllMocks());

describe('ownership scoping', () => {
  test('GET /connections filters on partner_tenant.owner_user_id = the caller', async () => {
    asMerchant('merchant-1');
    const manifests = tableStub({ data: [] });
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => manifests) });
    const res = await request(app).get('/api/v1/vcaop/portal/my/connections');
    expect(res.status).toBe(200);
    expect(manifests.filters['partner_tenant.owner_user_id']).toBe('merchant-1');
  });

  test('a connection owned by someone else reads as 404, not 403', async () => {
    asMerchant('merchant-2');
    const manifests = tableStub({ data: null }); // owner filter excludes the row
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => manifests) });
    const res = await request(app).get('/api/v1/vcaop/portal/my/connections/some-id');
    expect(res.status).toBe(404);
    expect(manifests.filters['partner_tenant.owner_user_id']).toBe('merchant-2');
  });

  test('create stamps owner_user_id + owner_email from the JWT, never the body', async () => {
    asMerchant('merchant-3', 'real@owner.test');
    const inserted: any[] = [];
    const partnerLookup = tableStub({ data: null });
    const tables: Record<string, any> = {
      partner_tenant: {
        ...partnerLookup,
        insert: jest.fn((row: any) => { inserted.push(row); return Promise.resolve({ error: null }); }),
      },
      integration_manifest: { insert: jest.fn(() => Promise.resolve({ error: null })) },
      oasis_events: { insert: jest.fn(() => Promise.resolve({ error: null })) },
    };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn((t: string) => tables[t] ?? tableStub({})) });
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections').send({
      name: 'My Shop', connector_id: 'shopify', provider_id: 'shopify',
      owner_user_id: 'spoofed-user', owner_email: 'spoofed@evil.test',
    });
    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].owner_user_id).toBe('merchant-3');
    expect(inserted[0].owner_email).toBe('real@owner.test');
  });
});

describe('authority boundaries', () => {
  test('no /approve-activation on the merchant surface — activation stays admin-only', async () => {
    asMerchant();
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({})) });
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections/x/approve-activation');
    expect(res.status).toBe(404); // Express default: route does not exist
  });

  test('activation-summary reports awaiting_platform_approval instead of can_activate', async () => {
    asMerchant('merchant-1');
    const rec = { id: 'm-1', status: 'certified', partner_tenant: { name: 'Shop', owner_user_id: 'merchant-1' } };
    const version = { id: 'v-1', version: '0.1.0', certification_status: 'certified' };
    const cert = { id: 'c-1', status: 'certified' };
    const tables: Record<string, any> = {
      integration_manifest: tableStub({ data: rec }),
      integration_version: tableStub({ data: version }),
      connector_certification: tableStub({ data: cert }),
    };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn((t: string) => tables[t] ?? tableStub({})) });
    const res = await request(app).get('/api/v1/vcaop/portal/my/connections/m-1/activation-summary');
    expect(res.status).toBe(200);
    expect(res.body.data.awaiting_platform_approval).toBe(true);
    expect(res.body.data).not.toHaveProperty('can_activate');
  });
});

describe('certification gate integrity (Codex review, VTID-03555)', () => {
  const rec = { id: 'm-1', status: 'mapping', partner_tenant: { name: 'Shop', owner_user_id: 'merchant-1' } };
  const version = { id: 'v-1', version: '0.1.0' };

  test('zero mappings can NEVER certify — sandbox tests refuse with awaiting_factory_run', async () => {
    asMerchant('merchant-1');
    const tables: Record<string, any> = {
      integration_manifest: tableStub({ data: rec }),
      integration_version: tableStub({ data: version }),
      schema_mapping: tableStub({ data: [] }),
    };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn((t: string) => tables[t] ?? tableStub({})) });
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections/m-1/sandbox-tests');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/awaiting_factory_run/);
  });

  test('a rejected mapping is removed from the version so it cannot reach certification', async () => {
    asMerchant('merchant-1');
    const schemaMapping = tableStub({ data: { id: 'map-1', version_id: 'v-1' } });
    const tables: Record<string, any> = {
      integration_manifest: tableStub({ data: rec }),
      integration_version: tableStub({ data: version }),
      schema_mapping: schemaMapping,
      mapping_decision: tableStub({}),
      oasis_events: tableStub({}),
    };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn((t: string) => tables[t] ?? tableStub({})) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/mapping-decisions')
      .send({ mapping_id: 'map-1', decision: 'reject' });
    expect(res.status).toBe(200);
    expect(schemaMapping.delete).toHaveBeenCalled();
    expect(schemaMapping.filters['id']).toBe('map-1');
  });

  test('approval_required connections can re-run sandbox tests after a decision', async () => {
    asMerchant('merchant-1');
    const blocked = { ...rec, status: 'approval_required' };
    const tables: Record<string, any> = {
      integration_manifest: tableStub({ data: blocked }),
      integration_version: tableStub({ data: version }),
      schema_mapping: tableStub({ data: [{ id: 'map-1', sensitive: false, confidence: 0.99, decided_by: 'human' }] }),
      connector_certification: tableStub({}),
      oasis_events: tableStub({}),
    };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn((t: string) => tables[t] ?? tableStub({})) });
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections/m-1/sandbox-tests');
    expect(res.status).toBe(200);
    expect(res.body.data.certification).toBe('certified');
  });
});

describe('input + infrastructure guards', () => {
  test('database unavailable → 503, not a crash', async () => {
    asMerchant();
    (getSupabase as jest.Mock).mockReturnValue(null);
    const res = await request(app).get('/api/v1/vcaop/portal/my/connections');
    expect(res.status).toBe(503);
  });

  test('create validates required fields before touching the database', async () => {
    asMerchant();
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({})) });
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections').send({ name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connector_id/);
  });

  test('lifecycle transition on a foreign connection is 404 and writes nothing', async () => {
    asMerchant('merchant-9');
    const update = jest.fn();
    const manifests = tableStub({ data: null });
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn(() => ({ ...manifests, update })),
    });
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections/foreign/revoke');
    expect(res.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('detect-platform (VTID-03601, Track 4)', () => {
  test('requires a url', async () => {
    asMerchant();
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections/detect-platform').send({});
    expect(res.status).toBe(400);
    expect(detectPlatform).not.toHaveBeenCalled();
  });

  test('is read-only — never touches the database', async () => {
    asMerchant();
    (detectPlatform as jest.Mock).mockResolvedValue({ ok: true, connector_id: 'shopify', confidence: 'high' });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/detect-platform')
      .send({ url: 'https://shop.example.test' });
    expect(res.status).toBe(200);
    expect(res.body.connector_id).toBe('shopify');
    expect(getSupabase).not.toHaveBeenCalled();
  });

  test('an SSRF-blocked or failed detection surfaces as 422, not 500', async () => {
    asMerchant();
    (detectPlatform as jest.Mock).mockResolvedValue({ ok: false, error: 'blocked_private_address' });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/detect-platform')
      .send({ url: 'http://169.254.169.254/' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('blocked_private_address');
  });
});

describe('shopify OAuth authorize (VTID-03603, Track 2)', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('reports not_configured when SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI are unset', async () => {
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    delete process.env.SHOPIFY_OAUTH_REDIRECT_URI;
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'shopify', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/shopify/authorize')
      .send({ shop: 'my-shop.myshopify.com' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_configured');
  });

  test('a foreign connection reads as 404 even when configured', async () => {
    process.env.SHOPIFY_CLIENT_ID = 'id';
    process.env.SHOPIFY_CLIENT_SECRET = 'secret';
    process.env.SHOPIFY_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/shopify-oauth/callback';
    asMerchant('merchant-2');
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: null })) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/foreign/shopify/authorize')
      .send({ shop: 'my-shop.myshopify.com' });
    expect(res.status).toBe(404);
  });

  test('rejects a connection whose connector_id is not shopify', async () => {
    process.env.SHOPIFY_CLIENT_ID = 'id';
    process.env.SHOPIFY_CLIENT_SECRET = 'secret';
    process.env.SHOPIFY_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/shopify-oauth/callback';
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'woocommerce', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/shopify/authorize')
      .send({ shop: 'my-shop.myshopify.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a shopify connector/);
  });

  test('rejects a non *.myshopify.com shop domain', async () => {
    process.env.SHOPIFY_CLIENT_ID = 'id';
    process.env.SHOPIFY_CLIENT_SECRET = 'secret';
    process.env.SHOPIFY_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/shopify-oauth/callback';
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'shopify', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/shopify/authorize')
      .send({ shop: 'evil.example.com' });
    expect(res.status).toBe(400);
  });

  test('returns a real Shopify authorize_url when configured, owned, and valid', async () => {
    process.env.SHOPIFY_CLIENT_ID = 'test-client-id';
    process.env.SHOPIFY_CLIENT_SECRET = 'test-client-secret';
    process.env.SHOPIFY_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/shopify-oauth/callback';
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'shopify', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/shopify/authorize')
      .send({ shop: 'my-shop.myshopify.com' });
    expect(res.status).toBe(200);
    const url = new URL(res.body.data.authorize_url);
    expect(url.origin).toBe('https://my-shop.myshopify.com');
    expect(url.pathname).toBe('/admin/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://gateway.example/api/v1/vcaop/shopify-oauth/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });
});

describe('SMART on FHIR authorize (VTID-03605, Track 3)', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('reports not_configured when FHIR_OAUTH_STATE_SECRET/REDIRECT_URI are unset', async () => {
    delete process.env.FHIR_OAUTH_STATE_SECRET;
    delete process.env.FHIR_OAUTH_REDIRECT_URI;
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'smart_fhir', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/fhir/authorize')
      .send({ fhir_base_url: 'https://ehr.example.com/fhir/r4', client_id: 'client-abc' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_configured');
    expect(discoverSmartConfiguration).not.toHaveBeenCalled();
  });

  test('a foreign connection reads as 404 even when configured', async () => {
    process.env.FHIR_OAUTH_STATE_SECRET = 'secret';
    process.env.FHIR_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/fhir-oauth/callback';
    asMerchant('merchant-2');
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: null })) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/foreign/fhir/authorize')
      .send({ fhir_base_url: 'https://ehr.example.com/fhir/r4', client_id: 'client-abc' });
    expect(res.status).toBe(404);
  });

  test('rejects a connection whose connector_id is not smart_fhir', async () => {
    process.env.FHIR_OAUTH_STATE_SECRET = 'secret';
    process.env.FHIR_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/fhir-oauth/callback';
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'shopify', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/fhir/authorize')
      .send({ fhir_base_url: 'https://ehr.example.com/fhir/r4', client_id: 'client-abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a smart_fhir connector/);
  });

  test('rejects a non-https fhir_base_url before any discovery call', async () => {
    process.env.FHIR_OAUTH_STATE_SECRET = 'secret';
    process.env.FHIR_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/fhir-oauth/callback';
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'smart_fhir', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/fhir/authorize')
      .send({ fhir_base_url: 'http://ehr.example.com/fhir', client_id: 'client-abc' });
    expect(res.status).toBe(400);
    expect(discoverSmartConfiguration).not.toHaveBeenCalled();
  });

  test('requires a client_id', async () => {
    process.env.FHIR_OAUTH_STATE_SECRET = 'secret';
    process.env.FHIR_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/fhir-oauth/callback';
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'smart_fhir', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/fhir/authorize')
      .send({ fhir_base_url: 'https://ehr.example.com/fhir/r4' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/client_id/);
  });

  test('a discovery failure surfaces as 502, not a crash', async () => {
    process.env.FHIR_OAUTH_STATE_SECRET = 'secret';
    process.env.FHIR_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/fhir-oauth/callback';
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'smart_fhir', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    (discoverSmartConfiguration as jest.Mock).mockResolvedValue({ ok: false, error: 'blocked_private_address' });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/fhir/authorize')
      .send({ fhir_base_url: 'https://internal-ehr.example.com/fhir', client_id: 'client-abc' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('blocked_private_address');
  });

  test('returns a real SMART authorize_url when configured, owned, and valid', async () => {
    process.env.FHIR_OAUTH_STATE_SECRET = 'test-fhir-state-secret';
    process.env.FHIR_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/fhir-oauth/callback';
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'smart_fhir', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    (discoverSmartConfiguration as jest.Mock).mockResolvedValue({
      ok: true,
      config: {
        authorization_endpoint: 'https://ehr.example.com/oauth/authorize',
        token_endpoint: 'https://ehr.example.com/oauth/token',
      },
    });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/fhir/authorize')
      .send({ fhir_base_url: 'https://ehr.example.com/fhir/r4', client_id: 'client-abc' });
    expect(res.status).toBe(200);
    const url = new URL(res.body.data.authorize_url);
    expect(url.origin + url.pathname).toBe('https://ehr.example.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe('https://gateway.example/api/v1/vcaop/fhir-oauth/callback');
    expect(url.searchParams.get('aud')).toBe('https://ehr.example.com/fhir/r4');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid fhirUser patient/*.read');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  test('honors a caller-supplied scope instead of the default', async () => {
    process.env.FHIR_OAUTH_STATE_SECRET = 'test-fhir-state-secret';
    process.env.FHIR_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/fhir-oauth/callback';
    asMerchant('merchant-1');
    const rec = { id: 'm-1', connector_id: 'smart_fhir', status: 'authorization_required', partner_tenant: { owner_user_id: 'merchant-1' } };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({ data: rec })) });
    (discoverSmartConfiguration as jest.Mock).mockResolvedValue({
      ok: true,
      config: {
        authorization_endpoint: 'https://ehr.example.com/oauth/authorize',
        token_endpoint: 'https://ehr.example.com/oauth/token',
      },
    });
    const res = await request(app)
      .post('/api/v1/vcaop/portal/my/connections/m-1/fhir/authorize')
      .send({ fhir_base_url: 'https://ehr.example.com/fhir/r4', client_id: 'client-abc', scope: 'launch/patient patient/Observation.read' });
    expect(res.status).toBe(200);
    const url = new URL(res.body.data.authorize_url);
    expect(url.searchParams.get('scope')).toBe('launch/patient patient/Observation.read');
  });
});
