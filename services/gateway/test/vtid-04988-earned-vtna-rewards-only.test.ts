/**
 * VTID-04988 — earned VTNA is spent only on rewards (owner decision
 * 2026-10-08). Paywall overage is paid from purchased credits:
 *  - consumeCredits never picks reward_credits, even when the feature config
 *    still lists it, the member prefers it, or it alone would cover the debit;
 *  - the migration removes reward_credits from every feature and makes
 *    fn_consume_credits refuse it (SQL harness, when PostgreSQL is installed).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));

const mockFetchUserSubscription = jest.fn();
const mockFetchFeatureEntitlementConfig = jest.fn();
const mockFetchWalletBalances = jest.fn();
const mockConsumeCreditsRpc = jest.fn();
jest.mock('../src/services/entitlement-service-repository', () => ({
  fetchUserSubscription: (...a: unknown[]) => mockFetchUserSubscription(...a),
  fetchFeatureEntitlementConfig: (...a: unknown[]) => mockFetchFeatureEntitlementConfig(...a),
  fetchWalletBalances: (...a: unknown[]) => mockFetchWalletBalances(...a),
  consumeCreditsRpc: (...a: unknown[]) => mockConsumeCreditsRpc(...a),
  insertPaywallEvent: jest.fn().mockResolvedValue({ error: null }),
}));

import { consumeCredits } from '../src/services/entitlement-service';

const REPO = path.join(__dirname, '../../..');

function config(buckets: string[]) {
  return {
    data: {
      plan_key: 'premium', feature_key: 'match_reveals', quota: 50, window_seconds: 2592000,
      unit: 'count', behavior_on_exceed: 'soft_counter', credit_cost_per_unit: 10,
      allowed_burn_buckets: buckets,
    },
    error: null,
  };
}

describe('VTID-04988 consumeCredits never spends earned VTNA', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchUserSubscription.mockResolvedValue({
      data: { plan_key: 'premium', status: 'active', current_period_end: null, cancel_at_period_end: false, trial_end: null, metadata: {} },
      error: null,
    });
    // Plenty of earned VTNA, which used to be drained first.
    mockFetchWalletBalances.mockResolvedValue({ data: { purchased_credits: 100, reward_credits: 5000, cash_balance: 0 }, error: null });
    mockConsumeCreditsRpc.mockResolvedValue({ data: { ok: true, bucket: 'purchased_credits', bucket_balance: 90 }, error: null });
  });

  const bucketSent = () => (mockConsumeCreditsRpc.mock.calls[0][1] as { p_bucket: string }).p_bucket;

  it('uses purchased credits even when the config still lists reward_credits and it would cover the debit', async () => {
    mockFetchFeatureEntitlementConfig.mockResolvedValue(config(['purchased_credits', 'reward_credits']));
    await consumeCredits('u1', 't1', 'match_reveals', 1, 'idem-1');
    expect(bucketSent()).toBe('purchased_credits');
  });

  it('ignores a caller preference for reward_credits', async () => {
    mockFetchFeatureEntitlementConfig.mockResolvedValue(config(['purchased_credits', 'reward_credits']));
    await consumeCredits('u1', 't1', 'match_reveals', 1, 'idem-2', 'reward_credits');
    expect(bucketSent()).toBe('purchased_credits');
  });

  it('keeps honouring an allowed purchased_credits preference', async () => {
    mockFetchFeatureEntitlementConfig.mockResolvedValue(config(['purchased_credits']));
    await consumeCredits('u1', 't1', 'match_reveals', 2, 'idem-3', 'purchased_credits');
    expect(mockConsumeCreditsRpc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      p_bucket: 'purchased_credits', p_credits: 20, p_feature_key: 'match_reveals', p_idempotency_key: 'idem-3',
    }));
  });
});

describe('VTID-04988 migration', () => {
  const sql = fs.readFileSync(path.join(REPO, 'supabase/migrations/20261008190000_vtid_04988_earned_vtna_rewards_only.sql'), 'utf8');

  it('removes reward_credits from every feature and refuses it in fn_consume_credits', () => {
    expect(sql).toContain("SET allowed_burn_buckets = array_remove(allowed_burn_buckets, 'reward_credits')");
    expect(sql).toMatch(/ELSIF p_bucket = 'reward_credits' THEN\s+-- VTID-04988[^\n]*\n\s+RETURN jsonb_build_object\(\s+'ok', false,\s+'error', 'BUCKET_NOT_SPENDABLE'/);
    expect(sql).not.toContain("v_type := 'reward'");
    expect(sql).toContain('a feature still allows spending earned VTNA');
  });

  it('keeps the VTID-04981 lockdown: members cannot execute it', () => {
    expect(sql).toContain('FROM PUBLIC, anon, authenticated;');
    expect(sql).not.toMatch(/GRANT[^;]*fn_consume_credits[^;]*authenticated/i);
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
  (pgBin ? it : it.skip)('applies twice over the live shapes and passes the SQL assertions', () => {
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-04988-rewards-only.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55442' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('VTID-04988: all assertions passed');
  }, 120_000);
});
