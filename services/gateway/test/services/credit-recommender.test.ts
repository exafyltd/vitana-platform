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
const mockConfirmRpc = jest.fn();
const mockReverseRpc = jest.fn();
const mockFetchClickReferrer = jest.fn();
const mockReopenReversed = jest.fn();

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
  confirmRecommendationCommissionRpc: (...args: unknown[]) => mockConfirmRpc(...args),
  reverseRecommendationCommissionRpc: (...args: unknown[]) => mockReverseRpc(...args),
  fetchClickReferrer: (...args: unknown[]) => mockFetchClickReferrer(...args),
  reopenReversedCommission: (...args: unknown[]) => mockReopenReversed(...args),
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

describe('creditRecommenderForOrder — network-approved path (paid through the locking transaction)', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

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
    mockInsertRecommendationCommission.mockResolvedValue({ data: { id: 'rc-new' }, error: null });
    mockConfirmRpc.mockResolvedValue({ data: { ok: true, status: 'credited', ledger_entry_id: 'ledger-1' }, error: null });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('records the commission pending and due now, then pays it only through confirm_recommendation_commission', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: null });
    const before = Date.now();

    const result = await creditRecommenderForOrder('order-1', NET);

    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
    const row = mockInsertRecommendationCommission.mock.calls[0][1];
    expect(row).toMatchObject({ status: 'pending', payout_amount_minor: 500, recommender_user_id: 'recommender-1' });
    expect(Date.parse(row.confirm_after)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(row.confirm_after)).toBeGreaterThanOrEqual(before - 1000);
    expect(mockConfirmRpc).toHaveBeenCalledWith(SB, 'rc-new');
    // No wallet call and no stats outside the transaction.
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
    expect(mockIncrementProductRecommendationStats).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('on fetchExistingRecommendationCommission returning {error}: logs it and proceeds (the unique order key still prevents a second row)', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: { message: 'connection terminated unexpectedly' } });

    const result = await creditRecommenderForOrder('order-1', NET);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchExistingRecommendationCommission error for order=order-1: connection terminated unexpectedly'),
    );
    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
  });

  it('a failed pending insert pays nothing', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: null });
    mockInsertRecommendationCommission.mockResolvedValue({ data: null, error: { message: 'duplicate key value violates unique constraint' } });

    expect(await creditRecommenderForOrder('order-1', NET)).toEqual({ ok: false, status: 'failed', message: 'PENDING_INSERT_FAILED' });
    expect(mockConfirmRpc).not.toHaveBeenCalled();
  });

  it('a held commission whose sale the network now approves is confirmed through the transaction', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'rc-held', status: 'pending' }, error: null });

    expect(await creditRecommenderForOrder('order-1', NET)).toEqual({ ok: true, status: 'credited', payout_minor: undefined });
    expect(mockConfirmRpc).toHaveBeenCalledWith(SB, 'rc-held');
    expect(mockInsertRecommendationCommission).not.toHaveBeenCalled();
  });

  it('a reversed commission whose order is a sale again is reopened and, network-approved, paid through the transaction', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'rc-rev', status: 'reversed' }, error: null });
    mockReopenReversed.mockResolvedValue({ data: [{ id: 'rc-rev' }], error: null });
    mockInsertEvent.mockResolvedValue({ error: null });
    const before = Date.now();

    expect(await creditRecommenderForOrder('order-1', NET)).toEqual({ ok: true, status: 'credited', payout_minor: undefined });
    const [, id, confirmAfter] = mockReopenReversed.mock.calls[0];
    expect(id).toBe('rc-rev');
    expect(Date.parse(confirmAfter)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(confirmAfter)).toBeLessThanOrEqual(Date.now());
    expect(mockConfirmRpc).toHaveBeenCalledWith(SB, 'rc-rev');
    expect(mockInsertEvent).toHaveBeenCalledWith(SB, expect.objectContaining({ type: 'marketplace.recommendation.commission_reopened' }));
    expect(mockInsertRecommendationCommission).not.toHaveBeenCalled();
  });

  it('a reopened commission not approved by a network is held again for the return window', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'rc-rev', status: 'reversed' }, error: null });
    mockReopenReversed.mockResolvedValue({ data: [{ id: 'rc-rev' }], error: null });
    mockInsertEvent.mockResolvedValue({ error: null });
    mockFetchReturnWindowSetting.mockResolvedValue({ data: { value: { days: 14 } }, error: null });

    const result = await creditRecommenderForOrder('order-1');

    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'pending' }));
    expect(Math.round((Date.parse(mockReopenReversed.mock.calls[0][2]) - Date.now()) / 86400000)).toBe(14);
    expect(mockConfirmRpc).not.toHaveBeenCalled();
  });

  it('a reversed commission another caller already reopened is left alone', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'rc-rev', status: 'reversed' }, error: null });
    mockReopenReversed.mockResolvedValue({ data: [], error: null });

    expect(await creditRecommenderForOrder('order-1', NET)).toEqual({ ok: true, status: 'already_credited' });
    expect(mockConfirmRpc).not.toHaveBeenCalled();
  });

  it('an existing final commission short-circuits (already_credited)', async () => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: { id: 'existing-1', status: 'credited' }, error: null });

    expect(await creditRecommenderForOrder('order-1', NET)).toEqual({ ok: true, status: 'already_credited' });
    expect(mockConfirmRpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ data: { ok: false, error: 'RECOMMENDER_WALLET_NOT_FOUND' }, error: null }, { ok: false, status: 'failed', message: 'RECOMMENDER_WALLET_NOT_FOUND' }],
    [{ data: null, error: { message: 'timeout' } }, { ok: false, status: 'failed', message: 'CONFIRM_FAILED' }],
    [{ data: { ok: true, status: 'order_not_converted' }, error: null }, { ok: true, status: 'pending', message: 'order_not_converted' }],
    [{ data: { ok: true, status: 'skipped_excluded_account' }, error: null }, { ok: true, status: 'skipped_invalid_referral', message: 'excluded_account' }],
  ])('maps the transaction outcome %j (the row stays pending when nothing was committed)', async (rpc, expected) => {
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: null });
    mockConfirmRpc.mockResolvedValue(rpc);

    expect(await creditRecommenderForOrder('order-1', NET)).toEqual(expected);
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
    mockInsertRecommendationCommission.mockResolvedValue({ data: { id: 'rc-new' }, error: null });
    mockConfirmRpc.mockResolvedValue({ data: { ok: true, status: 'credited' }, error: null });
    mockFetchReturnWindowSetting.mockResolvedValue({ data: { value: { days: 30 } }, error: null });
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

  it('a failed return-window lookup fails closed: no pending row with a window nobody configured', async () => {
    mockFetchReturnWindowSetting.mockResolvedValue({ data: null, error: { message: 'timeout' } });

    expect(await creditRecommenderForOrder('order-1')).toEqual({ ok: false, status: 'failed', message: 'RETURN_WINDOW_LOOKUP_FAILED' });
    expect(mockInsertRecommendationCommission).not.toHaveBeenCalled();
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
    mockInsertRecommendationCommission.mockResolvedValue({ data: { id: 'rc-new' }, error: null });
    mockConfirmRpc.mockResolvedValue({ data: { ok: true, status: 'credited' }, error: null });
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
    expect(mockConfirmRpc).toHaveBeenCalledTimes(1);
  });
});

describe('VTID-04740: the referrer frozen on the click is the payee', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue(SB);
    mockFetchProductOrderForCommission.mockResolvedValue({ data: { ...ORDER, click_id: 'click-1' }, error: null });
    mockFetchExistingRecommendationCommission.mockResolvedValue({ data: null, error: null });
    mockFetchProductRecommendationForCommission.mockResolvedValue({ data: REC, error: null });
    mockFetchExcluded.mockResolvedValue({ ok: true, ids: new Set() });
    mockFetchMerchantCommissionEligibility.mockResolvedValue({
      data: { recommendation_commission_eligible: true, recommendation_commission_rate_override: 0.5 },
      error: null,
    });
    mockFetchRecommenderWalletAccount.mockResolvedValue({ data: { id: 'acct-frozen' }, error: null });
    mockInsertEvent.mockResolvedValue({ error: null });
    mockCreditWalletForEarning.mockResolvedValue({ ok: true, ledger_entry_id: 'ledger-1' });
    mockInsertRecommendationCommission.mockResolvedValue({ data: { id: 'rc-new' }, error: null });
    mockConfirmRpc.mockResolvedValue({ data: { ok: true, status: 'credited' }, error: null });
    mockIncrementProductRecommendationStats.mockResolvedValue({ error: null });
  });

  it('pays the referrer recorded on the click, even if the recommendation now names someone else', async () => {
    mockFetchClickReferrer.mockResolvedValue({ data: { referrer_user_id: 'frozen-1' }, error: null });

    const result = await creditRecommenderForOrder('order-1', NET);

    expect(result).toEqual(expect.objectContaining({ ok: true, status: 'credited' }));
    expect(mockFetchClickReferrer).toHaveBeenCalledWith(SB, 'click-1');
    expect(mockInsertRecommendationCommission).toHaveBeenCalledWith(SB, expect.objectContaining({ recommender_user_id: 'frozen-1' }));
  });

  it('the frozen referrer is the one checked for self-referral', async () => {
    mockFetchClickReferrer.mockResolvedValue({ data: { referrer_user_id: 'buyer-1' }, error: null });

    const result = await creditRecommenderForOrder('order-1', NET);

    expect(result).toEqual(expect.objectContaining({ status: 'skipped_invalid_referral', message: 'self_referral' }));
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
  });

  it('a click with no frozen referrer falls back to the recommendation owner', async () => {
    mockFetchClickReferrer.mockResolvedValue({ data: { referrer_user_id: null }, error: null });
    await creditRecommenderForOrder('order-1', NET);
    expect(mockInsertRecommendationCommission).toHaveBeenCalledWith(SB, expect.objectContaining({ recommender_user_id: 'recommender-1' }));
  });

  it('a failed click lookup pays nothing and writes nothing permanent', async () => {
    mockFetchClickReferrer.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await creditRecommenderForOrder('order-1', NET)).toEqual({ ok: false, status: 'failed', message: 'CLICK_LOOKUP_FAILED' });
    expect(mockInsertRecommendationCommission).not.toHaveBeenCalled();
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

/** Due rows returned by the first pass (above the random start); the wrap-around pass finds none. */
function dueRows(rows: unknown[]) {
  mockFetchDuePendingCommissions.mockImplementation(async (_sb: unknown, _now: string, _limit: number, _after: string | null, upTo: string | null) =>
    ({ data: upTo ? [] : rows, error: null }));
}

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
    mockInsertRecommendationCommission.mockResolvedValue({ data: { id: 'rc-new' }, error: null });
    mockConfirmRpc.mockResolvedValue({ data: { ok: true, status: 'credited' }, error: null });
    mockInsertEvent.mockResolvedValue({ error: null });
    mockIncrementProductRecommendationStats.mockResolvedValue({ error: null });
    mockConfirmRpc.mockResolvedValue({ data: { ok: true, status: 'credited', ledger_entry_id: 'ledger-1' }, error: null });
    mockReverseRpc.mockResolvedValue({ data: { ok: true, status: 'reversed' }, error: null });
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

  it('a network-approved conversion is paid at once, through the locking transaction', async () => {
    const result = await creditRecommenderForOrder('order-1', NET);
    expect(result).toEqual({ ok: true, status: 'credited', payout_minor: 500 });
    expect(mockInsertRecommendationCommission).toHaveBeenCalledWith(SB, expect.objectContaining({ status: 'pending' }));
    expect(mockConfirmRpc).toHaveBeenCalledWith(SB, 'rc-new');
  });

  it('confirm: a due commission on a still-converted order is confirmed by the single-transaction DB function', async () => {
    dueRows([PENDING_ROW]);

    const r = await confirmDueRecommendationCommissions();

    expect(r).toEqual({ ok: true, examined: 1, credited: 1, reversed: 0, failed: 0 });
    expect(mockConfirmRpc).toHaveBeenCalledWith(SB, 'rc-1');
    // The wallet, the status and the stats move inside that transaction, not from here.
    expect(mockCreditWalletForEarning).not.toHaveBeenCalled();
    expect(mockIncrementProductRecommendationStats).not.toHaveBeenCalled();
  });

  it.each(['refunded', 'cancelled', 'chargeback'])('confirm: an order %s during the window is reversed, never paid', async (state) => {
    dueRows([PENDING_ROW]);
    mockFetchProductOrderForCommission.mockResolvedValue({ data: { ...ORDER, state }, error: null });

    const r = await confirmDueRecommendationCommissions();

    expect(r).toEqual({ ok: true, examined: 1, credited: 0, reversed: 1, failed: 0 });
    expect(mockConfirmRpc).not.toHaveBeenCalled();
    expect(mockReverseRpc).toHaveBeenCalledWith(SB, 'order-1', `order_${state}`);
  });

  it('confirm: a reversal that fails is counted as failed, never reported as fine', async () => {
    dueRows([PENDING_ROW]);
    mockFetchProductOrderForCommission.mockResolvedValue({ data: { ...ORDER, state: 'refunded' }, error: null });
    mockReverseRpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await confirmDueRecommendationCommissions()).toEqual({ ok: true, examined: 1, credited: 0, reversed: 0, failed: 1 });
    errorSpy.mockRestore();
  });

  it('confirm: an order that is not final yet is left for the next run', async () => {
    dueRows([PENDING_ROW]);
    mockFetchProductOrderForCommission.mockResolvedValue({ data: { ...ORDER, state: 'pending' }, error: null });

    expect(await confirmDueRecommendationCommissions()).toEqual({ ok: true, examined: 1, credited: 0, reversed: 0, failed: 0 });
    expect(mockConfirmRpc).not.toHaveBeenCalled();
  });

  it('confirm: a commitment the DB function refused (no wallet yet) or an RPC error counts as failed; the row stays pending and the next run pays it', async () => {
    dueRows([PENDING_ROW]);
    mockConfirmRpc
      .mockResolvedValueOnce({ data: { ok: false, error: 'RECOMMENDER_WALLET_NOT_FOUND' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await confirmDueRecommendationCommissions()).toEqual({ ok: true, examined: 1, credited: 0, reversed: 0, failed: 1 });
    expect(await confirmDueRecommendationCommissions()).toEqual({ ok: true, examined: 1, credited: 0, reversed: 0, failed: 1 });
    expect(await confirmDueRecommendationCommissions()).toEqual({ ok: true, examined: 1, credited: 1, reversed: 0, failed: 0 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('RECOMMENDER_WALLET_NOT_FOUND'));
    errorSpy.mockRestore();
  });

  it('confirm: a row a concurrent reversal already moved is not counted', async () => {
    dueRows([PENDING_ROW]);
    mockConfirmRpc.mockResolvedValue({ data: { ok: true, status: 'not_pending', current_status: 'reversed' }, error: null });

    expect(await confirmDueRecommendationCommissions()).toEqual({ ok: true, examined: 1, credited: 0, reversed: 0, failed: 0 });
  });

  it.each([
    ['skipped_excluded_account', 'a payee registered as a test/service account during the hold'],
    ['order_not_converted', 'an order a cancellation locked first'],
  ])('confirm: the DB function closing or skipping a row (%s: %s) pays and counts nothing', async (status) => {
    dueRows([PENDING_ROW]);
    mockConfirmRpc.mockResolvedValue({ data: { ok: true, status }, error: null });

    expect(await confirmDueRecommendationCommissions()).toEqual({ ok: true, examined: 1, credited: 0, reversed: 0, failed: 0 });
  });

  it('confirm: pages past rows that stay pending, so they never hide later due commissions', async () => {
    const stuck = { ...PENDING_ROW, id: 'rc-a' };
    const payable = { ...PENDING_ROW, id: 'rc-b', product_order_id: 'order-2' };
    mockFetchDuePendingCommissions
      .mockResolvedValueOnce({ data: [stuck], error: null })
      .mockResolvedValueOnce({ data: [payable], error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    mockConfirmRpc.mockImplementation(async (_sb: unknown, id: string) =>
      ({ data: id === 'rc-a' ? { ok: false, error: 'RECOMMENDER_WALLET_NOT_FOUND' } : { ok: true, status: 'credited' }, error: null }));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const r = await confirmDueRecommendationCommissions(1, 5000, 'rc-0');

    expect(r).toEqual({ ok: true, examined: 2, credited: 1, reversed: 0, failed: 1 });
    // Pass 1 walks up from the start; pass 2 wraps around to it.
    expect(mockFetchDuePendingCommissions.mock.calls.map((c) => [c[3], c[4]])).toEqual([
      ['rc-0', null], ['rc-a', null], ['rc-b', null], [null, 'rc-0'],
    ]);
    expect(mockConfirmRpc).toHaveBeenCalledWith(SB, 'rc-b');
    errorSpy.mockRestore();
  });

  it('confirm: each run starts somewhere else, so the row cap never pins it to the same lowest ids', async () => {
    const below = { ...PENDING_ROW, id: 'rc-low' };
    mockFetchDuePendingCommissions.mockImplementation(async (_sb: unknown, _now: string, _limit: number, _after: string | null, upTo: string | null) =>
      ({ data: upTo ? [below] : [], error: null }));

    const r = await confirmDueRecommendationCommissions(100, 5000, 'rc-mid');

    expect(r).toEqual({ ok: true, examined: 1, credited: 1, reversed: 0, failed: 0 });
    expect(mockConfirmRpc).toHaveBeenCalledWith(SB, 'rc-low');
    const [first] = mockFetchDuePendingCommissions.mock.calls;
    expect(first[3]).toBe('rc-mid');
    // Default start is random.
    mockFetchDuePendingCommissions.mockClear();
    await confirmDueRecommendationCommissions();
    await confirmDueRecommendationCommissions();
    const starts = mockFetchDuePendingCommissions.mock.calls.filter((c) => c[4] === null).map((c) => c[3]);
    expect(new Set(starts).size).toBe(2);
  });

  it('confirm: stops at the row cap', async () => {
    dueRows([{ ...PENDING_ROW, id: 'rc-x' }]);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await confirmDueRecommendationCommissions(1, 1, 'rc-0');
    expect(r.examined).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stopped after 1 rows'));
    warnSpy.mockRestore();
  });

  it('confirm: a failed page read reports the error', async () => {
    mockFetchDuePendingCommissions.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    expect(await confirmDueRecommendationCommissions()).toEqual({ ok: false, examined: 0, credited: 0, reversed: 0, failed: 0, error: 'timeout' });
  });

  it.each([
    ['reversed'], ['none'], ['already_final'], ['paid_needs_clawback'], ['order_not_reversing'],
  ])('reverse: passes the single-transaction DB function outcome through (%s)', async (status) => {
    mockReverseRpc.mockResolvedValue({ data: { ok: true, status }, error: null });
    expect(await reverseRecommendationCommissionForOrder('order-1', 'network_declined')).toEqual({ ok: true, status });
    expect(mockReverseRpc).toHaveBeenCalledWith(SB, 'order-1', 'network_declined');
  });

  it('reverse: an RPC error is reported as failed, never as done', async () => {
    mockReverseRpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await reverseRecommendationCommissionForOrder('order-1', 'x')).toEqual({ ok: false, status: 'failed' });
    errorSpy.mockRestore();
  });
});
