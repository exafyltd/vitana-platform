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
  insertCommissionSkippedIneligibleEvent: (...args: unknown[]) => mockInsertEvent(...args),
  incrementProductRecommendationStats: (...args: unknown[]) => mockIncrementProductRecommendationStats(...args),
}));

const mockFetchExcluded = jest.fn();
jest.mock('../../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIds: (...args: unknown[]) => mockFetchExcluded(...args),
}));

const mockInsertEvent = jest.fn();

import { creditRecommenderForOrder } from '../../src/services/recommendation-commissions/credit-recommender';

const SB: any = {};
const ORDER = {
  id: 'order-1',
  state: 'converted',
  attribution_recommendation_id: 'rec-1',
  commission_cents: 1000,
  merchant_id: 'merch-1',
  currency: 'eur',
  product_id: 'prod-1',
  user_id: 'buyer-1',
};
const REC = { id: 'rec-1', user_id: 'recommender-1', product_id: 'prod-1', status: 'active' };

describe('creditRecommenderForOrder — successful-credit path error handling', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue(SB);
    mockFetchProductOrderForCommission.mockResolvedValue({ data: ORDER, error: null });
    mockFetchProductRecommendationForCommission.mockResolvedValue({ data: REC, error: null });
    mockFetchExcluded.mockResolvedValue(new Set());
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

describe('creditRecommenderForOrder — swallowed-error fixes (BOOTSTRAP-AURORA-CUTOVER)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue(SB);
    mockFetchProductOrderForCommission.mockResolvedValue({ data: ORDER, error: null });
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: null });
    mockFetchProductRecommendationForCommission.mockResolvedValue({ data: REC, error: null });
    mockFetchExcluded.mockResolvedValue(new Set());
    mockFetchMerchantCommissionEligibility.mockResolvedValue({
      data: { recommendation_commission_eligible: true, recommendation_commission_rate_override: 0.5 },
      error: null,
    });
    mockFetchRecommenderWalletAccount.mockResolvedValue({ data: { id: 'acct-1' }, error: null });
    mockCreditWalletForEarning.mockResolvedValue({ ok: true, ledger_entry_id: 'ledger-1' });
    mockInsertRecommendationCommission.mockResolvedValue({ error: null });
    mockIncrementProductRecommendationStats.mockResolvedValue({ error: null });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('fetchProductRecommendationForCommission error: does NOT report skipped_no_recommendation (indistinguishable from "no recommendation exists"), logs and reports failed instead', async () => {
    mockFetchProductRecommendationForCommission.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const result = await creditRecommenderForOrder('order-1');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchProductRecommendationForCommission error for order=order-1: connection terminated unexpectedly'),
    );
    expect(result).toEqual({ ok: false, status: 'failed', message: 'RECOMMENDATION_LOOKUP_FAILED' });
    expect(mockFetchMerchantCommissionEligibility).not.toHaveBeenCalled();
    expect(mockInsertRecommendationCommission).not.toHaveBeenCalled();
  });

  it('fetchMerchantCommissionEligibility error: does NOT write a permanent skipped_ineligible row, logs and reports failed instead', async () => {
    mockFetchMerchantCommissionEligibility.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const result = await creditRecommenderForOrder('order-1');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchMerchantCommissionEligibility error for order=order-1: connection terminated unexpectedly'),
    );
    expect(result).toEqual({ ok: false, status: 'failed', message: 'MERCHANT_LOOKUP_FAILED' });
    expect(mockInsertRecommendationCommission).not.toHaveBeenCalled();
  });

  it('fetchRecommenderWalletAccount error: reports a distinct DB-failure message rather than RECOMMENDER_WALLET_NOT_FOUND', async () => {
    mockFetchRecommenderWalletAccount.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const result = await creditRecommenderForOrder('order-1');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchRecommenderWalletAccount error for order=order-1: connection terminated unexpectedly'),
    );
    expect(result).toEqual({ ok: false, status: 'failed', message: 'RECOMMENDER_WALLET_LOOKUP_FAILED' });
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
  });

  it('fetchRecommenderWalletAccount genuinely-not-found (no error) still reports RECOMMENDER_WALLET_NOT_FOUND (unchanged)', async () => {
    mockFetchRecommenderWalletAccount.mockResolvedValue({ data: null, error: null });

    const result = await creditRecommenderForOrder('order-1');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, status: 'failed', message: 'RECOMMENDER_WALLET_NOT_FOUND' });
  });
});

describe('creditRecommenderForOrder — referral must count before anyone is paid (VTID-04735)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue(SB);
    mockFetchProductOrderForCommission.mockResolvedValue({ data: ORDER, error: null });
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: null });
    mockFetchProductRecommendationForCommission.mockResolvedValue({ data: REC, error: null });
    mockFetchExcluded.mockResolvedValue(new Set());
    mockFetchMerchantCommissionEligibility.mockResolvedValue({
      data: { recommendation_commission_eligible: true, recommendation_commission_rate_override: 0.5 },
      error: null,
    });
    mockFetchRecommenderWalletAccount.mockResolvedValue({ data: { id: 'acct-1' }, error: null });
    mockCreditWalletForEarning.mockResolvedValue({ ok: true, ledger_entry_id: 'ledger-1' });
    mockInsertRecommendationCommission.mockResolvedValue({ error: null });
    mockInsertEvent.mockResolvedValue({ error: null });
    mockIncrementProductRecommendationStats.mockResolvedValue({ error: null });
  });

  const cases: Array<[string, () => void, string]> = [
    ['self-referral (the recommender bought it)', () => mockFetchProductOrderForCommission.mockResolvedValue({ data: { ...ORDER, user_id: 'recommender-1' }, error: null }), 'self_referral'],
    ['a referral for another product', () => mockFetchProductRecommendationForCommission.mockResolvedValue({ data: { ...REC, product_id: 'prod-other' }, error: null }), 'product_mismatch'],
    ['a disabled referral', () => mockFetchProductRecommendationForCommission.mockResolvedValue({ data: { ...REC, status: 'disabled' }, error: null }), 'disabled'],
    ['a test or service account as recommender', () => mockFetchExcluded.mockResolvedValue(new Set(['recommender-1'])), 'excluded_account'],
  ];

  it.each(cases)('%s: no wallet credit, a permanent skipped row with payout 0, and an OASIS event', async (_name, arrange, reason) => {
    arrange();
    const result = await creditRecommenderForOrder('order-1');

    expect(result).toEqual({ ok: true, status: 'skipped_invalid_referral', message: reason });
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
    expect(mockIncrementProductRecommendationStats).not.toHaveBeenCalled();
    expect(mockInsertRecommendationCommission).toHaveBeenCalledWith(SB, expect.objectContaining({
      product_order_id: 'order-1', status: 'skipped_ineligible', payout_amount_minor: 0,
    }));
    expect(mockInsertEvent).toHaveBeenCalledWith(SB, expect.objectContaining({
      type: 'marketplace.recommendation.commission_skipped_invalid_referral',
      metadata: expect.objectContaining({ reason }),
    }));
  });

  it('an anonymous buyer (no user on the order) is not a self-referral: the valid referral is credited', async () => {
    mockFetchProductOrderForCommission.mockResolvedValue({ data: { ...ORDER, user_id: null }, error: null });
    const result = await creditRecommenderForOrder('order-1');
    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
    expect(mockCreditWalletForEarning).toHaveBeenCalledTimes(1);
  });
});
