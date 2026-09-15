/**
 * services/marketplace-sync/shopify-sync.ts — DB source-config lookup error
 * handling (the existing test/routes/shopify-sync.test.ts only covers pure
 * helpers, not runShopifySync/loadShopConfigs).
 *
 * Unlike the other marketplace-sync providers, this one has a legitimate
 * secondary source (the SHOPIFY_SHOPS env var), so a DB error deliberately
 * stays non-fatal here — the fix is making it visible (logged), not
 * changing the fall-through-to-env-var behavior.
 */

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

const mockFetchActiveMarketplaceSourceConfigs = jest.fn();
jest.mock('../../src/services/marketplace-sync/shopify-sync-repository', () => ({
  fetchActiveMarketplaceSourceConfigs: (...args: unknown[]) => mockFetchActiveMarketplaceSourceConfigs(...args),
}));

// The second test below only cares whether loadShopConfigs() falls through
// to the env var when the DB lookup errors — not the rest of the sync
// pipeline (network fetch, upserts), so that's stubbed out here.
jest.mock('../../src/services/marketplace-sync/shared', () => ({
  startSyncRun: jest.fn().mockResolvedValue(null),
  finishSyncRun: jest.fn().mockResolvedValue(undefined),
  upsertMerchant: jest.fn().mockResolvedValue('merchant-1'),
  upsertProducts: jest.fn().mockResolvedValue({ inserted: 0, updated: 0, skipped: 0, errors: 0 }),
  deriveRegionGroup: jest.fn().mockReturnValue('EU'),
}));

import { runShopifySync } from '../../src/services/marketplace-sync/shopify-sync';

describe('runShopifySync — source-config lookup error handling', () => {
  const ORIGINAL_ENV = process.env.SHOPIFY_SHOPS;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue({});
    delete process.env.SHOPIFY_SHOPS;
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.SHOPIFY_SHOPS;
    else process.env.SHOPIFY_SHOPS = ORIGINAL_ENV;
  });

  it('logs the error and falls back to (empty) SHOPIFY_SHOPS instead of silently reporting "no shops configured" with no trace', async () => {
    mockFetchActiveMarketplaceSourceConfigs.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runShopifySync('scheduler');

    expect(result).toMatchObject({ ok: true, shops_synced: 0 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('source-config lookup failed'),
    );
    errorSpy.mockRestore();
  });

  it('still uses the SHOPIFY_SHOPS env fallback when the DB lookup errors (unchanged design)', async () => {
    process.env.SHOPIFY_SHOPS = JSON.stringify([
      { domain: 'test.myshopify.com', storefront_access_token: 'tok', merchant_name: 'Test Shop' },
    ]);
    mockFetchActiveMarketplaceSourceConfigs.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { products: { edges: [] } } }) }) as unknown as typeof fetch;

    const result = await runShopifySync('scheduler');

    // Falls through to the env-configured shop instead of reporting 0.
    expect(result.shops_synced).toBe(1);
    errorSpy.mockRestore();
  });
});
