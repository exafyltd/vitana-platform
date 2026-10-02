/**
 * VTID-04809 — user_wallets.CREDITS is the canonical VTNA ledger.
 *
 * Pins the contract between the migration and its callers:
 *  - credit_wallet() is re-created with the exact signature every live caller
 *    uses, and only reward/purchase move VTNA;
 *  - members lose every way to credit themselves;
 *  - reward paths that can pay the same reward share one idempotency key.
 * When a local PostgreSQL server is available the migration is also applied
 * (twice) to a replica of the live wallet tables and the SQL assertions run.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  creditWalletSucceeded,
  referralRewardEventId,
  welcomeBonusEventId,
} from '../src/services/wallet/vtna-reward-keys';

const REPO = path.join(__dirname, '../../..');
const MIGRATION = fs.readFileSync(
  path.join(REPO, 'supabase/migrations/20261001180000_vtid_04809_vtna_reward_ledger.sql'),
  'utf8',
);
const read = (p: string) => fs.readFileSync(path.join(__dirname, '../src', p), 'utf8');

describe('VTID-04809 migration', () => {
  it('re-creates credit_wallet with the signature its callers use', () => {
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.credit_wallet\(\s*p_tenant_id\s+uuid,\s*p_user_id\s+uuid,\s*p_amount\s+integer,\s*p_type\s+text,\s*p_source\s+text,\s*p_source_event_id\s+text,\s*p_description\s+text DEFAULT NULL\s*\)/,
    );
    // Callers keep passing exactly these named params.
    for (const file of [
      'services/diary-streak-celebrator.ts',
      'services/automation-handlers/wallet-payments.ts',
      'routes/billing-repository.ts',
    ]) {
      const src = read(file);
      for (const p of ['p_tenant_id', 'p_user_id', 'p_amount', 'p_type', 'p_source', 'p_source_event_id', 'p_description']) {
        expect(src).toContain(p);
      }
    }
  });

  it('writes to user_wallets.CREDITS with an earned bucket, never wallet_balances', () => {
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS earned_balance');
    expect(MIGRATION).toMatch(/earned_balance >= 0\s+AND earned_balance <= balance/);
    expect(MIGRATION).not.toMatch(/FROM public\.wallet_balances|INTO public\.wallet_balances/);
    expect(MIGRATION).toContain("p_type = 'reward'");
    expect(MIGRATION).toContain("'UNSUPPORTED_TYPE'");
  });

  it('is idempotent per member and source event', () => {
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_user_idempotency_key/);
    expect(MIGRATION).toContain('FOR UPDATE');
    expect(MIGRATION).toContain("'duplicate', true");
  });

  it('closes every member self-credit path', () => {
    expect(MIGRATION).toContain('DROP POLICY IF EXISTS "Users can update their own wallets"');
    expect(MIGRATION).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.user_wallets FROM anon, authenticated/);
    expect(MIGRATION).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.wallet_transactions FROM anon, authenticated/);
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.credit_wallet\([^)]*\) FROM PUBLIC, anon, authenticated/);
    expect(MIGRATION).toContain("IF operation <> 'subtract' THEN");
  });

  it('pegs VTNA to EUR (1 VTNA = EUR 0.01)', () => {
    expect(MIGRATION).toContain("('CREDITS', 'EUR', 0.01::numeric)");
    expect(MIGRATION).toContain("('EUR', 'CREDITS', 100::numeric)");
  });

  const pgBin = (() => {
    try {
      const dirs = fs.readdirSync('/usr/lib/postgresql').sort();
      const bin = `/usr/lib/postgresql/${dirs[dirs.length - 1]}/bin`;
      return fs.existsSync(`${bin}/initdb`) ? bin : null;
    } catch {
      return null;
    }
  })();
  (pgBin ? it : it.skip)('applies twice to a replica of the live tables and passes the SQL assertions', () => {
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-04809-vtna-ledger.sh'), {
      env: { ...process.env, PGBIN: pgBin! },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('VTID-04809: all assertions passed');
  }, 120_000);
});

describe('VTID-04809 reward callers', () => {
  it('no reward path still credits through increment_wallet_balance', () => {
    for (const file of [
      'services/community-autopilot/invites.ts',
      'services/automation-handlers/sharing-growth-repository.ts',
      'services/automation-handlers/onboarding-growth-repository.ts',
    ]) {
      expect(read(file)).not.toContain("'increment_wallet_balance'");
      expect(read(file)).toContain("'credit_wallet'");
    }
  });

  it('both referral paths build the same key, so one referral pays once', () => {
    expect(referralRewardEventId('a', 'b')).toBe('referral_reward:a:b');
    expect(read('services/community-autopilot/invites.ts')).toContain('referralRewardEventId(inviterId, referredId)');
    expect(read('services/automation-handlers/sharing-growth.ts')).toContain('referralRewardEventId(referrer_id, referred_id)');
  });

  it('the welcome bonus is keyed per member', () => {
    expect(welcomeBonusEventId('u1')).toBe('onboarding_welcome_bonus:u1');
  });

  it('treats an RPC error or data.ok !== true as a failed credit', () => {
    expect(creditWalletSucceeded({ ok: true }, null)).toBe(true);
    expect(creditWalletSucceeded({ ok: true, duplicate: true }, null)).toBe(true);
    expect(creditWalletSucceeded({ ok: false, error: 'INSUFFICIENT_BALANCE' }, null)).toBe(false);
    expect(creditWalletSucceeded(null, null)).toBe(false);
    expect(creditWalletSucceeded({ ok: true }, { message: 'x' })).toBe(false);
  });
});
