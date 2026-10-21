/**
 * VTID-04606 — Unit tests for services/gateway/src/lib/ai-credential-crypto.ts
 * AES-256-GCM helpers for encrypted third-party AI credentials.
 * Test-only change: source file is not modified.
 */

import {
  encryptApiKey,
  decryptApiKey,
  toBuffer,
  isCredentialCryptoConfigured,
} from '../src/lib/ai-credential-crypto';

// A deterministic 32-byte (64 hex char) test key — never a real secret.
const TEST_KEY_HEX = 'a'.repeat(64); // 32 bytes of 0xaa

const ENV_VAR = 'AI_CREDENTIALS_ENC_KEY';

describe('ai-credential-crypto', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env[ENV_VAR];
    process.env[ENV_VAR] = TEST_KEY_HEX;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = originalKey;
    }
  });

  // ── round-trip ──────────────────────────────────────────────────────────────

  it('encrypt then decrypt round-trip returns the original plaintext', () => {
    const plaintext = 'sk-test-supersecret-api-key-12345';
    const enc = encryptApiKey(plaintext);
    expect(enc).not.toBeNull();
    const dec = decryptApiKey(enc!.ciphertext, enc!.iv, enc!.tag);
    expect(dec).toBe(plaintext);
  });

  it('round-trips an empty string', () => {
    const enc = encryptApiKey('');
    expect(enc).not.toBeNull();
    expect(decryptApiKey(enc!.ciphertext, enc!.iv, enc!.tag)).toBe('');
  });

  it('round-trips a unicode / multi-byte string', () => {
    const plaintext = '🔑 Ключ доступа — tëst';
    const enc = encryptApiKey(plaintext);
    expect(enc).not.toBeNull();
    expect(decryptApiKey(enc!.ciphertext, enc!.iv, enc!.tag)).toBe(plaintext);
  });

  // ── fresh IV per encryption ─────────────────────────────────────────────────

  it('each encryption uses a fresh 12-byte IV (two encryptions of the same text differ)', () => {
    const plaintext = 'same-plaintext';
    const enc1 = encryptApiKey(plaintext)!;
    const enc2 = encryptApiKey(plaintext)!;

    expect(enc1.iv.length).toBe(12);
    expect(enc2.iv.length).toBe(12);

    // IVs must differ (probability of collision is negligible for random 12-byte values)
    expect(enc1.iv.equals(enc2.iv)).toBe(false);

    // Ciphertexts must also differ because the IV is part of the stream
    expect(enc1.ciphertext.equals(enc2.ciphertext)).toBe(false);
  });

  // ── tamper detection ────────────────────────────────────────────────────────

  it('a tampered ciphertext byte makes decryptApiKey return null', () => {
    const enc = encryptApiKey('sensitive-value')!;
    const badCiphertext = Buffer.from(enc.ciphertext);
    badCiphertext[0] ^= 0xff; // flip all bits in first byte

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = decryptApiKey(badCiphertext, enc.iv, enc.tag);
    spy.mockRestore();

    expect(result).toBeNull();
  });

  it('a tampered auth tag makes decryptApiKey return null', () => {
    const enc = encryptApiKey('sensitive-value')!;
    const badTag = Buffer.from(enc.tag);
    badTag[0] ^= 0xff;

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = decryptApiKey(enc.ciphertext, enc.iv, badTag);
    spy.mockRestore();

    expect(result).toBeNull();
  });

  it('a tampered IV makes decryptApiKey return null', () => {
    const enc = encryptApiKey('sensitive-value')!;
    const badIv = Buffer.from(enc.iv);
    badIv[0] ^= 0xff;

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = decryptApiKey(enc.ciphertext, badIv, enc.tag);
    spy.mockRestore();

    expect(result).toBeNull();
  });

  // ── missing key ─────────────────────────────────────────────────────────────

  describe('when AI_CREDENTIALS_ENC_KEY is not set', () => {
    beforeEach(() => {
      delete process.env[ENV_VAR];
    });

    it('encryptApiKey returns null', () => {
      expect(encryptApiKey('anything')).toBeNull();
    });

    it('decryptApiKey returns null', () => {
      const fakeCtx = Buffer.alloc(16);
      const fakeIv = Buffer.alloc(12);
      const fakeTag = Buffer.alloc(16);
      expect(decryptApiKey(fakeCtx, fakeIv, fakeTag)).toBeNull();
    });

    it('isCredentialCryptoConfigured returns false', () => {
      expect(isCredentialCryptoConfigured()).toBe(false);
    });
  });

  // ── key length validation ───────────────────────────────────────────────────

  describe('when AI_CREDENTIALS_ENC_KEY is not 32 bytes', () => {
    it('encryptApiKey returns null for a 16-byte (too short) key', () => {
      process.env[ENV_VAR] = 'bb'.repeat(16); // 16 bytes = 32 hex chars

      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = encryptApiKey('test');
      spy.mockRestore();

      expect(result).toBeNull();
    });

    it('encryptApiKey returns null for a 64-byte (too long) key', () => {
      process.env[ENV_VAR] = 'cc'.repeat(64); // 64 bytes = 128 hex chars

      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = encryptApiKey('test');
      spy.mockRestore();

      expect(result).toBeNull();
    });

    it('decryptApiKey returns null for a wrong-length key', () => {
      process.env[ENV_VAR] = 'dd'.repeat(16); // 16 bytes

      const fakeCtx = Buffer.alloc(16);
      const fakeIv = Buffer.alloc(12);
      const fakeTag = Buffer.alloc(16);

      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = decryptApiKey(fakeCtx, fakeIv, fakeTag);
      spy.mockRestore();

      expect(result).toBeNull();
    });

    it('isCredentialCryptoConfigured returns false for a wrong-length key', () => {
      process.env[ENV_VAR] = 'ee'.repeat(16); // 16 bytes

      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = isCredentialCryptoConfigured();
      spy.mockRestore();

      expect(result).toBe(false);
    });
  });

  // ── isCredentialCryptoConfigured ────────────────────────────────────────────

  it('isCredentialCryptoConfigured returns true when a valid 32-byte key is set', () => {
    expect(isCredentialCryptoConfigured()).toBe(true);
  });

  // ── toBuffer ─────────────────────────────────────────────────────────────────

  describe('toBuffer', () => {
    it('returns the same Buffer when passed a Buffer', () => {
      const buf = Buffer.from([0x01, 0x02, 0x03]);
      const result = toBuffer(buf);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result!.equals(buf)).toBe(true);
    });

    it('converts a Uint8Array to a Buffer', () => {
      const u8 = new Uint8Array([0x0a, 0x0b, 0x0c]);
      const result = toBuffer(u8);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result!.equals(Buffer.from(u8))).toBe(true);
    });

    it('handles a \\x-prefixed hex string (Supabase bytea format)', () => {
      const hex = '\\x0a0b0c';
      const result = toBuffer(hex);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result!.equals(Buffer.from([0x0a, 0x0b, 0x0c]))).toBe(true);
    });

    it('handles a plain hex string without \\x prefix', () => {
      const hex = '0a0b0c';
      const result = toBuffer(hex);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result!.equals(Buffer.from([0x0a, 0x0b, 0x0c]))).toBe(true);
    });

    it('returns null for null', () => {
      expect(toBuffer(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(toBuffer(undefined)).toBeNull();
    });

    it('returns null for an empty string', () => {
      // Buffer.from('', 'hex') produces an empty Buffer (length 0), which is
      // falsy-ish but not null — the function returns it. Verify the actual
      // behaviour rather than assuming.
      const result = toBuffer('');
      // An empty hex string decodes to an empty Buffer (length 0), which is
      // still a Buffer (not null). The source code returns null only when v is
      // falsy; an empty string IS falsy, so it returns null.
      expect(result).toBeNull();
    });

    it('returns null for a non-string, non-Buffer, non-Uint8Array value', () => {
      expect(toBuffer(42)).toBeNull();
      expect(toBuffer({})).toBeNull();
    });
  });
});
