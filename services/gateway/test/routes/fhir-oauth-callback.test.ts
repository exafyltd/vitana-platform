/**
 * SMART on FHIR OAuth callback (VTID-03605). PUBLIC route — no requireAuth.
 * The load-bearing assertions are the state-based forgery defense (an
 * encrypted, authenticated state is the only thing this route trusts) and
 * that a completed exchange writes the credential and advances the
 * connection state, mirroring shopify-oauth-callback.test.ts.
 */
import express from 'express';
import request from 'supertest';
import fhirOAuthCallbackRouter from '../../src/routes/fhir-oauth-callback';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn() }));

const app = express();
app.use('/api/v1/vcaop/fhir-oauth', fhirOAuthCallbackRouter);

const STATE_SECRET = 'test-fhir-state-secret';
const ORIGINAL_ENV = { ...process.env };

function tableStub(result: { data?: any; error?: any }) {
  const chain: any = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve({ data: result.data ?? null, error: result.error ?? null })),
    upsert: jest.fn(() => Promise.resolve({ error: null })),
    update: jest.fn(() => chain),
    insert: jest.fn(() => Promise.resolve({ error: null })),
  };
  return chain;
}

async function makeState(overrides: Record<string, unknown> = {}) {
  const mod = await import('../../src/services/smart-fhir-oauth');
  return mod.signState({
    manifestId: 'm-1',
    fhirBaseUrl: 'https://ehr.example.com/fhir/r4',
    clientId: 'client-abc',
    codeVerifier: 'verifier-xyz',
    tokenEndpoint: 'https://ehr.example.com/oauth/token',
    ...overrides,
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FHIR_OAUTH_STATE_SECRET = STATE_SECRET;
  process.env.FHIR_OAUTH_REDIRECT_URI = 'https://gateway.example/api/v1/vcaop/fhir-oauth/callback';
  global.fetch = jest.fn();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = undefined as any;
});

describe('dormant-until-configured', () => {
  test('503s before touching the database when unconfigured', async () => {
    delete process.env.FHIR_OAUTH_STATE_SECRET;
    const res = await request(app).get('/api/v1/vcaop/fhir-oauth/callback').query({ code: 'x', state: 'y' });
    expect(res.status).toBe(503);
    expect(getSupabase).not.toHaveBeenCalled();
  });
});

describe('forgery defenses', () => {
  test('rejects a request with no code or state', async () => {
    const res = await request(app).get('/api/v1/vcaop/fhir-oauth/callback').query({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_callback_request');
  });

  test('surfaces an authorization_denied error from the EHR without touching state', async () => {
    const res = await request(app).get('/api/v1/vcaop/fhir-oauth/callback').query({ error: 'access_denied' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('authorization_denied: access_denied');
  });

  test('rejects garbage state', async () => {
    const res = await request(app).get('/api/v1/vcaop/fhir-oauth/callback').query({ code: 'c', state: 'garbage' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_or_expired_state');
  });

  test('rejects a state encrypted with a stale secret (rotated key)', async () => {
    const state = await makeState();
    process.env.FHIR_OAUTH_STATE_SECRET = 'a-different-secret-now';
    const res = await request(app).get('/api/v1/vcaop/fhir-oauth/callback').query({ code: 'c', state });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_or_expired_state');
  });
});

describe('happy path', () => {
  test('verified callback exchanges the code, stores the credential, and advances state', async () => {
    const state = await makeState();
    const manifests = tableStub({ data: { id: 'm-1', connector_id: 'smart_fhir', status: 'authorization_required' } });
    const credentials = tableStub({});
    const oasisEvents = tableStub({});
    const tables: Record<string, any> = { integration_manifest: manifests, partner_oauth_credential: credentials, oasis_events: oasisEvents };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn((t: string) => tables[t] ?? tableStub({})) });
    (global.fetch as jest.Mock).mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'tok_xyz', token_type: 'Bearer', scope: 'patient/*.read' }), { status: 200 }),
    );

    const res = await request(app).get('/api/v1/vcaop/fhir-oauth/callback').query({ code: 'the-code', state });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ connection_id: 'm-1', fhir_base_url: 'https://ehr.example.com/fhir/r4' });
    expect(credentials.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest_id: 'm-1', provider: 'smart_fhir', endpoint_domain: 'ehr.example.com', access_token: 'tok_xyz',
      }),
      { onConflict: 'manifest_id,provider' },
    );
    expect(manifests.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'mapping' }));
    expect(oasisEvents.insert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'vcaop.portal.connection.fhir_authorized', source: 'vcaop-fhir-oauth' }),
    );

    // The token exchange itself must use the pinned endpoint/verifier/client from state.
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://ehr.example.com/oauth/token');
    const body = new URLSearchParams(init.body);
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('verifier-xyz');
    expect(body.get('client_id')).toBe('client-abc');
  });

  test('a token-exchange failure is reported and never writes a credential', async () => {
    const state = await makeState();
    const manifests = tableStub({ data: { id: 'm-1', connector_id: 'smart_fhir', status: 'authorization_required' } });
    const credentials = tableStub({});
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn((t: string) => (t === 'integration_manifest' ? manifests : credentials)),
    });
    (global.fetch as jest.Mock).mockResolvedValue(new Response('denied', { status: 400 }));

    const res = await request(app).get('/api/v1/vcaop/fhir-oauth/callback').query({ code: 'bad-code', state });

    expect(res.status).toBe(502);
    expect(credentials.upsert).not.toHaveBeenCalled();
  });

  test('a manifest that is not connector_id=smart_fhir is rejected', async () => {
    const state = await makeState();
    const manifests = tableStub({ data: { id: 'm-1', connector_id: 'shopify', status: 'authorization_required' } });
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => manifests) });
    const res = await request(app).get('/api/v1/vcaop/fhir-oauth/callback').query({ code: 'code', state });
    expect(res.status).toBe(404);
  });

  test('a manifest that does not exist is rejected', async () => {
    const state = await makeState();
    const manifests = tableStub({ data: null });
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => manifests) });
    const res = await request(app).get('/api/v1/vcaop/fhir-oauth/callback').query({ code: 'code', state });
    expect(res.status).toBe(404);
  });
});
