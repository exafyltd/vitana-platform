/**
 * VTID-02200 / VTID-01930: Marketplace sync orchestrator.
 *
 * Single entry point that iterates the provider registry (./providers).
 * Adding a new source (Amazon, Rakuten, …) is a registry-only change —
 * this file never needs to be touched.
 */

import type { ProviderSyncResult } from './provider';
import { getProvider, listProviders } from './providers';

export type { ProviderSyncResult } from './provider';

export interface MarketplaceSyncAllResult {
  ok: boolean;
  /** Per-provider result keyed by provider.key (e.g. 'shopify', 'cj'). */
  providers: Record<string, ProviderSyncResult>;
  duration_ms: number;
}

function emptyFailure(message: string): ProviderSyncResult {
  return {
    ok: false,
    totals: { inserted: 0, updated: 0, skipped: 0, errors: 1 },
    duration_ms: 0,
    error: message,
  };
}

export async function runAllMarketplaceSync(triggered_by = 'scheduler'): Promise<MarketplaceSyncAllResult> {
  const startTime = Date.now();
  console.log('[marketplace-sync] run started — triggered_by=%s', triggered_by);

  const providers: Record<string, ProviderSyncResult> = {};
  let allOk = true;

  // Sequential is fine; each provider rate-limits against its own vendor.
  for (const p of listProviders()) {
    const r = await p.runSync(triggered_by).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[marketplace-sync] ${p.key} failed:`, message);
      return emptyFailure(message);
    });
    providers[p.key] = r;
    if (!r.ok) allOk = false;
  }

  const duration_ms = Date.now() - startTime;
  const summary = Object.entries(providers)
    .map(([k, v]) => `${k}=${v.totals.inserted}+`)
    .join(' ');
  console.log(`[marketplace-sync] run done in ${duration_ms}ms — ${summary}`);

  return { ok: allOk, providers, duration_ms };
}

export async function runMarketplaceSyncSource(
  source: string,
  triggered_by: string
): Promise<ProviderSyncResult> {
  const provider = getProvider(source);
  if (!provider) {
    throw new Error(
      `Unknown marketplace provider: ${source}. Supported: ${listProviders().map((p) => p.key).join(', ')}`
    );
  }
  return provider.runSync(triggered_by);
}
