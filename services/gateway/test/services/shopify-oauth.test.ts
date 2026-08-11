/**
 * Shopify OAuth connector (VTID-03603). Load-bearing assertions: the
 * connector is dormant without both env vars, shop-domain validation
 * rejects anything that isn't a real Shopify domain (SSRF/open-redirect
 * surface via the authorize/token-exchange URLs), state signing round-trips
 * and rejects tampering/expiry, and the callback HMAC check follows
 * shopify.dev's documented algorithm exactly.
 */
import { createHmac } from 'node:crypto';

const ORIGINAL_ENV = { ...process.env };

function setConfigured() {
  process.env.SHOPIFY_CLIENT_ID = 'test-client-id';
  process.env.SHOPIFY_CLIENT_SECRET = 'test-client-secret';
}

function clearConfig() {
  delete process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_SECRET;
}

async function freshModule() {
  jest.resetModules();
  return import('../../src/services/shopify-oauth');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = undefined as any;
});

describe('dormant-until-configured', () => {
  test('isShopifyOAuthConfigured is false with no env vars set', async () => {
    clearConfig();
    const mod = await freshModule();
    expect(mod.isShopifyOAuthConfigured()).toBe(false);
  });

  test('isShopifyOAuthConfigured is false with only one of the two vars set', async () => {
    clearConfig();
    process.env.SHOPIFY_CLIENT_ID = 'only-id';
    const mod = await freshModule();
    expect(mod.isShopifyOAuthConfigured()).toBe(false);
  });

  test('buildAuthorizeUrl returns null when not configured', async () => {
    clearConfig();
    const mod = await freshModule();
    expect(mod.buildAuthorizeUrl('shop.myshopify.com', 'state', 'https://gateway.example/cb')).toBeNull();
  });

  test('exchangeCodeForToken reports not_configured rather than making a network call', async () => {
    clearConfig();
    const mod = await freshModule();
    global.fetch = jest.fn();
    const result = await mod.exchangeCodeForToken('shop.myshopify.com', 'code');
    expect(result).toEqual({ ok: false, error: 'not_configured' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('shop domain validation', () => {
  test('accepts a well-formed *.myshopify.com domain', async () => {
    const mod = await freshModule();
    expect(mod.isValidShopDomain('my-cool-shop.myshopify.com')).toBe(true);
  });

  test('rejects a non-Shopify host (SSRF/open-redirect guard)', async () => {
    const mod = await freshModule();
    expect(mod.isValidShopDomain('evil.example.com')).toBe(false);
    expect(mod.isValidShopDomain('myshopify.com.evil.example.com')).toBe(false);
    expect(mod.isValidShopDomain('shop.myshopify.com.evil.com')).toBe(false);
  });

  test('rejects an empty or non-string shop value', async () => {
    const mod = await freshModule();
    expect(mod.isValidShopDomain('')).toBe(false);
    expect(mod.isValidShopDomain(undefined as unknown as string)).toBe(false);
  });
});

describe('state signing', () => {
  test('a freshly signed state decodes back to the same manifest id', async () => {
    setConfigured();
    const mod = await freshModule();
    const state = mod.signState('manifest-123');
    const decoded = mod.decodeAndVerifyState(state);
    expect(decoded).toEqual({ manifestId: 'manifest-123' });
  });

  test('a tampered state (different manifest id spliced in) is rejected', async () => {
    setConfigured();
    const mod = await freshModule();
    const state = mod.signState('manifest-123');
    const raw = Buffer.from(state, 'base64url').toString('utf8');
    const [, expires, sig] = raw.split('.');
    const forged = Buffer.from(`manifest-999.${expires}.${sig}`).toString('base64url');
    expect(mod.decodeAndVerifyState(forged)).toBeNull();
  });

  test('an expired state is rejected', async () => {
    setConfigured();
    const mod = await freshModule();
    const expired = Date.now() - 1000;
    const payload = `manifest-123.${expired}`;
    const sig = createHmac('sha256', 'test-client-secret').update(payload).digest('hex');
    const state = Buffer.from(`${payload}.${sig}`).toString('base64url');
    expect(mod.decodeAndVerifyState(state)).toBeNull();
  });

  test('garbage input does not throw', async () => {
    setConfigured();
    const mod = await freshModule();
    expect(mod.decodeAndVerifyState('not-valid-base64url!!!')).toBeNull();
  });
});

describe('callback HMAC verification (shopify.dev algorithm)', () => {
  test('a correctly computed HMAC over the sorted, hmac-excluded query verifies', async () => {
    setConfigured();
    const mod = await freshModule();
    const query = { code: 'abc', shop: 'my-shop.myshopify.com', state: 'xyz', timestamp: '123' };
    const message = Object.entries(query)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const hmac = createHmac('sha256', 'test-client-secret').update(message).digest('hex');
    expect(mod.verifyCallbackHmac({ ...query, hmac })).toBe(true);
  });

  test('a tampered query parameter fails verification', async () => {
    setConfigured();
    const mod = await freshModule();
    const query = { code: 'abc', shop: 'my-shop.myshopify.com', state: 'xyz', timestamp: '123' };
    const message = Object.entries(query)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const hmac = createHmac('sha256', 'test-client-secret').update(message).digest('hex');
    expect(mod.verifyCallbackHmac({ ...query, shop: 'attacker-shop.myshopify.com', hmac })).toBe(false);
  });

  test('a missing hmac param fails closed', async () => {
    setConfigured();
    const mod = await freshModule();
    expect(mod.verifyCallbackHmac({ code: 'abc', shop: 'my-shop.myshopify.com' })).toBe(false);
  });
});

describe('exchangeCodeForToken', () => {
  test('posts to https://{shop}/admin/oauth/access_token with client_id/client_secret/code', async () => {
    setConfigured();
    const mod = await freshModule();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'shpat_abc', scope: 'read_products' }), { status: 200 }),
    );
    const result = await mod.exchangeCodeForToken('my-shop.myshopify.com', 'the-code');
    expect(result).toEqual({ ok: true, access_token: 'shpat_abc', scope: 'read_products' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://my-shop.myshopify.com/admin/oauth/access_token');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ client_id: 'test-client-id', client_secret: 'test-client-secret', code: 'the-code' });
  });

  test('rejects a non-Shopify shop domain before making any network call', async () => {
    setConfigured();
    const mod = await freshModule();
    global.fetch = jest.fn();
    const result = await mod.exchangeCodeForToken('evil.example.com', 'code');
    expect(result).toEqual({ ok: false, error: 'invalid_shop' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a non-2xx response is reported, not thrown', async () => {
    setConfigured();
    const mod = await freshModule();
    global.fetch = jest.fn().mockResolvedValue(new Response('bad code', { status: 400 }));
    const result = await mod.exchangeCodeForToken('my-shop.myshopify.com', 'bad-code');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('token_exchange_failed_400');
  });

  test('a network failure is reported, not thrown', async () => {
    setConfigured();
    const mod = await freshModule();
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await mod.exchangeCodeForToken('my-shop.myshopify.com', 'code');
    expect(result).toEqual({ ok: false, error: 'ECONNRESET' });
  });
});
