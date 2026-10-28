/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Shared AES-256-GCM helpers for encrypted
 * third-party AI credentials. Extracted from routes/ai-assistants.ts so the
 * orb/delegation layer and the existing /integrations/ai-assistants routes
 * share a single implementation. The existing routes keep using their local
 * copies until a follow-up PR deduplicates; this file is the canonical
 * implementation going forward.
 *
 * Key source: AI_CREDENTIALS_ENC_KEY env var (32-byte hex).
 * Storage: Postgres BYTEA columns — ciphertext, iv, tag — on ai_assistant_credentials.
 */
import * as crypto from 'crypto';

const LOG_PREFIX = '[ai-credential-crypto]';

export interface EncryptedCredential {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function getEncKey(): Buffer | null {
  const hex = process.env.AI_CREDENTIALS_ENC_KEY;
  if (!hex) return null;
  try {
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) {
      console.error(`${LOG_PREFIX} AI_CREDENTIALS_ENC_KEY must be 32 bytes (64 hex chars), got ${buf.length}`);
      return null;
    }
    return buf;
  } catch (err) {
    console.error(`${LOG_PREFIX} AI_CREDENTIALS_ENC_KEY invalid hex`, err);
    return null;
  }
}

export function encryptApiKey(plaintext: string): EncryptedCredential | null {
  const key = getEncKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: ct, iv, tag };
}

export function decryptApiKey(ciphertext: Buffer, iv: Buffer, tag: Buffer): string | null {
  const key = getEncKey();
  if (!key) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return pt.toString('utf8');
  } catch (err) {
    console.error(`${LOG_PREFIX} decrypt failed`, err);
    return null;
  }
}

/**
 * Supabase returns bytea as `\x`-prefixed hex string or raw Buffer depending
 * on the client / row shape. Normalize to Buffer or null.
 */
export function toBuffer(v: unknown): Buffer | null {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') {
    const s = v.startsWith('\\x') ? v.slice(2) : v;
    try { return Buffer.from(s, 'hex'); } catch { return null; }
  }
  return null;
}

export function isCredentialCryptoConfigured(): boolean {
  return !!getEncKey();
}
