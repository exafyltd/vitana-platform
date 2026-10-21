/**
 * VTID-05095: a member verifies their own phone number with an SMS code.
 *
 *   start   → normalise the number, refuse test/service accounts and numbers
 *             already verified on another account, then in ONE database
 *             transaction (phone_verification_begin) check the limits and
 *             write the one open challenge; only then send the SMS.
 *   confirm → phone_verification_confirm checks the code (HMAC), counts the
 *             attempt and consumes it; on success the number is written to
 *             Supabase Auth (phone + phone_confirm). VTID-05057's trigger
 *             mirrors it to profiles and links matching contacts.
 *   remove  → clears the auth phone; the trigger marks the profile unverified
 *             and on_phone_a_withdrawn unlinks phone-based matches.
 *
 * Every dependency is injected so the tests never reach a database or AWS.
 */

import { createHmac, randomInt } from 'crypto';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { tt } from '../../i18n/catalog';
import {
  CODE_TTL_SECONDS,
  MAX_ATTEMPTS,
  PHONE_DAY_MAX,
  RESEND_AFTER_SECONDS,
  USER_DAY_MAX,
  USER_HOUR_MAX,
  allowedCountries,
  dailyCap,
  hmacSecret,
  phoneVerifyState,
} from './config';
import type { SmsSender } from './sms-sender';

export type PhoneVerifyError =
  | 'PHONE_VERIFY_DISABLED'
  | 'PHONE_VERIFY_MISCONFIGURED'
  | 'INVALID_PHONE'
  | 'NOT_A_MOBILE_NUMBER'
  | 'COUNTRY_NOT_SUPPORTED'
  | 'ACCOUNT_NOT_ELIGIBLE'
  | 'PHONE_IN_USE'
  | 'TOO_MANY_REQUESTS'
  | 'SMS_SEND_FAILED'
  | 'INVALID_CODE'
  | 'CODE_EXPIRED'
  | 'NO_PENDING_CODE'
  | 'TOO_MANY_ATTEMPTS'
  | 'PHONE_VERIFY_FAILED';

export interface Outcome<T = Record<string, unknown>> {
  status: number;
  body: ({ ok: true } & T) | { ok: false; error: PhoneVerifyError; detail?: string };
}

export interface ProfilePhone {
  phone_e164: string | null;
  phone_verified: boolean;
  discoverable_by_phone: boolean;
}

export interface AuthUpdateError {
  message?: string;
  status?: number;
  code?: string;
}

export interface PhoneVerificationDeps {
  rpc(name: 'phone_verification_begin' | 'phone_verification_confirm', args: Record<string, unknown>): Promise<unknown>;
  getProfilePhone(userId: string): Promise<ProfilePhone | null>;
  phoneVerifiedByOther(phoneE164: string, userId: string): Promise<boolean>;
  updateAuthPhone(userId: string, attrs: { phone: string; phone_confirm?: boolean }): Promise<{ error: AuthUpdateError | null }>;
  excludedAccountIds(): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: string }>;
  userLocale(userId: string): Promise<string>;
  sendSms: SmsSender;
}

const LOG = '[phone-verification]';

function fail(status: number, error: PhoneVerifyError, detail?: string): Outcome<never> {
  return { status, body: detail ? { ok: false, error, detail } : { ok: false, error } };
}

/** 503 unless the feature is on and correctly configured. */
export function availability(): Outcome<never> | null {
  const state = phoneVerifyState();
  if (state === 'disabled') return fail(503, 'PHONE_VERIFY_DISABLED');
  if (state === 'misconfigured') {
    console.error(`${LOG} enabled without a valid PHONE_VERIFY_HMAC_SECRET — refusing`);
    return fail(503, 'PHONE_VERIFY_MISCONFIGURED');
  }
  return null;
}

/** HMAC of the code, bound to the member (the challenge row holds the number). */
export function hashCode(userId: string, code: string, secret = hmacSecret()): string {
  return createHmac('sha256', secret).update(`${userId}:${code}`).digest('hex');
}

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function maskPhone(e164: string | null): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 6) return e164;
  return `+${digits.slice(0, 2)} ••• ${digits.slice(-3)}`;
}

type Normalised = { ok: true; e164: string } | { ok: false; error: PhoneVerifyError };

export function normaliseMobile(raw: unknown, regionHint?: unknown): Normalised {
  if (typeof raw !== 'string' || raw.trim().length < 4 || raw.length > 40) return { ok: false, error: 'INVALID_PHONE' };
  const region = typeof regionHint === 'string' && /^[A-Za-z]{2}$/.test(regionHint)
    ? (regionHint.toUpperCase() as CountryCode)
    : ('DE' as CountryCode);
  const trimmed = raw.trim().replace(/^00/, '+');
  const parsed = parsePhoneNumberFromString(trimmed, region);
  if (!parsed || !parsed.isValid()) return { ok: false, error: 'INVALID_PHONE' };
  const type = parsed.getType();
  if (type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE') return { ok: false, error: 'NOT_A_MOBILE_NUMBER' };
  if (!parsed.country || !allowedCountries().has(parsed.country)) return { ok: false, error: 'COUNTRY_NOT_SUPPORTED' };
  return { ok: true, e164: parsed.number };
}

/** A Supabase Auth error that means "this number already belongs to an account". */
export function isPhoneTakenError(err: AuthUpdateError | null): boolean {
  if (!err) return false;
  const text = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase();
  return (
    err.code === '23505' ||
    err.code === 'phone_exists' ||
    text.includes('phone_exists') ||
    (text.includes('phone') && (text.includes('already') || text.includes('registered') || text.includes('unique') || text.includes('duplicate')))
  );
}

export async function getPhoneStatus(deps: PhoneVerificationDeps, userId: string): Promise<Outcome> {
  const state = phoneVerifyState();
  const profile = await deps.getProfilePhone(userId);
  return {
    status: 200,
    body: {
      ok: true,
      enabled: state === 'enabled',
      verified: !!profile?.phone_verified && !!profile?.phone_e164,
      phone_masked: profile?.phone_verified ? maskPhone(profile?.phone_e164 ?? null) : null,
      discoverable: profile?.discoverable_by_phone ?? true,
      resend_after_seconds: RESEND_AFTER_SECONDS,
    },
  };
}

export async function startVerification(
  deps: PhoneVerificationDeps,
  userId: string,
  input: { phone?: unknown; region?: unknown },
): Promise<Outcome> {
  const unavailable = availability();
  if (unavailable) return unavailable;

  const n = normaliseMobile(input.phone, input.region);
  if (!n.ok) return fail(400, n.error);

  const excluded = await deps.excludedAccountIds();
  if (!excluded.ok) {
    console.error(`${LOG} exclusion lookup failed, refusing to send: ${excluded.error}`);
    return fail(502, 'PHONE_VERIFY_FAILED');
  }
  if (excluded.ids.has(userId)) return fail(403, 'ACCOUNT_NOT_ELIGIBLE');

  if (await deps.phoneVerifiedByOther(n.e164, userId)) return fail(409, 'PHONE_IN_USE');

  const code = generateCode();
  const verdict = await deps.rpc('phone_verification_begin', {
    p_user_id: userId,
    p_phone_e164: n.e164,
    p_code_hash: hashCode(userId, code),
    p_ttl_seconds: CODE_TTL_SECONDS,
    p_user_hour_max: USER_HOUR_MAX,
    p_user_day_max: USER_DAY_MAX,
    p_phone_day_max: PHONE_DAY_MAX,
    p_daily_cap: dailyCap(),
  });
  if (verdict !== 'ok') {
    if (verdict === 'daily_cap') console.error(`${LOG} daily SMS cap reached`);
    return fail(429, 'TOO_MANY_REQUESTS', typeof verdict === 'string' ? verdict : undefined);
  }

  const locale = await deps.userLocale(userId);
  try {
    await deps.sendSms(n.e164, tt('sms.phone_verification.code', locale, { code }));
  } catch (err: any) {
    console.error(`${LOG} SMS send failed: ${err?.name ?? ''} ${err?.message ?? err}`);
    return fail(502, 'SMS_SEND_FAILED');
  }
  return {
    status: 200,
    body: { ok: true, expires_in: CODE_TTL_SECONDS, resend_after_seconds: RESEND_AFTER_SECONDS, phone_masked: maskPhone(n.e164) },
  };
}

export async function confirmVerification(
  deps: PhoneVerificationDeps,
  userId: string,
  input: { code?: unknown },
): Promise<Outcome> {
  const unavailable = availability();
  if (unavailable) return unavailable;

  const code = typeof input.code === 'string' ? input.code.replace(/\s/g, '') : '';
  if (!/^\d{6}$/.test(code)) return fail(400, 'INVALID_CODE');

  const rows = (await deps.rpc('phone_verification_confirm', {
    p_user_id: userId,
    p_code_hash: hashCode(userId, code),
    p_max_attempts: MAX_ATTEMPTS,
  })) as Array<{ result: string; phone_e164: string | null }> | null;
  const row = Array.isArray(rows) ? rows[0] : null;
  switch (row?.result) {
    case 'ok':
      break;
    case 'wrong':
      return fail(400, 'INVALID_CODE');
    case 'expired':
      return fail(410, 'CODE_EXPIRED');
    case 'too_many_attempts':
      return fail(429, 'TOO_MANY_ATTEMPTS');
    case 'none':
      return fail(404, 'NO_PENDING_CODE');
    default:
      console.error(`${LOG} unexpected confirm result: ${JSON.stringify(rows)}`);
      return fail(502, 'PHONE_VERIFY_FAILED');
  }
  const phoneE164 = row.phone_e164 as string;

  // Checked again here: another account may have verified the number
  // between the send and this confirm.
  if (await deps.phoneVerifiedByOther(phoneE164, userId)) return fail(409, 'PHONE_IN_USE');

  const { error } = await deps.updateAuthPhone(userId, { phone: phoneE164.replace(/\D/g, ''), phone_confirm: true });
  if (error) {
    if (isPhoneTakenError(error)) return fail(409, 'PHONE_IN_USE');
    console.error(`${LOG} auth phone update failed: ${error.status ?? ''} ${error.code ?? ''} ${error.message ?? ''}`);
    return fail(502, 'PHONE_VERIFY_FAILED');
  }
  return { status: 200, body: { ok: true, verified: true, phone_masked: maskPhone(phoneE164) } };
}

export async function removePhone(deps: PhoneVerificationDeps, userId: string): Promise<Outcome> {
  const unavailable = availability();
  if (unavailable) return unavailable;
  const { error } = await deps.updateAuthPhone(userId, { phone: '' });
  if (error) {
    console.error(`${LOG} removing phone failed: ${error.message ?? error.code}`);
    return fail(502, 'PHONE_VERIFY_FAILED');
  }
  return { status: 200, body: { ok: true } };
}
