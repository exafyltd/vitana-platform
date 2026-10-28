/**
 * No-credential-store guard (runbook Sec. 0.3 item 7, Sec. 3, Sec. 4.5).
 *
 * Secrets live ONLY in Secret Manager / vault. The database stores references and
 * hashes — never secret material. This guard fails any DB write whose record
 * carries a sensitive field. User-loyalty models are additionally schema-incapable
 * of a password field (Sec. 4.6 `user_reward_link`).
 */
import { CredentialStoreViolation } from './errors';

/**
 * Field-name fragments that indicate raw secret material. Matched case-insensitively
 * as substrings of a snake/camel field name. `*_ref` and `*_hash` are explicitly
 * allowed (they are references/digests, not secrets).
 */
const SENSITIVE_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'credential',
  'token',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'totp_seed',
  'mfa_seed',
  'recovery_code',
  'session_cookie',
  'access_token',
  'refresh_token',
  'client_secret',
];

/** Suffixes that make an otherwise-sensitive-looking name safe (reference/digest). */
const SAFE_SUFFIXES = ['_ref', '_hash', '_id', '_at'];

function isSafeReference(field: string): boolean {
  const f = field.toLowerCase();
  return SAFE_SUFFIXES.some((s) => f.endsWith(s));
}

function isSensitiveFieldName(field: string): boolean {
  const f = field.toLowerCase();
  if (isSafeReference(f)) return false;
  return SENSITIVE_FRAGMENTS.some((frag) => f.includes(frag));
}

/**
 * Throw if a record bound for Postgres contains a sensitive field (recursively).
 * `model` is used only for the error message.
 */
export function assertNoSensitiveFields(model: string, record: unknown, path = ''): void {
  if (record === null || typeof record !== 'object') return;

  if (Array.isArray(record)) {
    record.forEach((item, i) => assertNoSensitiveFields(model, item, `${path}[${i}]`));
    return;
  }

  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (isSensitiveFieldName(key)) {
      throw new CredentialStoreViolation(
        `Refusing DB write for model "${model}": field "${here}" looks like secret material. ` +
          `Store a "${key}_ref" (Secret Manager reference) or "${key}_hash" instead (Sec. 0.3 item 7).`,
      );
    }
    if (value && typeof value === 'object') {
      assertNoSensitiveFields(model, value, here);
    }
  }
}

/**
 * Loyalty-link records are schema-incapable of holding credentials (Sec. 4.6).
 * Beyond the generic check, any presence of a password/credential field is fatal,
 * and `read_only` must be explicitly true.
 */
export function assertLoyaltyRecordCredentialFree(record: Record<string, unknown>): void {
  assertNoSensitiveFields('user_reward_link', record);
  if (record.read_only !== true) {
    throw new CredentialStoreViolation(
      `user_reward_link must have read_only=true (consented, read-only loyalty link; Sec. 4.6)`,
    );
  }
}
