/**
 * VCAOP Vault (VAULT-CORE-0001, runbook Sec. 4.5).
 *
 * Sits over a SecretStore (Secret Manager in prod). Issues SHORT-LIVED, scoped
 * credentials to worker-core at job time — never long-lived secrets to agents.
 * Stores TOTP seeds and recovery codes (codes are hashed). The DB only ever sees
 * the `*_ref` references returned here (no-credential-store).
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { SecretStore } from './secret-store';
import { totpFromBase32, verifyTotp, base32Decode, TotpOptions } from './totp';

export interface ScopedCredential {
  /** Short-lived scoped token value handed to worker-core. NOT the long-lived secret. */
  token: string;
  accountId: string;
  scope: string;
  expiresAt: number; // epoch ms
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export class Vault {
  constructor(private readonly store: SecretStore) {}

  /** Store a long-lived credential; returns a vault reference for the DB to hold. */
  async putCredential(accountId: string, value: string): Promise<string> {
    return this.store.put(`cred/${accountId}`, value);
  }

  /** Store a TOTP seed (base32). */
  async putTotpSeed(accountId: string, seedBase32: string): Promise<string> {
    base32Decode(seedBase32); // validate up front
    return this.store.put(`totp/${accountId}`, seedBase32);
  }

  /** Store recovery codes — HASHED only; raw codes are never persisted. */
  async putRecoveryCodes(accountId: string, codes: string[]): Promise<string> {
    const hashed = codes.map(sha256);
    return this.store.put(`recovery/${accountId}`, JSON.stringify(hashed));
  }

  /** Consume a recovery code: returns true and removes it if valid (constant-time match). */
  async useRecoveryCode(accountId: string, code: string): Promise<boolean> {
    const ref = `vault://recovery/${accountId}`;
    const raw = await this.store.get(ref);
    if (!raw) return false;
    const hashes: string[] = JSON.parse(raw);
    const target = sha256(code);
    const idx = hashes.findIndex((h) => h.length === target.length && timingSafeEqual(Buffer.from(h), Buffer.from(target)));
    if (idx === -1) return false;
    hashes.splice(idx, 1);
    await this.store.put(`recovery/${accountId}`, JSON.stringify(hashes));
    return true;
  }

  /**
   * Generate the current TOTP code from the vaulted seed. Trusted-service only —
   * the seed never leaves the vault and is never exposed to the agent/LLM.
   */
  async generateTotp(accountId: string, unixTimeSec?: number, opts?: TotpOptions): Promise<string> {
    const seed = await this.store.get(`vault://totp/${accountId}`);
    if (!seed) throw new Error(`no TOTP seed for account ${accountId}`);
    return totpFromBase32(seed, unixTimeSec, opts);
  }

  async verifyTotp(accountId: string, code: string, unixTimeSec?: number, opts?: TotpOptions & { window?: number }): Promise<boolean> {
    const seed = await this.store.get(`vault://totp/${accountId}`);
    if (!seed) return false;
    const t = unixTimeSec ?? Math.floor(Date.now() / 1000);
    return verifyTotp(base32Decode(seed), code, t, opts);
  }

  /**
   * Issue a short-lived, scoped credential for worker-core. The returned token is
   * an ephemeral handle bound to (accountId, scope) with a TTL — NOT the underlying
   * long-lived secret. The long-lived secret stays in the store and is never
   * returned by this method.
   */
  async getScopedShortLivedCredential(accountId: string, scope: string, ttlMs = 5 * 60 * 1000): Promise<ScopedCredential> {
    if (!(await this.store.exists(`vault://cred/${accountId}`))) {
      throw new Error(`no credential for account ${accountId}`);
    }
    return {
      token: `stk_${randomBytes(24).toString('hex')}`,
      accountId,
      scope,
      expiresAt: Date.now() + ttlMs,
    };
  }
}
