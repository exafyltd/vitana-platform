/**
 * VTID-04401 — signed OAuth `state`.
 *
 * The OAuth callback arrives as a browser redirect with no bearer token, so
 * the only thing that says which Vitanaland user a provider account belongs
 * to is the `state` round-tripped through the provider. It used to be plain
 * base64 JSON: anyone could craft one naming another user and attach their
 * own Google (or wearable) account to that user.
 *
 * Now: `<base64url(json)>.<base64url(hmac-sha256)>`, with an expiry and a
 * random nonce. Anything unsigned, tampered with or older than the TTL is
 * rejected. The key is OAUTH_STATE_SECRET, falling back to a key derived
 * from the service-role secret the gateway always has; with neither, signing
 * and verifying both fail closed.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const OAUTH_STATE_TTL_MS = 15 * 60_000;

function stateKey(): Buffer | null {
  const own = process.env.OAUTH_STATE_SECRET;
  if (own && own.length >= 32) return Buffer.from(own, 'utf8');
  const derived = process.env.SUPABASE_SERVICE_ROLE;
  if (!derived) return null;
  return createHash('sha256').update(`vitana-oauth-state:v1:${derived}`).digest();
}

function mac(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

/** Sign a state payload. Throws when no signing key is configured. */
export function signOAuthState(payload: Record<string, unknown>, now: number = Date.now(), ttlMs: number = OAUTH_STATE_TTL_MS): string {
  const key = stateKey();
  if (!key) throw new Error('oauth_state_key_missing');
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: now, exp: now + ttlMs, n: randomBytes(12).toString('base64url') }),
  ).toString('base64url');
  return `${body}.${mac(key, body)}`;
}

/** The payload of a valid, unexpired state; null for anything else. */
export function verifyOAuthState<T extends Record<string, unknown>>(state: string | null | undefined, now: number = Date.now()): T | null {
  if (!state || typeof state !== 'string' || state.length > 4096) return null;
  const key = stateKey();
  if (!key) return null;
  const dot = state.indexOf('.');
  if (dot <= 0 || dot !== state.lastIndexOf('.')) return null;
  const body = state.slice(0, dot);
  const given = Buffer.from(state.slice(dot + 1), 'utf8');
  const want = Buffer.from(mac(key, body), 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < now) return null;
    return parsed as T;
  } catch {
    return null;
  }
}
