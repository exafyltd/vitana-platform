import { hotp, totp, base32Decode, verifyTotp } from '../../src/vault/totp';

// RFC 4226 Appendix D — HOTP SHA1 test vectors, secret "12345678901234567890".
const HOTP_KEY = Buffer.from('12345678901234567890', 'ascii');
const HOTP_EXPECTED = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];

// RFC 6238 Appendix B — TOTP SHA1 test vectors (8 digits), same ASCII seed.
const TOTP_SHA1_KEY = Buffer.from('12345678901234567890', 'ascii');
const TOTP_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP/HOTP (RFC 4226 / RFC 6238)', () => {
  test('HOTP SHA1 matches RFC 4226 Appendix D vectors', () => {
    HOTP_EXPECTED.forEach((expected, counter) => {
      expect(hotp(HOTP_KEY, counter, { digits: 6, algorithm: 'sha1' })).toBe(expected);
    });
  });

  test('TOTP SHA1 matches RFC 6238 Appendix B vectors (8 digits)', () => {
    for (const [time, expected] of TOTP_VECTORS) {
      expect(totp(TOTP_SHA1_KEY, time, { digits: 8, step: 30, algorithm: 'sha1' })).toBe(expected);
    }
  });

  test('base32 decode round-trips a known seed', () => {
    // "12345678901234567890" in base32 is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    const decoded = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(decoded.toString('ascii')).toBe('12345678901234567890');
  });

  test('verifyTotp accepts code within +/-1 step window, rejects outside', () => {
    const t = 1111111111;
    const code = totp(TOTP_SHA1_KEY, t, { digits: 8, algorithm: 'sha1' });
    expect(verifyTotp(TOTP_SHA1_KEY, code, t + 30, { digits: 8, algorithm: 'sha1', window: 1 })).toBe(true);
    expect(verifyTotp(TOTP_SHA1_KEY, code, t + 300, { digits: 8, algorithm: 'sha1', window: 1 })).toBe(false);
  });
});
