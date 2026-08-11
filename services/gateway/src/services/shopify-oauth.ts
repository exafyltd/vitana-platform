/**
 * Shopify OAuth 2.0 authorization-code-grant connector (VTID-03603, Track 2
 * of the merchant-onboarding follow-up — CLAUDE.md §13c). Hand-rolled
 * rather than a third-party integration platform (Nango etc.): standing up
 * a new self-hosted service for this would trip CLAUDE.md's "never invent
 * new projects/environments/services without a VTID+sign-off" rule the same
 * way BLK-006/BLK-007 required one, and Shopify's flow is a handful of
 * documented HTTP calls, not something that needs a platform.
 *
 * Endpoint shapes verified against shopify.dev's own docs before writing
 * any code here (never guess a URL):
 *   https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 *
 *   Authorize:      GET  https://{shop}/admin/oauth/authorize
 *                     ?client_id=&scope=&redirect_uri=&state=
 *   Callback:        Shopify redirects to redirect_uri with
 *                     ?code=&hmac=&shop=&state=&timestamp=&host=
 *   Token exchange:  POST https://{shop}/admin/oauth/access_token
 *                     { client_id, client_secret, code }
 *
 * Deliberate-opt-in / dormant-until-configured (same shape as BEDROCK_ROLE_ARN
 * / TTS_PROVIDER elsewhere in this codebase): gated on SHOPIFY_CLIENT_ID +
 * SHOPIFY_CLIENT_SECRET, both unset in every environment this session can
 * reach. Deploying this code changes nothing — no real Shopify Partner app
 * credentials exist to fabricate, so it stays inert until an operator
 * registers one and sets both vars.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the OAuth round trip

function config() {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isShopifyOAuthConfigured(): boolean {
  return config() !== null;
}

export function isValidShopDomain(shop: string): boolean {
  return typeof shop === 'string' && SHOP_DOMAIN_RE.test(shop);
}

/**
 * Signed, stateless CSRF token: manifestId + expiry, HMAC'd with the client
 * secret so a forged state can't redirect the callback onto someone else's
 * connection. No server-side session store needed — the signature IS the
 * integrity check, and the expiry bounds how long a leaked/replayed state
 * stays useful.
 */
export function signState(manifestId: string): string {
  const { clientSecret } = config()!;
  const expires = Date.now() + STATE_TTL_MS;
  const payload = `${manifestId}.${expires}`;
  const sig = createHmac('sha256', clientSecret).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

/**
 * Recovers and verifies the manifest id embedded in a signed state token.
 * The callback is a public, unauthenticated redirect from Shopify — it has
 * no session to check `state` against, so the manifest id has to come FROM
 * the (signature-verified) state itself, not be supplied separately.
 */
export function decodeAndVerifyState(state: string): { manifestId: string } | null {
  const cfg = config();
  if (!cfg) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(state, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [manifestId, expiresStr, sig] = parts;
  if (!manifestId) return null;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || Date.now() > expires) return null;
  const payload = `${manifestId}.${expiresStr}`;
  const expectedSig = createHmac('sha256', cfg.clientSecret).update(payload).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { manifestId };
}

export function buildAuthorizeUrl(shop: string, state: string, redirectUri: string): string | null {
  const cfg = config();
  if (!cfg || !isValidShopDomain(shop)) return null;
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('scope', 'read_products,read_orders');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * HMAC verification per shopify.dev: strip `hmac` and `signature` from the
 * query, sort the remaining params, join as `key=value` with `&`, and
 * compare the hex HMAC-SHA256 digest (keyed on the client secret) against
 * the `hmac` param — timing-safe.
 */
export function verifyCallbackHmac(query: Record<string, string | undefined>): boolean {
  const cfg = config();
  if (!cfg) return false;
  const { hmac } = query;
  if (!hmac) return false;
  const rest = Object.entries(query)
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const expected = createHmac('sha256', cfg.clientSecret).update(rest).digest('hex');
  const a = Buffer.from(hmac, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ShopifyTokenResult {
  ok: boolean;
  error?: string;
  access_token?: string;
  scope?: string;
}

export async function exchangeCodeForToken(shop: string, code: string): Promise<ShopifyTokenResult> {
  const cfg = config();
  if (!cfg) return { ok: false, error: 'not_configured' };
  if (!isValidShopDomain(shop)) return { ok: false, error: 'invalid_shop' };
  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `token_exchange_failed_${res.status}` };
    const body = (await res.json()) as { access_token?: string; scope?: string };
    if (!body.access_token) return { ok: false, error: 'no_access_token_in_response' };
    return { ok: true, access_token: body.access_token, scope: body.scope };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'token_exchange_error' };
  }
}
