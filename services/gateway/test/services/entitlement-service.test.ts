/**
 * entitlement-service.ts — previously had zero test coverage. Added
 * alongside the 2026-08-29 fix for the swallowed wallet_balances error
 * (AURORA-B2-DEAD-CALLSITE-AUDIT.md's addendum): `readWalletBuckets`
 * (private, exercised here via the smallest public path that reaches it,
 * `consumeCredits`) destructured `error` but only ever used it as a
 * boolean short-circuit — never logged it. Pins that a Postgres-level
 * "relation does not exist" error is now logged loudly, without changing
 * the all-zero-buckets fallback.
 */

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({})),
}));

const mockFetchUserSubscription = jest.fn();
const mockFetchFeatureEntitlementConfig = jest.fn();
const mockFetchWalletBalances = jest.fn();
const mockConsumeCreditsRpc = jest.fn();

jest.mock('../../src/services/entitlement-service-repository', () => ({
  fetchUserSubscription: (...args: unknown[]) => mockFetchUserSubscription(...args),
  fetchFeatureEntitlementConfig: (...args: unknown[]) => mockFetchFeatureEntitlementConfig(...args),
  fetchWalletBalances: (...args: unknown[]) => mockFetchWalletBalances(...args),
  consumeCreditsRpc: (...args: unknown[]) => mockConsumeCreditsRpc(...args),
}));

import { consumeCredits } from '../../src/services/entitlement-service';

describe('consumeCredits — readWalletBuckets error handling', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchUserSubscription.mockResolvedValue({
      data: { plan_key: 'pro', status: 'active', current_period_end: null, cancel_at_period_end: false, trial_end: null, metadata: {} },
      error: null,
    });
    mockFetchFeatureEntitlementConfig.mockResolvedValue({
      data: {
        plan_key: 'pro', feature_key: 'voice', quota: 100, window_seconds: 3600,
        unit: 'count', behavior_on_exceed: 'paywall', credit_cost_per_unit: 1,
        allowed_burn_buckets: ['purchased_credits'],
      },
      error: null,
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('on the RPC returning {error} (the wallet_balances-does-not-exist shape): logs it loudly, and buckets fall back to all-zero (unchanged behavior)', async () => {
    mockFetchWalletBalances.mockResolvedValue({
      data: null,
      error: { message: 'relation "wallet_balances" does not exist' },
    });
    mockConsumeCreditsRpc.mockResolvedValue({ data: null, error: { message: 'fn_consume_credits unavailable' } });

    const result = await consumeCredits('u1', 't1', 'voice', 1, 'idem-1');

    // The bug this fix closes: `error` was previously destructured but
    // never logged — only used as `if (error || !data)`.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('readWalletBuckets error (buckets will render as all-zero)'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('relation "wallet_balances" does not exist'));
    // Unchanged: bucket falls back to 'purchased_credits' as if the wallet
    // were genuinely empty (0 reward_credits can't cover the debit).
    expect(mockConsumeCreditsRpc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ p_bucket: 'purchased_credits' }));
    expect(result).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });

  it('on a successful wallet fetch: logs nothing', async () => {
    mockFetchWalletBalances.mockResolvedValue({
      data: { purchased_credits: 10, reward_credits: 5, cash_balance: 0 },
      error: null,
    });
    mockConsumeCreditsRpc.mockResolvedValue({ data: null, error: { message: 'fn_consume_credits unavailable' } });

    await consumeCredits('u1', 't1', 'voice', 1, 'idem-2');

    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('readWalletBuckets error'));
  });
});
