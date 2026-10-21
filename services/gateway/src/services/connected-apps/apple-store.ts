/**
 * VTID-04404: encrypted storage for a member's Apple ID + app-specific
 * password. AES-256-GCM via lib/ai-credential-crypto.ts (AI_CREDENTIALS_ENC_KEY);
 * without that key nothing is stored and the Apple apps report "not
 * available" rather than keeping a password in plaintext.
 */

import { decryptApiKey, encryptApiKey, isCredentialCryptoConfigured, toBuffer } from '../../lib/ai-credential-crypto';
import type { AppleCredentials } from './apple-dav';
import { db, enc } from './db';

export function appleStorageAvailable(): boolean {
  return isCredentialCryptoConfigured();
}

export interface StoredApple {
  credentials: AppleCredentials;
  caldavHome: string | null;
  carddavHome: string | null;
}

/** bytea goes over PostgREST as a \x-prefixed hex string. */
function hex(b: Buffer): string {
  return `\\x${b.toString('hex')}`;
}

export async function saveAppleCredentials(
  userId: string,
  tenantId: string | null,
  c: AppleCredentials,
  homes: { caldavHome: string; carddavHome: string },
): Promise<void> {
  const sealed = encryptApiKey(c.password);
  if (!sealed) throw new Error('apple_storage_not_configured');
  const now = new Date().toISOString();
  await db('apple_account_credentials?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      tenant_id: tenantId,
      apple_id: c.appleId,
      secret_ciphertext: hex(sealed.ciphertext),
      secret_iv: hex(sealed.iv),
      secret_tag: hex(sealed.tag),
      caldav_home_url: homes.caldavHome,
      carddav_home_url: homes.carddavHome,
      verified_at: now,
      last_error: null,
      updated_at: now,
    }),
  });
}

export async function loadAppleCredentials(userId: string): Promise<StoredApple | null> {
  const rows = (await db(
    `apple_account_credentials?select=apple_id,secret_ciphertext,secret_iv,secret_tag,caldav_home_url,carddav_home_url&user_id=eq.${enc(userId)}&limit=1`,
  )) as Array<Record<string, unknown>>;
  const row = rows?.[0];
  if (!row) return null;
  const ct = toBuffer(row.secret_ciphertext);
  const iv = toBuffer(row.secret_iv);
  const tag = toBuffer(row.secret_tag);
  if (!ct || !iv || !tag) return null;
  const password = decryptApiKey(ct, iv, tag);
  if (!password) return null;
  return {
    credentials: { appleId: String(row.apple_id), password },
    caldavHome: (row.caldav_home_url as string | null) ?? null,
    carddavHome: (row.carddav_home_url as string | null) ?? null,
  };
}

export async function appleAccountSummary(userId: string): Promise<{ apple_id: string; last_error: string | null } | null> {
  const rows = (await db(
    `apple_account_credentials?select=apple_id,last_error&user_id=eq.${enc(userId)}&limit=1`,
  )) as Array<{ apple_id: string; last_error: string | null }>;
  return rows?.[0] ?? null;
}

export async function markAppleError(userId: string, error: string | null): Promise<void> {
  await db(`apple_account_credentials?user_id=eq.${enc(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_error: error, updated_at: new Date().toISOString() }),
  });
}

export async function deleteAppleCredentials(userId: string): Promise<void> {
  await db(`apple_account_credentials?user_id=eq.${enc(userId)}`, { method: 'DELETE' });
}
