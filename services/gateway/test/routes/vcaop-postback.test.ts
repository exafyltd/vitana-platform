/**
 * Unit tests for the public VCAOP affiliate postback receiver.
 * Covers the security-critical bits: fail-closed key verification (auth) and
 * the network-status -> ledger-state mapping (happy + error paths).
 */
import { keyOk, mapStatus } from '../../src/routes/vcaop-postback';

describe('vcaop-postback', () => {
  const ORIGINAL = process.env.ADMITAD_POSTBACK_KEY;
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.ADMITAD_POSTBACK_KEY;
    else process.env.ADMITAD_POSTBACK_KEY = ORIGINAL;
  });

  describe('keyOk — fail-closed auth', () => {
    test('rejects when no key is configured (fail closed)', () => {
      delete process.env.ADMITAD_POSTBACK_KEY;
      expect(keyOk('anything')).toBe(false);
    });
    test('rejects an empty provided key', () => {
      process.env.ADMITAD_POSTBACK_KEY = 'super-secret-postback-key';
      expect(keyOk('')).toBe(false);
    });
    test('rejects a wrong key', () => {
      process.env.ADMITAD_POSTBACK_KEY = 'super-secret-postback-key';
      expect(keyOk('not-the-key')).toBe(false);
    });
    test('accepts the exact key', () => {
      process.env.ADMITAD_POSTBACK_KEY = 'super-secret-postback-key';
      expect(keyOk('super-secret-postback-key')).toBe(true);
    });
    test('a length mismatch does not throw (timingSafeEqual guard)', () => {
      process.env.ADMITAD_POSTBACK_KEY = 'super-secret-postback-key';
      expect(() => keyOk('short')).not.toThrow();
      expect(keyOk('short')).toBe(false);
    });
  });

  describe('mapStatus — network status -> ledger state', () => {
    test.each(['approved', 'confirmed', 'paid', 'done', '1', 'APPROVED', ' Approved '])(
      'confirms %p', (s) => expect(mapStatus(s)).toBe('confirmed'),
    );
    test.each(['declined', 'rejected', 'cancelled', 'canceled', 'reversed', '2'])(
      'reverses %p', (s) => expect(mapStatus(s)).toBe('reversed'),
    );
    test.each(['pending', 'open', '', 'something-else'])(
      'defaults %p to pending', (s) => expect(mapStatus(s)).toBe('pending'),
    );
  });
});
