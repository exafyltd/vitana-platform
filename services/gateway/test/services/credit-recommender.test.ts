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
const mockFetchReturnWindowSetting = jest.fn();
const mockFetchDuePendingCommissions = jest.fn();
const mockUpdateCommissionIfStatus = jest.fn();

jest.mock('../../src/services/recommendation-commissions/credit-recommender-repository', () => ({
  fetchProductOrderForCommission: (...args: unknown[]) => mockFetchProductOrderForCommission(...args),
  fetchExistingRecommendationCommission: (...args: unknown[]) => mockFetchExistingRecommendationCommission(...args),
  fetchProductRecommendationForCommission: (...args: unknown[]) => mockFetchProductRecommendationForCommission(...args),
  fetchMerchantCommissionEligibility: (...args: unknown[]) => mockFetchMerchantCommissionEligibility(...args),
  fetchRecommenderWalletAccount: (...args: unknown[]) => mockFetchRecommenderWalletAccount(...args),
  insertRecommendationCommission: (...args: unknown[]) => mockInsertRecommendationCommission(...args),
  insertCommissionSkippedIneligibleEvent: (...args: unknown[]) => mockInsertEvent(...args),
  incrementProductRecommendationStats: (...args: unknown[]) => mockIncrementProductRecommendationStats(...args),
  fetchReturnWindowSetting: (...args: unknown[]) => mockFetchReturnWindowSetting(...args),
  fetchDuePendingCommissions: (...args: unknown[]) => mockFetchDuePendingCommissions(...args),
  updateCommissionIfStatus: (...args: unknown[]) => mockUpdateCommissionIfStatus(...args),
}));

const mockFetchExcluded = jest.fn();
jest.mock('../../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...args: unknown[]) => mockFetchExcluded(...args),
}));

const mockInsertEvent = jest.fn();

import {
  confirmDueRecommendationCommissions,
  creditRecommenderForOrder,
  reverseRecommendationCommissionForOrder,
} from '../../src/services/recommendation-commissions/credit-recommender';

// VTID-04741: the pre-existing tests exercise the immediate-payment path, which
// is now the network-approved one (e.g. Awin approved).
const NET = { networkConfirmed: true };

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
    mockFetchExcluded.mockResolvedValue({ ok: true, ids: new Set() });
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

    const result = await creditRecommenderForOrder('order-1', NET);

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

    const result = await creditRecommenderForOrder('order-1', NET);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('insertRecommendationCommission (credited) error for order=order-1: duplicate key value violates unique constraint'),
    );
    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
  });

  it('on a clean run (no errors anywhere): logs nothing', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: null });
    mockInsertRecommendationCommission.mockResolvedValue({ error: null });

    const result = await creditRecommenderForOrder('order-1', NET);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
  });

  it('already_credited short-circuits before any wallet credit attempt (unchanged)', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'existing-1' }, error: null });

    const result = await creditRecommenderForOrder('order-1', NET);

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
    mockFetchExcluded.mockResolvedValue({ ok: true, ids: new Set() });
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

    const result = await creditRecommenderForOrder('order-1', NET);

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

    const result = await creditRecommenderForOrder('order-1', NET);

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

    const result = await creditRecommenderForOrder('order-1', NET);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchRecommenderWalletAccount error for order=order-1: connection terminated unexpectedly'),
    );
    expect(result).toEqual({ ok: false, status: 'failed', message: 'RECOMMENDER_WALLET_LOOKUP_FAILED' });
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
  });

  it('fetchRecommenderWalletAccount genuinely-not-found (no error) still reports RECOMMENDER_WALLET_NOT_FOUND (unchanged)', async () => {
    mockFetchRecommenderWalletAccount.mockResolvedValue({ data: null, error: null });

    const result = await creditRecommenderForOrder('order-1', NET);

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
    mockFetchExcluded.mockResolvedValue({ ok: true, ids: new Set() });
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
    ['a test or service account as recommender', () => mockFetchExcluded.mockResolvedValue({ ok: true, ids: new Set(['recommender-1']) }), 'excluded_account'],
  ];

  it.each(cases)('%s: no wallet credit, a permanent skipped row with payout 0, and an OASIS event', async (_name, arrange, reason) => {
    arrange();
    const result = await creditRecommenderForOrder('order-1', NET);

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

  it('fails closed when the test/service-account list cannot be read: no credit, nothing permanent written', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchExcluded.mockResolvedValue({ ok: false, error: 'connection terminated unexpectedly' });

    const result = await creditRecommenderForOrder('order-1', NET);

    expect(result).toEqual({ ok: false, status: 'failed', message: 'EXCLUSION_LOOKUP_FAILED' });
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
    expect(mockInsertRecommendationCommission).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('excluded-account lookup failed for order=order-1'));
    errorSpy.mockRestore();
  });

  it('an anonymous buyer (no user on the order) is not a self-referral: the valid referral is credited', async () => {
    mockFetchProductOrderForCommission.mockResolvedValue({ data: { ...ORDER, user_id: null }, error: null });
    const result = await creditRecommenderForOrder('order-1', NET);
    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
    expect(mockCreditWalletForEarning).toHaveBeenCalledTimes(1);
  });
});

describe('VTID-04741: hold until the return window, then confirm or reverse', () => {
  const PENDING_ROW = {
    id: 'rc-1', product_order_id: 'order-1', product_recommendation_id: 'rec-1', recommender_user_id: 'recommender-1',
    payout_amount_minor: 500, currency: 'EUR', rate_applied: 0.5, vitana_commission_cents: 1000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue(SB);
    mockFetchProductOrderForCommission.mockResolvedValue({ data: ORDER, error: null });
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: null });
    mockFetchProductRecommendationForCommission.mockResolvedValue({ data: REC, error: null });
    mockFetchExcluded.mockResolvedValue({ ok: true, ids: new Set() });
    mockFetchMerchantCommissionEligibility.mockResolvedValue({
      data: { recommendation_commission_eligible: true, recommendation_commission_rate_override: 0.5 },
      error: null,
    });
    mockFetchReturnWindowSetting.mockResolvedValue({ data: { value: { days: 30 } }, error: null });
    mockFetchRecommenderWalletAccount.mockResolvedValue({ data: { id: 'acct-1' }, error: null });
    mockCreditWalletForEarning.mockResolvedValue({ ok: true, ledger_entry_id: 'ledger-1' });
    mockInsertRecommendationCommission.mockResolvedValue({ error: null });
    mockInsertEvent.mockResolvedValue({ error: null });
    mockIncrementProductRecommendationStats.mockResolvedValue({ error: null });
    mockUpdateCommissionIfStatus.mockResolvedValue({ data: [{ id: 'rc-1' }], error: null });
  });

  it('a conversion the network has not approved is held as pending: nothing reaches the wallet', async () => {
    const before = Date.now();
    const result = await creditRecommenderForOrder('order-1');

    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'pending', payout_minor: 500 }));
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
    expect(mockIncrementProductRecommendationStats).not.toHaveBeenCalled();
    const row = mockInsertRecommendationCommission.mock.calls[0][1];
    expect(row).toMatchObject({ status: 'pending', payout_amount_minor: 500, product_order_id: 'order-1' });
    const confirmAfter = Date.parse(row.confirm_after);
    expect(confirmAfter - before).toBeGreaterThanOrEqual(30 * 86400000 - 1000);
    expect(confirmAfter - before).toBeLessThanOrEqual(30 * 86400000 + 5000);
  });

  it('the return window comes from admin_settings and falls back to 30 days on a bad value', async () => {
    mockFetchReturnWindowSetting.mockResolvedValue({ data: { value: { days: 14 } }, error: null });
    await creditRecommenderForOrder('order-1');
    const d14 = Date.parse(mockInsertRecommendationCommission.mock.calls[0][1].confirm_after) - Date.now();
    expect(Math.round(d14 / 86400000)).toBe(14);

    mockInsertRecommendationCommission.mockClear();
    mockFetchReturnWindowSetting.mockResolvedValue({ data: { value: { days: -3 } }, error: null });
    await creditRecommenderForOrder('order-1');
    const dDefault = Date.parse(mockInsertRecommendationCommission.mock.calls[0][1].confirm_after) - Date.now();
    expect(Math.round(dDefault / 86400000)).toBe(30);
  });

  it('a network-approved conversion is paid at once and records confirmed_at', async () => {
    const result = await creditRecommenderForOrder('order-1', NET);
    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
    expect(mockInsertRecommendationCommission).toHaveBeenCalledWith(SB, expect.objectContaining({ status: 'credited', confirmed_at: expect.any(String) }));
  });

  it('confirm: a due pending commission on a still-converted order is paid and moved to credited, guarded on status', async () => {
    mockFetchDuePendingCommissions.mockResolvedValue({ data: [PENDING_ROW], error: null });
    const r = await confirmDueRecommendationCommissions();

    expect(r).toEqual({ ok: true, examined: 1, credited: 1, reversed: 0, failed: 0 });
    expect(mockCreditWalletForEarning).toHaveBeenCalledWith(expect.objectContaining({
      account_id: 'acct-1', amount_minor: 500, reference_type: 'recommendation_commission', reference_id: 'order-1',
    }));
    expect(mockUpdateCommissionIfStatus).toHaveBeenCalledWith(SB, 'rc-1', 'pending', expect.objectContaining({
      status: 'credited', wallet_ledger_entry_id: 'ledger-1',
    }));
    expect(mockIncrementProductRecommendationStats).toHaveBeenCalledTimes(1);
  });

  it.each(['refunded', 'cancelled', 'chargeback'])('confirm: an order %s during the window is reversed, never paid', async (state) => {
    mockFetchDuePendingCommissions.mockResolvedValue({ data: [PENDING_ROW], error: null });
    mockFetchProductOrderForCommission.mockResolvedValue({ data: { ...ORDER, state }, error: null });
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'rc-1', status: 'pending' }, error: null });

    const r = await confirmDueRecommendationCommissions();

    expect(r).toEqual({ ok: true, examined: 1, credited: 0, reversed: 1, failed: 0 });
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
    expect(mockUpdateCommissionIfStatus).toHaveBeenCalledWith(SB, 'rc-1', 'pending', expect.objectContaining({
      status: 'reversed', reversal_reason: `order_${state}`,
    }));
  });

  it('confirm: a recommender without a wallet stays pending for the next run', async () => {
    mockFetchDuePendingCommissions.mockResolvedValue({ data: [PENDING_ROW], error: null });
    mockFetchRecommenderWalletAccount.mockResolvedValue({ data: null, error: null });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const r = await confirmDueRecommendationCommissions();

    expect(r).toEqual({ ok: true, examined: 1, credited: 0, reversed: 0, failed: 1 });
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
    expect(mockUpdateCommissionIfStatus).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('reverse: a pending commission becomes reversed with an OASIS event', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'rc-1', status: 'pending' }, error: null });
    expect(await reverseRecommendationCommissionForOrder('order-1', 'network_declined')).toEqual({ ok: true, status: 'reversed' });
    expect(mockInsertEvent).toHaveBeenCalledWith(SB, expect.objectContaining({ type: 'marketplace.recommendation.commission_reversed' }));
  });

  it('reverse: an already-paid commission is not silently kept — it raises the after-payout exception event', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'rc-1', status: 'credited' }, error: null });
    expect(await reverseRecommendationCommissionForOrder('order-1', 'network_declined')).toEqual({ ok: true, status: 'paid_needs_clawback' });
    expect(mockUpdateCommissionIfStatus).not.toHaveBeenCalled();
    expect(mockInsertEvent).toHaveBeenCalledWith(SB, expect.objectContaining({
      type: 'marketplace.recommendation.commission_reversal_after_payout', status: 'warning',
    }));
  });

  it('reverse: nothing to reverse, or a row another run already moved', async () => {
    expect(await reverseRecommendationCommissionForOrder('order-1', 'x')).toEqual({ ok: true, status: 'none' });
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'rc-1', status: 'pending' }, error: null });
    mockUpdateCommissionIfStatus.mockResolvedValue({ data: [], error: null });
    expect(await reverseRecommendationCommissionForOrder('order-1', 'x')).toEqual({ ok: true, status: 'already_final' });
  });
});
