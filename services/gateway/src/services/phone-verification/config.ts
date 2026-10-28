/**
 * VTID-05095: phone verification settings, all from the environment.
 *
 *   PHONE_VERIFY_ENABLED            exact 'true' turns the feature on (default off)
 *   PHONE_VERIFY_HMAC_SECRET        ≥ 32 bytes; enabled without it = misconfigured
 *   PHONE_VERIFY_COUNTRIES          ISO codes the SMS may go to (default DE,AT,CH)
 *   PHONE_VERIFY_DAILY_CAP          SMS per UTC day for everyone (default 200)
 *   PHONE_VERIFY_SENDER_ID          alphanumeric sender ID (optional)
 *   PHONE_VERIFY_CONFIGURATION_SET  End User Messaging configuration set (optional)
 *   PHONE_VERIFY_ORIGINATION        origination number / pool (optional)
 *
 * Read at call time, so a task-definition change takes effect without code.
 */

export const CODE_TTL_SECONDS = 600;
export const MAX_ATTEMPTS = 5;
export const USER_HOUR_MAX = 3;
export const USER_DAY_MAX = 6;
export const PHONE_DAY_MAX = 5;
export const RESEND_AFTER_SECONDS = 60;
const MIN_SECRET_BYTES = 32;
const DEFAULT_COUNTRIES = ['DE', 'AT', 'CH'];
const DEFAULT_DAILY_CAP = 200;

export type PhoneVerifyState = 'enabled' | 'disabled' | 'misconfigured';

export function phoneVerifyState(env: NodeJS.ProcessEnv = process.env): PhoneVerifyState {
  if (env.PHONE_VERIFY_ENABLED !== 'true') return 'disabled';
  const secret = env.PHONE_VERIFY_HMAC_SECRET ?? '';
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) return 'misconfigured';
  return 'enabled';
}

export function hmacSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.PHONE_VERIFY_HMAC_SECRET ?? '';
}

export function allowedCountries(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = (env.PHONE_VERIFY_COUNTRIES ?? '').trim();
  const list = raw
    ? raw.split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c))
    : DEFAULT_COUNTRIES;
  return new Set(list.length ? list : DEFAULT_COUNTRIES);
}

export function dailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.PHONE_VERIFY_DAILY_CAP ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

let loggedBootState = false;

/** Logs once per process when the feature is switched on without its secret. */
export function logMisconfigurationOnce(): void {
  if (loggedBootState) return;
  loggedBootState = true;
  if (phoneVerifyState() === 'misconfigured') {
    console.error(
      '[phone-verification] PHONE_VERIFY_ENABLED=true but PHONE_VERIFY_HMAC_SECRET is missing or shorter than 32 bytes — every route answers 503 PHONE_VERIFY_MISCONFIGURED',
    );
  }
}
