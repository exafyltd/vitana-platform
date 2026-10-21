/**
 * VTID-05095 — a member verifies their own phone number with an SMS code.
 *
 * Pins: the off switch and the missing-secret refusal, number normalisation
 * and the country list, test/service accounts never get an SMS, the
 * number-in-use checks (before the send, before saving, and the Auth error
 * mapping), the database verdicts (limits, wrong / expired / exhausted
 * codes), what is written to Supabase Auth, the routes, and the migration's
 * own invariants. The SMS sender is always a mock — no test sends a real SMS.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import {
  confirmVerification,
  generateCode,
  getPhoneStatus,
  hashCode,
  isPhoneTakenError,
  maskPhone,
  normaliseMobile,
  removePhone,
  startVerification,
  type PhoneVerificationDeps,
} from '../src/services/phone-verification/service';
import { phoneVerifyState } from '../src/services/phone-verification/config';

const SECRET = 'x'.repeat(40);
const ME = '11111111-1111-1111-1111-111111111111';
const DE_MOBILE = '+491701234567';

function deps(over: Partial<PhoneVerificationDeps> = {}): PhoneVerificationDeps & { [k: string]: jest.Mock } {
  return {
    rpc: jest.fn(async () => 'ok'),
    getProfilePhone: jest.fn(async () => null),
    phoneVerifiedByOther: jest.fn(async () => false),
    updateAuthPhone: jest.fn(async () => ({ error: null })),
    excludedAccountIds: jest.fn(async () => ({ ok: true as const, ids: new Set<string>() })),
    userLocale: jest.fn(async () => 'de'),
    sendSms: jest.fn(async () => ({ messageId: 'm1' })),
    ...over,
  } as any;
}

const ENV_KEYS = ['PHONE_VERIFY_ENABLED', 'PHONE_VERIFY_HMAC_SECRET', 'PHONE_VERIFY_COUNTRIES', 'PHONE_VERIFY_DAILY_CAP'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PHONE_VERIFY_ENABLED = 'true';
  process.env.PHONE_VERIFY_HMAC_SECRET = SECRET;
  delete process.env.PHONE_VERIFY_COUNTRIES;
  delete process.env.PHONE_VERIFY_DAILY_CAP;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  jest.restoreAllMocks();
});

describe('switch and secret', () => {
  test('off unless exactly "true"', () => {
    for (const v of [undefined, 'false', 'TRUE', '1', 'yes']) {
      if (v === undefined) delete process.env.PHONE_VERIFY_ENABLED;
      else process.env.PHONE_VERIFY_ENABLED = v;
      expect(phoneVerifyState()).toBe('disabled');
    }
  });

  test('on without a 32-byte secret is misconfigured, never hashes with an empty key', async () => {
    for (const s of [undefined, '', 'short-secret']) {
      if (s === undefined) delete process.env.PHONE_VERIFY_HMAC_SECRET;
      else process.env.PHONE_VERIFY_HMAC_SECRET = s;
      const d = deps();
      for (const out of [
        await startVerification(d, ME, { phone: DE_MOBILE }),
        await confirmVerification(d, ME, { code: '123456' }),
        await removePhone(d, ME),
      ]) {
        expect(out.status).toBe(503);
        expect(out.body).toEqual({ ok: false, error: 'PHONE_VERIFY_MISCONFIGURED' });
      }
      expect(d.rpc).not.toHaveBeenCalled();
      expect(d.sendSms).not.toHaveBeenCalled();
      expect(d.updateAuthPhone).not.toHaveBeenCalled();
    }
  });

  test('every write answers 503 PHONE_VERIFY_DISABLED when off; status says enabled:false', async () => {
    process.env.PHONE_VERIFY_ENABLED = 'false';
    const d = deps();
    expect((await startVerification(d, ME, { phone: DE_MOBILE })).body).toEqual({ ok: false, error: 'PHONE_VERIFY_DISABLED' });
    expect((await confirmVerification(d, ME, { code: '123456' })).status).toBe(503);
    expect((await removePhone(d, ME)).status).toBe(503);
    const status = await getPhoneStatus(d, ME);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ ok: true, enabled: false, verified: false });
    expect(d.sendSms).not.toHaveBeenCalled();
  });
});

describe('number normalisation', () => {
  test('a German mobile in national, international and 00 form', () => {
    expect(normaliseMobile('0170 1234567')).toEqual({ ok: true, e164: DE_MOBILE });
    expect(normaliseMobile('+49 170 1234567')).toEqual({ ok: true, e164: DE_MOBILE });
    expect(normaliseMobile('0049 170 1234567')).toEqual({ ok: true, e164: DE_MOBILE });
  });

  test('landlines, garbage and non-strings are refused', () => {
    expect(normaliseMobile('+49 30 123456')).toEqual({ ok: false, error: 'NOT_A_MOBILE_NUMBER' });
    expect(normaliseMobile('12')).toEqual({ ok: false, error: 'INVALID_PHONE' });
    expect(normaliseMobile('not a number')).toEqual({ ok: false, error: 'INVALID_PHONE' });
    expect(normaliseMobile(4917012345 as unknown)).toEqual({ ok: false, error: 'INVALID_PHONE' });
  });

  test('only allowed countries (default DE, AT, CH); the list is configurable', () => {
    expect(normaliseMobile('+381 64 1234567')).toEqual({ ok: false, error: 'COUNTRY_NOT_SUPPORTED' });
    expect(normaliseMobile('+41 79 123 45 67')).toMatchObject({ ok: true });
    process.env.PHONE_VERIFY_COUNTRIES = 'rs, de';
    expect(normaliseMobile('+381 64 1234567')).toEqual({ ok: true, e164: '+381641234567' });
    expect(normaliseMobile('+41 79 123 45 67')).toEqual({ ok: false, error: 'COUNTRY_NOT_SUPPORTED' });
    expect(normaliseMobile('064 1234567', 'rs')).toEqual({ ok: true, e164: '+381641234567' });
  });
});

describe('sending the code', () => {
  test('happy path: one RPC with the HMAC of the code, then one SMS in the member\'s language', async () => {
    const d = deps();
    const out = await startVerification(d, ME, { phone: '0170 1234567' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, expires_in: 600, resend_after_seconds: 60 });
    expect(d.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = d.rpc.mock.calls[0];
    expect(name).toBe('phone_verification_begin');
    expect(args).toMatchObject({
      p_user_id: ME, p_phone_e164: DE_MOBILE, p_ttl_seconds: 600,
      p_user_hour_max: 3, p_user_day_max: 6, p_phone_day_max: 5, p_daily_cap: 200,
    });
    const [to, text] = d.sendSms.mock.calls[0];
    expect(to).toBe(DE_MOBILE);
    const code = /(\d{6})/.exec(text)![1];
    expect(text).toBe(`Dein Vitanaland-Code: ${code}. Gib ihn niemandem weiter.`);
    expect(args.p_code_hash).toBe(hashCode(ME, code, SECRET));
    expect(JSON.stringify(args)).not.toContain(code);
  });

  test('test and service accounts never get an SMS; an exclusion lookup failure refuses too', async () => {
    const excluded = deps({ excludedAccountIds: jest.fn(async () => ({ ok: true as const, ids: new Set([ME]) })) });
    expect((await startVerification(excluded, ME, { phone: DE_MOBILE })).body).toEqual({ ok: false, error: 'ACCOUNT_NOT_ELIGIBLE' });
    const broken = deps({ excludedAccountIds: jest.fn(async () => ({ ok: false as const, error: 'db down' })) });
    expect((await startVerification(broken, ME, { phone: DE_MOBILE })).status).toBe(502);
    for (const d of [excluded, broken]) {
      expect(d.rpc).not.toHaveBeenCalled();
      expect(d.sendSms).not.toHaveBeenCalled();
    }
  });

  test('a number verified on another account is refused before anything is written or sent', async () => {
    const d = deps({ phoneVerifiedByOther: jest.fn(async () => true) });
    const out = await startVerification(d, ME, { phone: DE_MOBILE });
    expect(out).toEqual({ status: 409, body: { ok: false, error: 'PHONE_IN_USE' } });
    expect(d.rpc).not.toHaveBeenCalled();
    expect(d.sendSms).not.toHaveBeenCalled();
  });

  test.each(['user_hour', 'user_day', 'phone_day', 'daily_cap'])('limit %s → 429, no SMS', async (verdict) => {
    const d = deps({ rpc: jest.fn(async () => verdict) });
    const out = await startVerification(d, ME, { phone: DE_MOBILE });
    expect(out.status).toBe(429);
    expect(out.body).toMatchObject({ ok: false, error: 'TOO_MANY_REQUESTS', detail: verdict });
    expect(d.sendSms).not.toHaveBeenCalled();
  });

  test('the daily cap is configurable', async () => {
    process.env.PHONE_VERIFY_DAILY_CAP = '25';
    const d = deps();
    await startVerification(d, ME, { phone: DE_MOBILE });
    expect(d.rpc.mock.calls[0][1].p_daily_cap).toBe(25);
  });

  test('an SMS failure is a 502, not a success', async () => {
    const d = deps({ sendSms: jest.fn(async () => { throw new Error('throttled'); }) });
    expect((await startVerification(d, ME, { phone: DE_MOBILE })).body).toEqual({ ok: false, error: 'SMS_SEND_FAILED' });
  });

  test('codes are six digits, hashes are bound to the member and the secret', () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
    expect(hashCode(ME, '123456', SECRET)).not.toBe(hashCode('other', '123456', SECRET));
    expect(hashCode(ME, '123456', SECRET)).not.toBe(hashCode(ME, '123456', 'y'.repeat(40)));
  });
});

describe('confirming the code', () => {
  const okRow = [{ result: 'ok', phone_e164: DE_MOBILE }];

  test('a malformed code never reaches the database', async () => {
    const d = deps();
    for (const code of [undefined, '', '12345', '1234567', 'abcdef', 123456]) {
      expect((await confirmVerification(d, ME, { code })).body).toEqual({ ok: false, error: 'INVALID_CODE' });
    }
    expect(d.rpc).not.toHaveBeenCalled();
  });

  test('a correct code saves the number to Supabase Auth as confirmed', async () => {
    const d = deps({ rpc: jest.fn(async () => okRow) });
    const out = await confirmVerification(d, ME, { code: '123 456' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, verified: true });
    expect(d.rpc).toHaveBeenCalledWith('phone_verification_confirm', {
      p_user_id: ME, p_code_hash: hashCode(ME, '123456', SECRET), p_max_attempts: 5,
    });
    expect(d.updateAuthPhone).toHaveBeenCalledWith(ME, { phone: '491701234567', phone_confirm: true });
  });

  test.each([
    ['wrong', 400, 'INVALID_CODE'],
    ['expired', 410, 'CODE_EXPIRED'],
    ['too_many_attempts', 429, 'TOO_MANY_ATTEMPTS'],
    ['none', 404, 'NO_PENDING_CODE'],
    ['something_else', 502, 'PHONE_VERIFY_FAILED'],
  ])('database says %s → %i %s, nothing saved', async (result, status, error) => {
    const d = deps({ rpc: jest.fn(async () => [{ result, phone_e164: null }]) });
    expect(await confirmVerification(d, ME, { code: '123456' })).toEqual({ status, body: { ok: false, error } });
    expect(d.updateAuthPhone).not.toHaveBeenCalled();
  });

  test('another account verified the number in the meantime → 409, nothing saved', async () => {
    const d = deps({ rpc: jest.fn(async () => okRow), phoneVerifiedByOther: jest.fn(async () => true) });
    expect((await confirmVerification(d, ME, { code: '123456' })).body).toEqual({ ok: false, error: 'PHONE_IN_USE' });
    expect(d.updateAuthPhone).not.toHaveBeenCalled();
  });

  test('Auth refusing a duplicate number maps to 409 PHONE_IN_USE; other Auth errors to 502', async () => {
    const dup = deps({ rpc: jest.fn(async () => okRow), updateAuthPhone: jest.fn(async () => ({ error: { status: 422, code: 'phone_exists', message: 'Phone number already registered by another user' } })) });
    expect((await confirmVerification(dup, ME, { code: '123456' })).body).toEqual({ ok: false, error: 'PHONE_IN_USE' });
    const pg = deps({ rpc: jest.fn(async () => okRow), updateAuthPhone: jest.fn(async () => ({ error: { status: 500, code: '23505', message: 'duplicate key value violates unique constraint "users_phone_key"' } })) });
    expect((await confirmVerification(pg, ME, { code: '123456' })).body).toEqual({ ok: false, error: 'PHONE_IN_USE' });
    const other = deps({ rpc: jest.fn(async () => okRow), updateAuthPhone: jest.fn(async () => ({ error: { status: 500, message: 'Database error updating user' } })) });
    expect((await confirmVerification(other, ME, { code: '123456' })).body).toEqual({ ok: false, error: 'PHONE_VERIFY_FAILED' });
  });

  test('isPhoneTakenError does not treat unrelated errors as "in use"', () => {
    expect(isPhoneTakenError(null)).toBe(false);
    expect(isPhoneTakenError({ message: 'User not found', status: 404 })).toBe(false);
    expect(isPhoneTakenError({ message: 'Invalid phone number format', status: 422 })).toBe(false);
  });
});

describe('status and remove', () => {
  test('status shows only a verified number, masked', async () => {
    const verified = deps({ getProfilePhone: jest.fn(async () => ({ phone_e164: DE_MOBILE, phone_verified: true, discoverable_by_phone: false })) });
    expect((await getPhoneStatus(verified, ME)).body).toMatchObject({
      ok: true, enabled: true, verified: true, phone_masked: '+49 ••• 567', discoverable: false,
    });
    const typedOnly = deps({ getProfilePhone: jest.fn(async () => ({ phone_e164: null, phone_verified: false, discoverable_by_phone: true })) });
    expect((await getPhoneStatus(typedOnly, ME)).body).toMatchObject({ verified: false, phone_masked: null });
    expect(maskPhone(null)).toBeNull();
  });

  test('remove clears the Auth phone (the triggers do the rest)', async () => {
    const d = deps();
    expect((await removePhone(d, ME)).body).toEqual({ ok: true });
    expect(d.updateAuthPhone).toHaveBeenCalledWith(ME, { phone: '' });
    const failing = deps({ updateAuthPhone: jest.fn(async () => ({ error: { message: 'boom' } })) });
    expect((await removePhone(failing, ME)).status).toBe(502);
  });
});

describe('routes', () => {
  function app(identity: any, d: PhoneVerificationDeps) {
    jest.resetModules();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      requireAuth: (req: any, res: any, next: any) => {
        if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
        req.identity = identity;
        next();
      },
    }));
    const { createMePhoneRouter } = require('../src/routes/me-phone');
    const a = express();
    a.use(express.json());
    a.use('/api/v1/me/phone', createMePhoneRouter(d));
    return a;
  }
  afterEach(() => jest.dontMock('../src/middleware/auth-supabase-jwt'));

  test('every route needs a signed-in member', async () => {
    const a = app(null, deps());
    for (const [m, p] of [['get', ''], ['post', '/verification'], ['post', '/verification/confirm'], ['delete', '']] as const) {
      const r = await (request(a) as any)[m](`/api/v1/me/phone${p}`);
      expect(r.status).toBe(401);
      expect(r.headers['content-type']).toMatch(/json/);
    }
  });

  test('acts only on the caller, whatever the body says', async () => {
    const d = deps({ rpc: jest.fn(async (name: string) => (name === 'phone_verification_begin' ? 'ok' : [{ result: 'ok', phone_e164: DE_MOBILE }])) });
    const a = app({ user_id: ME }, d);
    expect((await request(a).post('/api/v1/me/phone/verification').send({ phone: DE_MOBILE, user_id: 'victim' })).status).toBe(200);
    expect(d.rpc.mock.calls[0][1].p_user_id).toBe(ME);
    expect((await request(a).post('/api/v1/me/phone/verification/confirm').send({ code: '123456', user_id: 'victim' })).status).toBe(200);
    expect(d.updateAuthPhone).toHaveBeenCalledWith(ME, expect.anything());
    expect((await request(a).delete('/api/v1/me/phone')).status).toBe(200);
    expect((await request(a).get('/api/v1/me/phone')).body).toMatchObject({ ok: true, enabled: true });
  });

  test('a thrown dependency is a 502 JSON, never a crash', async () => {
    const a = app({ user_id: ME }, deps({ rpc: jest.fn(async () => { throw new Error('db 500'); }) }));
    const r = await request(a).post('/api/v1/me/phone/verification').send({ phone: DE_MOBILE });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ ok: false, error: 'PHONE_VERIFY_FAILED' });
  });
});

describe('migration 20261012180000_vtid_05095_phone_verification.sql', () => {
  const sql = readFileSync(
    join(__dirname, '../../../supabase/migrations/20261012180000_vtid_05095_phone_verification.sql'),
    'utf8',
  );

  test('one open challenge per member, written atomically', () => {
    expect(sql).toMatch(/user_id\s+uuid NOT NULL UNIQUE/);
    expect(sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(sql.match(/pg_advisory_xact_lock\(hashtext\('phone_verification:' \|\| p_user_id::text\)\)/g)).toHaveLength(2);
  });

  test('both tables are service-role only', () => {
    for (const t of ['phone_verification_challenges', 'phone_verification_sends']) {
      expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`REVOKE ALL ON public.${t} FROM PUBLIC, anon, authenticated;`);
    }
    expect(sql).not.toMatch(/CREATE POLICY/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.phone_verification_begin\([^)]*\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.phone_verification_confirm\([^)]*\) FROM PUBLIC, anon, authenticated;/);
  });

  test('every limit is checked before the challenge is written', () => {
    const begin = sql.slice(sql.indexOf('FUNCTION public.phone_verification_begin'), sql.indexOf('FUNCTION public.phone_verification_confirm'));
    const insertAt = begin.indexOf('INSERT INTO public.phone_verification_challenges');
    for (const v of ["'user_hour'", "'user_day'", "'phone_day'", "'daily_cap'"]) {
      expect(begin.indexOf(`RETURN ${v}`)).toBeGreaterThan(0);
      expect(begin.indexOf(`RETURN ${v}`)).toBeLessThan(insertAt);
    }
  });

  test('the withdrawal trigger fires before on_phone_verified and only for a matchable number going away', () => {
    expect('on_phone_a_withdrawn' < 'on_phone_verified').toBe(true);
    expect(sql).toMatch(/CREATE TRIGGER on_phone_a_withdrawn\s+AFTER UPDATE OF phone_e164, phone_verified, discoverable_by_phone ON public\.profiles/);
    expect(sql).toMatch(/WHEN \(OLD\.phone_verified AND OLD\.discoverable_by_phone AND OLD\.phone_e164 IS NOT NULL/);
    expect(sql).toMatch(/NEW\.phone_e164 IS DISTINCT FROM OLD\.phone_e164/);
  });

  test('un-matching selects phone-linked rows positively and keeps e-mail links (NULL-safe)', () => {
    expect(sql).toContain('OLD.phone_e164 = ANY (c.contact_phone_e164)');
    expect(sql).toMatch(/AND NOT \(c\.contact_email IS NOT NULL AND OLD\.email IS NOT NULL\s+AND lower\(c\.contact_email\) = lower\(OLD\.email\)\)/);
  });
});
