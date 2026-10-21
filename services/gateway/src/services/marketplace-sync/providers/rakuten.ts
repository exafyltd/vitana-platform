/**
 * VTID-01938: Rakuten Advertising provider registration.
 *
 * Complements CJ with a different advertiser mix (~1000 advertisers,
 * Europe-stronger). Single publisher account, one bearer token — similar
 * shape to CJ but different endpoint + response format.
 *
 * Sync logic: ../rakuten-sync.ts.
 */

import type { MarketplaceProvider, ProviderSyncResult } from '../provider';
import { runRakutenSync } from '../rakuten-sync';

export const rakutenProvider: MarketplaceProvider = {
  key: 'rakuten',
  displayName: 'Rakuten Advertising',
  description:
    'LinkShare / Rakuten Advertising Product Search API. One publisher account per environment; bearer token comes from the Rakuten Advertising dashboard.',
  configSchema: [
    {
      key: 'bearer_token',
      label: 'Rakuten bearer token',
      type: 'password',
      required: true,
      help: 'Generated in the Rakuten Advertising dashboard under Tools → Keys.',
    },
    {
      key: 'keywords',
      label: 'Search keywords (comma-separated)',
      type: 'text',
      placeholder: 'supplement,vitamin,probiotic',
      help: 'One Product Search call per keyword. Defaults to "supplement,vitamin".',
    },
    {
      key: 'advertiser_ids',
      label: 'Advertiser IDs / MIDs (comma-separated, optional)',
      type: 'text',
      placeholder: '12345,67890',
      list: true,
      help: 'Restrict to specific advertisers. Leave blank to query all your linked advertisers.',
    },
    {
      key: 'max_pages',
      label: 'Max pages per keyword (1-20)',
      type: 'number',
      placeholder: '10',
    },
    {
      key: 'merchant_country',
      label: 'Fallback merchant country (ISO-2, optional)',
      type: 'text',
      placeholder: 'US',
    },
  ],
  validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
    if (!cfg.bearer_token || typeof cfg.bearer_token !== 'string') {
      return { ok: false, error: 'bearer_token is required' };
    }
    if (cfg.max_pages !== undefined) {
      const n = Number(cfg.max_pages);
      if (!Number.isFinite(n) || n < 1 || n > 20) {
        return { ok: false, error: 'max_pages must be between 1 and 20' };
      }
    }
    return { ok: true };
  },
  async runSync(triggered_by: string): Promise<ProviderSyncResult> {
    const r = await runRakutenSync(triggered_by);
    return {
      ok: r.ok,
      totals: {
        inserted: r.totals.inserted,
        updated: r.totals.updated,
        skipped: r.totals.skipped,
        errors: r.totals.errors,
      },
      duration_ms: r.duration_ms,
      details: { fetched: r.totals.fetched, pages_fetched: r.pages_fetched, advertisers_seen: r.advertisers_seen },
      error: r.error,
    };
  },
};
