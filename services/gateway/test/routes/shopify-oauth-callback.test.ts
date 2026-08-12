/**
 * Shopify OAuth callback (VTID-03603). PUBLIC route — no requireAuth. The
 * load-bearing assertions are the two independent forgery defenses (HMAC on
 * the query string, signature+expiry on state) and that a completed
 * exchange writes the credential and advances the connection state.
 */
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import shopifyOAuthCallbackRouter from '../../src/routes/shopify-oauth-callback';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn() }));

const app = express();
app.use('/api/v1/vcaop/shopify-oauth', shopifyOAuthCallbackRouter);

const CLIENT_SECRET = 'test-client-secret';
const ORIGINAL_ENV = { ...process.env };

function signState(manifestId: string, expiresInMs = 10 * 60 * 1000): string {
  const expires = Date.now() + expiresInMs;
  const payload = `${manifestId}.${expires}`;
  const sig = createHmac('sha256', CLIENT_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function hmacFor(query: Record<string, string>): string {
  const message = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
}

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

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SHOPIFY_CLIENT_ID = 'test-client-id';
  process.env.SHOPIFY_CLIENT_SECRET = CLIENT_SECRET;
  global.fetch = jest.fn();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = undefined as any;
});

describe('dormant-until-configured', () => {
  test('503s before touching the database when unconfigured', async () => {
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    const res = await request(app).get('/api/v1/vcaop/shopify-oauth/callback').query({ code: 'x', shop: 'a.myshopify.com', state: 'y' });
    expect(res.status).toBe(503);
    expect(getSupabase).not.toHaveBeenCalled();
  });
});

describe('forgery defenses', () => {
  test('rejects a request with no hmac', async () => {
    const state = signState('m-1');
    const res = await request(app)
      .get('/api/v1/vcaop/shopify-oauth/callback')
      .query({ code: 'code', shop: 'a.myshopify.com', state });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_hmac');
  });

  test('rejects a tampered query even with a well-formed hmac from a different payload', async () => {
    const state = signState('m-1');
    const query = { code: 'code', shop: 'a.myshopify.com', state, timestamp: '1' };
    const hmac = hmacFor(query);
    const res = await request(app)
      .get('/api/v1/vcaop/shopify-oauth/callback')
      .query({ ...query, shop: 'attacker.myshopify.com', hmac });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_hmac');
  });

  test('rejects an expired or forged state even with a valid hmac', async () => {
    const query = { code: 'code', shop: 'a.myshopify.com', state: 'garbage-state', timestamp: '1' };
    const hmac = hmacFor(query);
    const res = await request(app).get('/api/v1/vcaop/shopify-oauth/callback').query({ ...query, hmac });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_or_expired_state');
  });

  test('rejects a non-myshopify.com shop before verifying anything else', async () => {
    const state = signState('m-1');
    const res = await request(app)
      .get('/api/v1/vcaop/shopify-oauth/callback')
      .query({ code: 'code', shop: 'evil.example.com', state });
    expect(res.status).toBe(400);
  });
});

describe('happy path', () => {
  test('verified callback exchanges the code, stores the credential, and advances state', async () => {
    const state = signState('m-1');
    const query = { code: 'the-code', shop: 'a.myshopify.com', state, timestamp: '1' };
    const hmac = hmacFor(query);

    const manifests = tableStub({ data: { id: 'm-1', connector_id: 'shopify', status: 'authorization_required' } });
    const credentials = tableStub({});
    const oasisEvents = tableStub({});
    const tables: Record<string, any> = { integration_manifest: manifests, partner_oauth_credential: credentials, oasis_events: oasisEvents };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn((t: string) => tables[t] ?? tableStub({})) });
    (global.fetch as jest.Mock).mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'shpat_xyz', scope: 'read_products' }), { status: 200 }),
    );

    const res = await request(app).get('/api/v1/vcaop/shopify-oauth/callback').query({ ...query, hmac });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ connection_id: 'm-1', shop_domain: 'a.myshopify.com' });
    expect(credentials.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ manifest_id: 'm-1', provider: 'shopify', endpoint_domain: 'a.myshopify.com', access_token: 'shpat_xyz' }),
      { onConflict: 'manifest_id,provider' },
    );
    expect(manifests.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'mapping' }));
    expect(oasisEvents.insert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'vcaop.portal.connection.shopify_authorized', source: 'vcaop-shopify-oauth' }),
    );
  });

  test('a token-exchange failure is reported and never writes a credential', async () => {
    const state = signState('m-1');
    const query = { code: 'bad-code', shop: 'a.myshopify.com', state, timestamp: '1' };
    const hmac = hmacFor(query);

    const manifests = tableStub({ data: { id: 'm-1', connector_id: 'shopify', status: 'authorization_required' } });
    const credentials = tableStub({});
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn((t: string) => (t === 'integration_manifest' ? manifests : credentials)),
    });
    (global.fetch as jest.Mock).mockResolvedValue(new Response('denied', { status: 400 }));

    const res = await request(app).get('/api/v1/vcaop/shopify-oauth/callback').query({ ...query, hmac });

    expect(res.status).toBe(502);
    expect(credentials.upsert).not.toHaveBeenCalled();
  });

  test('a manifest that is not connector_id=shopify is rejected', async () => {
    const state = signState('m-1');
    const query = { code: 'code', shop: 'a.myshopify.com', state, timestamp: '1' };
    const hmac = hmacFor(query);
    const manifests = tableStub({ data: { id: 'm-1', connector_id: 'woocommerce', status: 'authorization_required' } });
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => manifests) });
    const res = await request(app).get('/api/v1/vcaop/shopify-oauth/callback').query({ ...query, hmac });
    expect(res.status).toBe(404);
  });
});
