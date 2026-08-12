/**
 * SMART on FHIR connector (VTID-03605). Load-bearing assertions: dormant
 * without FHIR_OAUTH_STATE_SECRET, https-only base-URL validation, SSRF
 * guard on discovery (reused from platform-detect.ts), PKCE
 * verifier/challenge correctness, encrypted state round-trips and rejects
 * tampering/expiry/wrong-key, and the authorize URL / token exchange follow
 * the documented SMART App Launch shapes exactly.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
const mockLookup = dnsLookup as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

function setConfigured() {
  process.env.FHIR_OAUTH_STATE_SECRET = 'test-fhir-state-secret';
}
function clearConfig() {
  delete process.env.FHIR_OAUTH_STATE_SECRET;
}

// Deliberately NOT jest.resetModules()+dynamic-import here (unlike
// shopify-oauth.test.ts): this module reads FHIR_OAUTH_STATE_SECRET at
// CALL time, not at module-load time, so a fresh module instance per test
// buys nothing — and would actively break the mocked node:dns/promises
// import inside platform-detect.ts (resetModules would re-run that mock
// factory too, producing a jest.fn() disconnected from `mockLookup` below).
async function freshModule() {
  return import('../../src/services/smart-fhir-oauth');
}

beforeEach(() => {
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); // public by default
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = undefined as any;
  jest.clearAllMocks();
});

describe('dormant-until-configured', () => {
  test('isFhirOAuthConfigured is false with no env var set', async () => {
    clearConfig();
    const mod = await freshModule();
    expect(mod.isFhirOAuthConfigured()).toBe(false);
  });

  test('signState throws not_configured rather than minting a token', async () => {
    clearConfig();
    const mod = await freshModule();
    expect(() =>
      mod.signState({
        manifestId: 'm-1', fhirBaseUrl: 'https://ehr.example.com', clientId: 'c1',
        codeVerifier: 'v', tokenEndpoint: 'https://ehr.example.com/token',
      }),
    ).toThrow('not_configured');
  });

  test('decodeAndVerifyState returns null rather than decrypting', async () => {
    clearConfig();
    const mod = await freshModule();
    expect(mod.decodeAndVerifyState('anything.at.all')).toBeNull();
  });
});

describe('FHIR base URL validation', () => {
  test('accepts a well-formed https URL', async () => {
    const mod = await freshModule();
    expect(mod.isValidFhirBaseUrl('https://ehr.example.com/fhir/r4')).toBe(true);
  });

  test('rejects http (SMART requires TLS)', async () => {
    const mod = await freshModule();
    expect(mod.isValidFhirBaseUrl('http://ehr.example.com/fhir')).toBe(false);
  });

  test('rejects an empty, non-string, or malformed value', async () => {
    const mod = await freshModule();
    expect(mod.isValidFhirBaseUrl('')).toBe(false);
    expect(mod.isValidFhirBaseUrl(undefined as unknown as string)).toBe(false);
    expect(mod.isValidFhirBaseUrl('not a url')).toBe(false);
  });
});

describe('PKCE', () => {
  test('generateCodeVerifier produces an RFC7636-shaped value (43-128 chars, unreserved)', async () => {
    const mod = await freshModule();
    const verifier = mod.generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test('generateCodeChallenge is the base64url(sha256(verifier)), per spec', async () => {
    const mod = await freshModule();
    const verifier = 'fixed-test-verifier-value';
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(mod.generateCodeChallenge(verifier)).toBe(expected);
  });
});

describe('encrypted state', () => {
  const payload = {
    manifestId: 'manifest-123',
    fhirBaseUrl: 'https://ehr.example.com/fhir/r4',
    clientId: 'client-abc',
    codeVerifier: 'verifier-xyz',
    tokenEndpoint: 'https://ehr.example.com/oauth/token',
  };

  test('a freshly signed state decrypts back to the same payload', async () => {
    setConfigured();
    const mod = await freshModule();
    const state = mod.signState(payload);
    const decoded = mod.decodeAndVerifyState(state);
    expect(decoded).toMatchObject(payload);
  });

  test('round-trips an optional client_secret without leaking it in plaintext', async () => {
    setConfigured();
    const mod = await freshModule();
    const withSecret = { ...payload, clientSecret: 'super-secret-value' };
    const state = mod.signState(withSecret);
    // The ciphertext segment must not contain the secret in any recoverable plaintext form.
    expect(state).not.toContain('super-secret-value');
    expect(Buffer.from(state.split('.')[1], 'base64url').toString('latin1')).not.toContain('super-secret-value');
    const decoded = mod.decodeAndVerifyState(state);
    expect(decoded?.clientSecret).toBe('super-secret-value');
  });

  test('the code_verifier is not recoverable from the state without the key', async () => {
    setConfigured();
    const mod = await freshModule();
    const state = mod.signState(payload);
    const ciphertextSegment = Buffer.from(state.split('.')[1], 'base64url');
    expect(ciphertextSegment.toString('latin1')).not.toContain(payload.codeVerifier);
  });

  test('a tampered ciphertext byte is rejected (GCM auth tag fails)', async () => {
    setConfigured();
    const mod = await freshModule();
    const state = mod.signState(payload);
    const [iv, ciphertext, tag] = state.split('.');
    const bytes = Buffer.from(ciphertext, 'base64url');
    bytes[0] ^= 0xff; // flip a bit
    const forged = [iv, bytes.toString('base64url'), tag].join('.');
    expect(mod.decodeAndVerifyState(forged)).toBeNull();
  });

  test('a state encrypted under a different secret is rejected', async () => {
    setConfigured();
    const mod = await freshModule();
    const state = mod.signState(payload);
    process.env.FHIR_OAUTH_STATE_SECRET = 'a-completely-different-secret';
    const mod2 = await freshModule();
    expect(mod2.decodeAndVerifyState(state)).toBeNull();
  });

  test('an expired state is rejected', async () => {
    setConfigured();
    jest.useFakeTimers().setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const mod = await freshModule();
    const state = mod.signState(payload);
    jest.setSystemTime(new Date('2020-01-01T00:11:00Z')); // past the 10-minute TTL
    expect(mod.decodeAndVerifyState(state)).toBeNull();
    jest.useRealTimers();
  });

  test('garbage input does not throw', async () => {
    setConfigured();
    const mod = await freshModule();
    expect(mod.decodeAndVerifyState('not-valid-base64url!!!')).toBeNull();
    expect(mod.decodeAndVerifyState('only.two.parts.too.many')).toBeNull();
    expect(mod.decodeAndVerifyState('')).toBeNull();
  });
});

describe('discoverSmartConfiguration (SSRF-guarded)', () => {
  test('rejects a non-https base URL before any network call', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn();
    const result = await mod.discoverSmartConfiguration('http://ehr.example.com/fhir');
    expect(result).toEqual({ ok: false, error: 'invalid_fhir_base_url' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects a base URL that resolves to a private address', async () => {
    const mod = await freshModule();
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    global.fetch = jest.fn();
    const result = await mod.discoverSmartConfiguration('https://internal-ehr.example.com/fhir');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('blocked_private_address');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('fetches {fhirBaseUrl}/.well-known/smart-configuration and parses endpoints', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({
        authorization_endpoint: 'https://ehr.example.com/oauth/authorize',
        token_endpoint: 'https://ehr.example.com/oauth/token',
        capabilities: ['launch-standalone', 'client-public'],
      }), { status: 200 }),
    );
    const result = await mod.discoverSmartConfiguration('https://ehr.example.com/fhir/r4');
    expect(result.ok).toBe(true);
    expect(result.config).toEqual({
      authorization_endpoint: 'https://ehr.example.com/oauth/authorize',
      token_endpoint: 'https://ehr.example.com/oauth/token',
      capabilities: ['launch-standalone', 'client-public'],
    });
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://ehr.example.com/fhir/r4/.well-known/smart-configuration');
  });

  test('strips a trailing slash on the base URL before appending the discovery path', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ authorization_endpoint: 'a', token_endpoint: 'b' }), { status: 200 }),
    );
    await mod.discoverSmartConfiguration('https://ehr.example.com/fhir/r4/');
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://ehr.example.com/fhir/r4/.well-known/smart-configuration');
  });

  test('reports a malformed (non-JSON) discovery document rather than throwing', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn().mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));
    const result = await mod.discoverSmartConfiguration('https://ehr.example.com/fhir');
    expect(result).toEqual({ ok: false, error: 'invalid_discovery_document' });
  });

  test('reports a discovery document missing required endpoints', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ capabilities: [] }), { status: 200 }));
    const result = await mod.discoverSmartConfiguration('https://ehr.example.com/fhir');
    expect(result).toEqual({ ok: false, error: 'discovery_document_missing_endpoints' });
  });
});

describe('buildAuthorizeUrl', () => {
  test('builds a standalone-launch authorize URL with every required SMART param', async () => {
    const mod = await freshModule();
    const url = mod.buildAuthorizeUrl({
      authorizationEndpoint: 'https://ehr.example.com/oauth/authorize',
      fhirBaseUrl: 'https://ehr.example.com/fhir/r4',
      clientId: 'client-abc',
      redirectUri: 'https://gateway.example/api/v1/vcaop/fhir-oauth/callback',
      scope: 'openid fhirUser patient/*.read',
      state: 'encrypted-state-blob',
      codeChallenge: 'challenge-value',
    });
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin + parsed.pathname).toBe('https://ehr.example.com/oauth/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('client-abc');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://gateway.example/api/v1/vcaop/fhir-oauth/callback');
    expect(parsed.searchParams.get('scope')).toBe('openid fhirUser patient/*.read');
    expect(parsed.searchParams.get('state')).toBe('encrypted-state-blob');
    expect(parsed.searchParams.get('aud')).toBe('https://ehr.example.com/fhir/r4');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.has('launch')).toBe(false); // standalone launch — no launch param
  });

  test('returns null for a malformed authorization endpoint', async () => {
    const mod = await freshModule();
    const url = mod.buildAuthorizeUrl({
      authorizationEndpoint: 'not a url', fhirBaseUrl: 'https://ehr.example.com', clientId: 'c',
      redirectUri: 'https://gateway.example/cb', scope: 's', state: 'st', codeChallenge: 'ch',
    });
    expect(url).toBeNull();
  });

  test('returns null for a non-https authorization endpoint', async () => {
    const mod = await freshModule();
    const url = mod.buildAuthorizeUrl({
      authorizationEndpoint: 'http://ehr.example.com/oauth/authorize', fhirBaseUrl: 'https://ehr.example.com', clientId: 'c',
      redirectUri: 'https://gateway.example/cb', scope: 's', state: 'st', codeChallenge: 'ch',
    });
    expect(url).toBeNull();
  });
});

describe('exchangeCodeForToken', () => {
  test('posts the documented SMART token-exchange body', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'tok_abc', token_type: 'Bearer', scope: 'patient/*.read', patient: 'Patient/123',
      }), { status: 200 }),
    );
    const result = await mod.exchangeCodeForToken({
      tokenEndpoint: 'https://ehr.example.com/oauth/token',
      code: 'the-code',
      redirectUri: 'https://gateway.example/cb',
      codeVerifier: 'verifier-xyz',
      clientId: 'client-abc',
    });
    expect(result).toEqual({
      ok: true, access_token: 'tok_abc', token_type: 'Bearer', scope: 'patient/*.read', patient: 'Patient/123',
    });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://ehr.example.com/oauth/token');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe('https://gateway.example/cb');
    expect(body.get('code_verifier')).toBe('verifier-xyz');
    expect(body.get('client_id')).toBe('client-abc');
    expect(body.has('client_secret')).toBe(false);
  });

  test('includes client_secret when supplied (confidential client)', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }));
    await mod.exchangeCodeForToken({
      tokenEndpoint: 'https://ehr.example.com/oauth/token', code: 'c', redirectUri: 'https://gateway.example/cb',
      codeVerifier: 'v', clientId: 'client-abc', clientSecret: 'shh',
    });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = new URLSearchParams(init.body);
    expect(body.get('client_secret')).toBe('shh');
  });

  test('rejects a non-https token endpoint before making any network call', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn();
    const result = await mod.exchangeCodeForToken({
      tokenEndpoint: 'http://ehr.example.com/oauth/token', code: 'c', redirectUri: 'https://gateway.example/cb',
      codeVerifier: 'v', clientId: 'client-abc',
    });
    expect(result).toEqual({ ok: false, error: 'invalid_token_endpoint' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a non-2xx response is reported, not thrown', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn().mockResolvedValue(new Response('bad', { status: 400 }));
    const result = await mod.exchangeCodeForToken({
      tokenEndpoint: 'https://ehr.example.com/oauth/token', code: 'bad-code', redirectUri: 'https://gateway.example/cb',
      codeVerifier: 'v', clientId: 'client-abc',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('token_exchange_failed_400');
  });

  test('a missing access_token in a 200 response is reported', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ scope: 'x' }), { status: 200 }));
    const result = await mod.exchangeCodeForToken({
      tokenEndpoint: 'https://ehr.example.com/oauth/token', code: 'c', redirectUri: 'https://gateway.example/cb',
      codeVerifier: 'v', clientId: 'client-abc',
    });
    expect(result).toEqual({ ok: false, error: 'no_access_token_in_response' });
  });

  test('a network failure is reported, not thrown', async () => {
    const mod = await freshModule();
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await mod.exchangeCodeForToken({
      tokenEndpoint: 'https://ehr.example.com/oauth/token', code: 'c', redirectUri: 'https://gateway.example/cb',
      codeVerifier: 'v', clientId: 'client-abc',
    });
    expect(result).toEqual({ ok: false, error: 'ECONNRESET' });
  });
});
