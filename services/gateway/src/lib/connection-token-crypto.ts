/**
 * VTID-05030 (Health Hub D1): at-rest encryption for the OAuth tokens stored in
 * user_connections.access_token / refresh_token.
 *
 * A serialization adapter over lib/ai-credential-crypto.ts (same AES-256-GCM,
 * same key). The ai_assistant_credentials table stores ciphertext, iv and tag
 * in three BYTEA columns; user_connections keeps its existing TEXT columns, so
 * the three parts are packed into one versioned string:
 *
 *   enc:v1:<base64( iv (12 B) ‖ tag (16 B) ‖ ciphertext )>
 *
 * openToken() never returns anything it did not decrypt: a plaintext value, a
 * wrong prefix, a truncated payload or a failed authentication tag all yield
 * null.
 *
 * Interim choice: the key is the shared AI_CREDENTIALS_ENC_KEY. A dedicated
 * key for health tokens and a rotation runbook are deferred (tracked in
 * docs/programs/health-hub/STATUS.md). Rotating that key today makes sealed
 * tokens unreadable, which disconnect treats as "no token".
 */
import {
  decryptApiKey,
  encryptApiKey,
  isCredentialCryptoConfigured,
} from './ai-credential-crypto';

export const SEALED_TOKEN_PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** True when tokens can be sealed (the shared credential key is configured). */
export function isTokenCryptoConfigured(): boolean {
  return isCredentialCryptoConfigured();
}

/** Seal a token for storage. Returns null when no key is configured. */
export function sealToken(plain: string): string | null {
  const enc = encryptApiKey(plain);
  if (!enc) return null;
  const packed = Buffer.concat([enc.iv, enc.tag, enc.ciphertext]);
  return SEALED_TOKEN_PREFIX + packed.toString('base64');
}

/** Open a sealed token. Returns null for anything that is not a valid sealed value. */
export function openToken(stored: string | null | undefined): string | null {
  if (typeof stored !== 'string' || !stored.startsWith(SEALED_TOKEN_PREFIX)) return null;
  const packed = Buffer.from(stored.slice(SEALED_TOKEN_PREFIX.length), 'base64');
  if (packed.length <= IV_BYTES + TAG_BYTES) return null;
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);
  return decryptApiKey(ciphertext, iv, tag);
}
