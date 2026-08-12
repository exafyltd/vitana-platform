/**
 * SMART on FHIR (SMART App Launch, standalone) connector (VTID-03605, Track
 * 3 of the merchant-onboarding follow-up — CLAUDE.md §13c). Targets the
 * healthcare vertical of Discover (insurers, hospitals, individual doctors,
 * labs) — EHR-agnostic: works against any server implementing the SMART App
 * Launch spec (Epic, Cerner/Oracle Health, Athenahealth, ...), not one
 * vendor's proprietary API.
 *
 * Endpoint shapes verified against the actual HL7 SMART App Launch spec
 * before writing any code here (never guess a URL):
 *   https://www.hl7.org/fhir/smart-app-launch/app-launch.html
 *   https://www.hl7.org/fhir/smart-app-launch/conformance.html (discovery doc)
 *
 *   Discovery:       GET  {fhirBaseUrl}/.well-known/smart-configuration
 *                      -> { authorization_endpoint, token_endpoint, capabilities, ... }
 *   Authorize:       GET  {authorization_endpoint}
 *                      ?response_type=code&client_id=&redirect_uri=&scope=
 *                      &state=&aud={fhirBaseUrl}&code_challenge=&code_challenge_method=S256
 *                      (standalone launch — no `launch` param)
 *   Token exchange:  POST {token_endpoint}
 *                      grant_type=authorization_code&code=&redirect_uri=
 *                      &code_verifier=&client_id=
 *
 * Unlike Shopify (one Partner app, one global client_id/secret), every FHIR
 * server is its own EHR deployment with its own client registration — there
 * is no single global credential to gate on. The dormancy gate here is
 * FHIR_OAUTH_STATE_SECRET: unset (true in every environment this session can
 * reach) means state can't be encrypted, so the flow can't start. Deploying
 * this code changes nothing until an operator sets that var AND a merchant
 * supplies their own EHR-issued client_id (and, for confidential clients,
 * client_secret) when starting a connection — those never come from env.
 *
 * PKCE (RFC 7636, S256) is used even though SMART only requires it for
 * public clients — sending it unconditionally costs nothing and protects
 * confidential-client flows too if a client_secret is later omitted.
 *
 * `state` is AES-256-GCM ENCRYPTED, not just signed — deliberately stronger
 * than shopify-oauth.ts's plain-base64+HMAC state. Shopify's state only ever
 * carries a manifest id; this one has to carry code_verifier (and, for
 * confidential clients, client_secret) across the redirect round trip
 * because there is nowhere stateless to stash them otherwise. Both values
 * transit the browser AND the third-party FHIR authorization server's
 * request/redirect (and therefore its access logs) as part of `state` — if
 * that blob were merely signed, its contents would be plaintext-readable by
 * anyone who captured it there, which would defeat PKCE's actual purpose
 * (code_verifier must stay unknown to anything that only saw the browser
 * leg) and expose the merchant's client_secret. Encrypting it means an
 * observer without FHIR_OAUTH_STATE_SECRET sees only opaque ciphertext;
 * GCM's authentication tag still rejects any tampering, same guarantee the
 * HMAC gave Shopify's state.
 *
 * The FHIR base URL is merchant-supplied free text (a different EHR per
 * connection), so both discovery and the base-URL shape get the same SSRF
 * treatment as platform-detect.ts's storefront fetch — reusing its guarded
 * fetch (ssrfGuardedFetch) rather than duplicating the private-IP/redirect
 * logic. See that module's header for what the guard does and does not
 * cover (not rebinding-proof; acceptable for an authenticated merchant
 * probing their own EHR's discovery document, not an anonymous oracle).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ssrfGuardedFetch } from './platform-detect';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the OAuth round trip
const GCM_IV_BYTES = 12;

function stateKey(): Buffer | null {
  const secret = process.env.FHIR_OAUTH_STATE_SECRET;
  if (!secret) return null;
  // AES-256-GCM needs a 32-byte key; derive one from the operator-supplied
  // secret string so the env var can be any length, same as Shopify's
  // client secret being used directly as an HMAC key.
  return createHash('sha256').update(secret).digest();
}

export function isFhirOAuthConfigured(): boolean {
  return stateKey() !== null;
}

/** SMART requires TLS in any real deployment; http:// is only ever a local test fixture. */
export function isValidFhirBaseUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname.length > 0;
}

export function generateCodeVerifier(): string {
  // RFC 7636 wants 43-128 chars from [A-Za-z0-9-._~]; 64 random bytes
  // base64url-encoded lands at 86 chars, comfortably inside that range.
  return randomBytes(64).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface SmartConfiguration {
  authorization_endpoint: string;
  token_endpoint: string;
  capabilities?: string[];
}

export interface SmartDiscoveryResult {
  ok: boolean;
  error?: string;
  config?: SmartConfiguration;
}

/**
 * Fetches and validates {fhirBaseUrl}/.well-known/smart-configuration.
 * SSRF-guarded via platform-detect.ts's ssrfGuardedFetch — the base URL is
 * merchant-supplied, so it gets the same private-IP/redirect/timeout
 * treatment as the storefront URL sniff.
 */
export async function discoverSmartConfiguration(fhirBaseUrl: string): Promise<SmartDiscoveryResult> {
  if (!isValidFhirBaseUrl(fhirBaseUrl)) return { ok: false, error: 'invalid_fhir_base_url' };
  const discoveryUrl = `${fhirBaseUrl.replace(/\/+$/, '')}/.well-known/smart-configuration`;
  let fetched: { headers: Headers; body: string };
  try {
    fetched = await ssrfGuardedFetch(discoveryUrl);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'discovery_fetch_failed' };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(fetched.body);
  } catch {
    return { ok: false, error: 'invalid_discovery_document' };
  }
  if (typeof parsed?.authorization_endpoint !== 'string' || typeof parsed?.token_endpoint !== 'string') {
    return { ok: false, error: 'discovery_document_missing_endpoints' };
  }
  return {
    ok: true,
    config: {
      authorization_endpoint: parsed.authorization_endpoint,
      token_endpoint: parsed.token_endpoint,
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : undefined,
    },
  };
}

interface StatePayload {
  manifestId: string;
  fhirBaseUrl: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier: string;
  tokenEndpoint: string;
  expires: number;
}

/**
 * Encrypted, stateless CSRF token carrying everything the callback needs to
 * complete the exchange without a server-side session store — see the
 * module header for why this is AES-256-GCM encryption and not just an
 * HMAC signature the way shopify-oauth.ts's state is. The token endpoint
 * itself is pinned here (not re-discovered on callback) so a discovery
 * document that changes between authorize and callback can't redirect the
 * token exchange to a different endpoint.
 */
export function signState(payload: Omit<StatePayload, 'expires'>): string {
  const key = stateKey();
  if (!key) throw new Error('not_configured');
  const full: StatePayload = { ...payload, expires: Date.now() + STATE_TTL_MS };
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(full), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, ciphertext, authTag].map((b) => b.toString('base64url')).join('.');
}

export function decodeAndVerifyState(state: string): StatePayload | null {
  const key = stateKey();
  if (!key) return null;
  if (typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  let iv: Buffer, ciphertext: Buffer, authTag: Buffer;
  try {
    [iv, ciphertext, authTag] = parts.map((p) => Buffer.from(p, 'base64url'));
  } catch {
    return null;
  }
  if (iv.length !== GCM_IV_BYTES) return null;
  let payload: StatePayload;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    payload = JSON.parse(plaintext);
  } catch {
    // Tampered ciphertext, wrong key, or malformed JSON — all indistinguishable, all rejected.
    return null;
  }
  if (!payload.manifestId || !payload.tokenEndpoint || !payload.codeVerifier || !payload.clientId) return null;
  if (!Number.isFinite(payload.expires) || Date.now() > payload.expires) return null;
  return payload;
}

export function buildAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  fhirBaseUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string | null {
  let url: URL;
  try {
    url = new URL(opts.authorizationEndpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', opts.scope);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('aud', opts.fhirBaseUrl);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface FhirTokenResult {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  patient?: string;
}

export async function exchangeCodeForToken(opts: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
}): Promise<FhirTokenResult> {
  let url: URL;
  try {
    url = new URL(opts.tokenEndpoint);
  } catch {
    return { ok: false, error: 'invalid_token_endpoint' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'invalid_token_endpoint' };
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
  });
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `token_exchange_failed_${res.status}` };
    const parsed = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      patient?: string;
    };
    if (!parsed.access_token) return { ok: false, error: 'no_access_token_in_response' };
    return {
      ok: true,
      access_token: parsed.access_token,
      token_type: parsed.token_type,
      scope: parsed.scope,
      patient: parsed.patient,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'token_exchange_error' };
  }
}
