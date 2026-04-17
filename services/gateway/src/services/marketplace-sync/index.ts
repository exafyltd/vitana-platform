/**
 * VTID-02200: Marketplace sync orchestrator.
 *
 * Single entry point that runs all enabled marketplace sources on schedule.
 */

import { runShopifySync, type ShopifySyncResult } from './shopify-sync';
import { runCjSync, type CjSyncResult } from './cj-sync';

export interface MarketplaceSyncAllResult {
  ok: boolean;
  shopify: ShopifySyncResult;
  cj: CjSyncResult;
  duration_ms: number;
}

export async function runAllMarketplaceSync(triggered_by = 'scheduler'): Promise<MarketplaceSyncAllResult> {
  const startTime = Date.now();
  console.log('[marketplace-sync] run started — triggered_by=%s', triggered_by);

  // Sequential is fine; each source is rate-limited on its own vendor side.
  const shopify = await runShopifySync(triggered_by).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[marketplace-sync] shopify failed:', message);
    return {
      ok: false,
      shops_synced: 0,
      totals: { inserted: 0, updated: 0, skipped: 0, errors: 1 },
      per_shop: [],
      duration_ms: 0,
    } as ShopifySyncResult;
  });

  const cj = await runCjSync(triggered_by).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[marketplace-sync] cj failed:', message);
    return {
      ok: false,
      totals: { inserted: 0, updated: 0, skipped: 0, errors: 1, fetched: 0 },
      pages_fetched: 0,
      advertisers_seen: 0,
      duration_ms: 0,
      error: message,
    } as CjSyncResult;
  });

  const duration_ms = Date.now() - startTime;
  console.log(`[marketplace-sync] run done in ${duration_ms}ms — shopify=${shopify.totals.inserted}+ cj=${cj.totals.inserted}+`);

  return {
    ok: shopify.ok && cj.ok,
    shopify,
    cj,
    duration_ms,
  };
}

export async function runMarketplaceSyncSource(source: 'shopify' | 'cj', triggered_by: string) {
  if (source === 'shopify') return runShopifySync(triggered_by);
  return runCjSync(triggered_by);
}
