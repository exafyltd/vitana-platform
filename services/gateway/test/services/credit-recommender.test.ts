/**
 * services/recommendation-commissions/credit-recommender.ts — previously had
 * zero test coverage. Added alongside the 2026-08-29 fix for two swallowed
 * errors on the successful-credit path:
 *
 *   1. fetchExistingRecommendationCommission's `error` was never checked —
 *      a Postgres-level failure would silently bypass the idempotency guard
 *      (protected from an actual double-payment only by the underlying
 *      credit_wallet_for_earning ledger UNIQUE constraint, not by this
 *      check).
 *   2. The final insertRecommendationCommission()'s result was fully
 *      discarded — a failure there was completely invisible even though
 *      the function still unconditionally reports status:'credited'.
 *
 * Both are now logged via console.warn without changing any return value
 * or control flow — the wallet-credit outcome (the thing that actually
 * matters) is what the returned status still reflects.
 */

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

const mockCreditWalletForEarning = jest.fn();
jest.mock('../../src/services/wallet/spend-earning-service', () => ({
  creditWalletForEarning: (...args: unknown[]) => mockCreditWalletForEarning(...args),
}));

const mockFetchProductOrderForCommission = jest.fn();
const mockFetchExistingRecommendationCommission = jest.fn();
const mockFetchProductRecommendationForCommission = jest.fn();
const mockFetchMerchantCommissionEligibility = jest.fn();
const mockFetchRecommenderWalletAccount = jest.fn();
const mockInsertRecommendationCommission = jest.fn();
const mockIncrementProductRecommendationStats = jest.fn();

jest.mock('../../src/services/recommendation-commissions/credit-recommender-repository', () => ({
  fetchProductOrderForCommission: (...args: unknown[]) => mockFetchProductOrderForCommission(...args),
  fetchExistingRecommendationCommission: (...args: unknown[]) => mockFetchExistingRecommendationCommission(...args),
  fetchProductRecommendationForCommission: (...args: unknown[]) => mockFetchProductRecommendationForCommission(...args),
  fetchMerchantCommissionEligibility: (...args: unknown[]) => mockFetchMerchantCommissionEligibility(...args),
  fetchRecommenderWalletAccount: (...args: unknown[]) => mockFetchRecommenderWalletAccount(...args),
  insertRecommendationCommission: (...args: unknown[]) => mockInsertRecommendationCommission(...args),
  incrementProductRecommendationStats: (...args: unknown[]) => mockIncrementProductRecommendationStats(...args),
}));

import { creditRecommenderForOrder } from '../../src/services/recommendation-commissions/credit-recommender';

const SB: any = {};
const ORDER = {
  id: 'order-1',
  state: 'converted',
  attribution_recommendation_id: 'rec-1',
  commission_cents: 1000,
  merchant_id: 'merch-1',
  currency: 'eur',
};

describe('creditRecommenderForOrder — successful-credit path error handling', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue(SB);
    mockFetchProductOrderForCommission.mockResolvedValue({ data: ORDER, error: null });
    mockFetchProductRecommendationForCommission.mockResolvedValue({ data: { id: 'rec-1', user_id: 'recommender-1' }, error: null });
    mockFetchMerchantCommissionEligibility.mockResolvedValue({
      data: { recommendation_commission_eligible: true, recommendation_commission_rate_override: 0.5 },
      error: null,
    });
    mockFetchRecommenderWalletAccount.mockResolvedValue({ data: { id: 'acct-1' }, error: null });
    mockCreditWalletForEarning.mockResolvedValue({ ok: true, ledger_entry_id: 'ledger-1' });
    mockIncrementProductRecommendationStats.mockResolvedValue({ error: null });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('on fetchExistingRecommendationCommission returning {error}: logs it, and still proceeds to credit (idempotency guard bypassed, unchanged behavior — protected by the ledger UNIQUE constraint elsewhere)', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });
    mockInsertRecommendationCommission.mockResolvedValue({ error: null });

    const result = await creditRecommenderForOrder('order-1');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchExistingRecommendationCommission error for order=order-1: connection terminated unexpectedly'),
    );
    expect(mockCreditWalletForEarning).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
  });

  it('on the final insertRecommendationCommission returning {error}: logs it, but still reports the accurate credited status (unchanged)', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: null });
    mockInsertRecommendationCommission.mockResolvedValue({
      data: null,
      error: { message: 'duplicate key value violates unique constraint' },
    });

    const result = await creditRecommenderForOrder('order-1');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('insertRecommendationCommission (credited) error for order=order-1: duplicate key value violates unique constraint'),
    );
    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
  });

  it('on a clean run (no errors anywhere): logs nothing', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: null });
    mockInsertRecommendationCommission.mockResolvedValue({ error: null });

    const result = await creditRecommenderForOrder('order-1');

    expect(warnSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
  });

  it('already_credited short-circuits before any wallet credit attempt (unchanged)', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'existing-1' }, error: null });

    const result = await creditRecommenderForOrder('order-1');

    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, status: 'already_credited' });
  });
});
