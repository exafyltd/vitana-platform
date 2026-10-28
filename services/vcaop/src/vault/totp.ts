/**
 * RFC-6238 TOTP / RFC-4226 HOTP (VAULT-CORE-0001, runbook Sec. 4.5).
 *
 * Runs in the trusted vault service ONLY — never in the LLM/agent context. Used to
 * generate the time-based code at job time from a vaulted seed. Verified against
 * the RFC-6238 Appendix B test vectors (see totp.test.ts).
 */
import { createHmac } from 'crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  digits?: number; // default 6
  step?: number; // seconds, default 30
  t0?: number; // epoch start, default 0
  algorithm?: TotpAlgorithm; // default sha1
}

/** RFC-4648 base32 decode (no padding required). */
export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** HOTP(K, C) — RFC 4226. `key` is the raw secret; `counter` is the moving factor. */
export function hotp(key: Buffer, counter: number, opts: TotpOptions = {}): string {
  const digits = opts.digits ?? 6;
  const algorithm = opts.algorithm ?? 'sha1';

  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (safe-integer range is plenty for TOTP).
  buf.writeBigUInt64BE(BigInt(counter));

  const hs = createHmac(algorithm, key).update(buf).digest();
  const offset = hs[hs.length - 1] & 0x0f;
  const binary =
    ((hs[offset] & 0x7f) << 24) |
    ((hs[offset + 1] & 0xff) << 16) |
    ((hs[offset + 2] & 0xff) << 8) |
    (hs[offset + 3] & 0xff);
  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

/** TOTP from a raw key buffer at a given unix time (seconds). */
export function totp(key: Buffer, unixTimeSec: number, opts: TotpOptions = {}): string {
  const step = opts.step ?? 30;
  const t0 = opts.t0 ?? 0;
  const counter = Math.floor((unixTimeSec - t0) / step);
  return hotp(key, counter, opts);
}

/** Convenience: TOTP from a base32 seed at `unixTimeSec` (defaults to now). */
export function totpFromBase32(seedB32: string, unixTimeSec: number = Math.floor(Date.now() / 1000), opts: TotpOptions = {}): string {
  return totp(base32Decode(seedB32), unixTimeSec, opts);
}

/** Verify a code within +/- `window` steps (default 1) of `unixTimeSec`. */
export function verifyTotp(key: Buffer, code: string, unixTimeSec: number, opts: TotpOptions & { window?: number } = {}): boolean {
  const step = opts.step ?? 30;
  const window = opts.window ?? 1;
  for (let w = -window; w <= window; w++) {
    if (totp(key, unixTimeSec + w * step, opts) === code) return true;
  }
  return false;
}
