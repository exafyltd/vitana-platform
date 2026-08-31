/**
 * services/marketplace-sync/awin-order-sync.ts — previously had zero test
 * coverage. Added alongside the 2026-08-29 fix for the swallowed
 * fetchProductClickByClickId error: a Postgres-level failure resolved
 * `data` to null, indistinguishable from the documented, intended
 * "no matching click for this clickRef" skip — silently and permanently
 * dropping a real affiliate sale's attribution/commission credit for that
 * sync run on a transient DB blip, with zero trace.
 */

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

const mockCreditRecommenderForOrder = jest.fn();
jest.mock('../../src/services/recommendation-commissions/credit-recommender', () => ({
  creditRecommenderForOrder: (...args: unknown[]) => mockCreditRecommenderForOrder(...args),
}));

const mockFetchActiveAwinSourceConfig = jest.fn();
const mockFetchProductClickByClickId = jest.fn();
const mockUpsertProductOrder = jest.fn();
jest.mock('../../src/services/marketplace-sync/awin-order-sync-repository', () => ({
  fetchActiveAwinSourceConfig: (...args: unknown[]) => mockFetchActiveAwinSourceConfig(...args),
  fetchProductClickByClickId: (...args: unknown[]) => mockFetchProductClickByClickId(...args),
  upsertProductOrder: (...args: unknown[]) => mockUpsertProductOrder(...args),
}));

import { runAwinOrderSync } from '../../src/services/marketplace-sync/awin-order-sync';

const SB: any = {};

function mockAwinTransactionsFetch(transactions: Array<Record<string, unknown>>) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ transactions }),
  }) as unknown as typeof fetch;
}

describe('runAwinOrderSync — fetchProductClickByClickId error handling', () => {
  let errorSpy: jest.SpyInstance;
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue(SB);
    mockFetchActiveAwinSourceConfig.mockResolvedValue({
      data: { config: { api_token: 'tok', publisher_id: 'pub-1' } },
      error: null,
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    global.fetch = realFetch;
  });

  it('on the RPC returning {error} (a transient DB blip): logs it loudly, and the sale is counted unattributed exactly as the "genuinely no click" case would be (unchanged fallback)', async () => {
    mockAwinTransactionsFetch([{ id: 'tx-1', clickRef: 'click-abc', commissionAmount: { amount: 10, currency: 'EUR' } }]);
    mockFetchProductClickByClickId.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const result = await runAwinOrderSync(7);

    // The bug this fix closes: this failure used to be indistinguishable
    // from an intended, documented skip ("no matching click for this
    // clickRef") — now it must be logged.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchProductClickByClickId failed for clickRef=click-abc'),
      'connection terminated unexpectedly',
    );
    // Unchanged: still counted unattributed, no commission credited —
    // the fallback behavior itself is not what this fix changes.
    expect(result).toEqual(expect.objectContaining({ ok: true, fetched: 1, attributed: 0, unattributed: 1 }));
    expect(mockUpsertProductOrder).not.toHaveBeenCalled();
  });

  it('on a genuinely unmatched clickRef (no error): logs nothing, same unattributed outcome', async () => {
    mockAwinTransactionsFetch([{ id: 'tx-2', clickRef: 'click-unknown', commissionAmount: { amount: 10, currency: 'EUR' } }]);
    mockFetchProductClickByClickId.mockResolvedValue({ data: null, error: null });

    const result = await runAwinOrderSync(7);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ attributed: 0, unattributed: 1 }));
  });

  it('on a successful click match: logs nothing, and the transaction is attributed', async () => {
    mockAwinTransactionsFetch([{ id: 'tx-3', clickRef: 'click-real', commissionAmount: { amount: 10, currency: 'EUR' }, commissionStatus: 'approved' }]);
    mockFetchProductClickByClickId.mockResolvedValue({
      data: { click_id: 'click-real', user_id: 'u1', tenant_id: 't1', product_id: 'p1', merchant_id: 'm1' },
      error: null,
    });
    mockUpsertProductOrder.mockResolvedValue({ data: { id: 'order-1' }, error: null });
    mockCreditRecommenderForOrder.mockResolvedValue(undefined);

    const result = await runAwinOrderSync(7);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(result.attributed).toBe(1);
  });
});

describe('runAwinOrderSync — source-config lookup error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue(SB);
  });

  it('rejects (not a silent "not configured" skip) when the source-config lookup errors', async () => {
    mockFetchActiveAwinSourceConfig.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });

    // Previously this fell through to loadAwinOrderSyncConfig() returning
    // null (config?.api_token on an undefined `data`), reported identically
    // to "Awin isn't configured for this tenant" — silently skipping order/
    // commission polling for the period on a transient DB blip.
    await expect(runAwinOrderSync(7)).rejects.toMatchObject({ message: 'connection reset' });
  });
});
