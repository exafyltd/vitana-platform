/**
 * VTID-01930: CJ Affiliate provider registration.
 *
 * The underlying sync logic lives in ../cj-sync.ts. This file is the
 * provider-registry adapter.
 */

import type { MarketplaceProvider, ProviderSyncResult } from '../provider';
import { runCjSync } from '../cj-sync';

export const cjProvider: MarketplaceProvider = {
  key: 'cj',
  displayName: 'CJ Affiliate',
  description:
    'Commission Junction Product Search. One publisher account per environment; credentials come from developers.cj.com.',
  configSchema: [
    {
      key: 'developer_key',
      label: 'CJ developer key',
      type: 'password',
      required: true,
    },
    {
      key: 'website_id',
      label: 'CJ website id',
      type: 'text',
      placeholder: '12345678',
      required: true,
    },
    {
      key: 'advertiser_ids',
      label: 'Advertiser IDs (comma-separated, optional)',
      type: 'text',
      placeholder: '1234,5678',
      list: true,
    },
    {
      key: 'keywords',
      label: 'Keyword filter (optional)',
      type: 'text',
      placeholder: 'supplement,vitamin',
    },
    {
      key: 'merchant_country',
      label: 'Merchant country (ISO-2, optional)',
      type: 'text',
      placeholder: 'DE',
    },
  ],
  validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
    if (!cfg.developer_key || typeof cfg.developer_key !== 'string') {
      return { ok: false, error: 'developer_key is required' };
    }
    if (!cfg.website_id || (typeof cfg.website_id !== 'string' && typeof cfg.website_id !== 'number')) {
      return { ok: false, error: 'website_id is required' };
    }
    return { ok: true };
  },
  async runSync(triggered_by: string): Promise<ProviderSyncResult> {
    const r = await runCjSync(triggered_by);
    return {
      ok: r.ok,
      totals: { inserted: r.totals.inserted, updated: r.totals.updated, skipped: r.totals.skipped, errors: r.totals.errors },
      duration_ms: r.duration_ms,
      details: { fetched: r.totals.fetched, pages_fetched: r.pages_fetched, advertisers_seen: r.advertisers_seen },
      error: r.error,
    };
  },
};
