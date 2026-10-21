/**
 * VTID-01938 (rewrite): Awin provider registration.
 *
 * Catalog is distributed via the "Darwin" download system (see ../awin-sync.ts
 * for the full URL scheme + verified column set) — each feed_url is a stable,
 * directly-fetchable gzip CSV with the download token already embedded, so
 * (unlike the old classic-API shape) there is no separate api_key/publisher_id
 * needed at fetch time.
 *
 * Sync logic: ../awin-sync.ts.
 */

import type { MarketplaceProvider, ProviderSyncResult } from '../provider';
import { runAwinSync } from '../awin-sync';

export const awinProvider: MarketplaceProvider = {
  key: 'awin',
  displayName: 'Awin',
  description:
    'Awin "Darwin" product data feeds — per-advertiser gzip CSV catalogs (Toolbox → Create a Feed → Feed List Download ' +
    'in the Awin publisher dashboard). Each feed_url already carries the download token; no separate API key needed.',
  configSchema: [
    {
      key: 'feeds',
      label: 'Feed refs (JSON array)',
      type: 'textarea',
      placeholder: '[{"feed_url":"https://ui.awin.com/productdata-darwin-download/publisher/2938137/<token>/1/feed/F3660.csv.gz","advertiser_name":"MISSHA US"}]',
      required: true,
      help: 'JSON array of {feed_url, advertiser_name?} — one per advertiser feed. Get the feed_url from Awin → Toolbox → Create a Feed, or from the Feed List Download CSV.',
    },
    {
      key: 'category',
      label: 'Products category (default "skincare")',
      type: 'text',
      placeholder: 'skincare',
      help: 'Top-level products.category value applied to every row from this source.',
    },
    {
      key: 'max_products_per_feed',
      label: 'Max products per feed (default 500)',
      type: 'number',
      placeholder: '500',
    },
    {
      key: 'max_rows_scanned',
      label: 'Max CSV rows scanned per feed (default 50000)',
      type: 'number',
      placeholder: '50000',
    },
    {
      key: 'merchant_country',
      label: 'Fallback merchant country (ISO-2, optional)',
      type: 'text',
      placeholder: 'US',
    },
    {
      key: 'ships_to_countries',
      label: 'Ships-to countries (JSON array, optional — default ["US"])',
      type: 'textarea',
      placeholder: '["US","CA"]',
    },
    {
      key: 'ships_to_regions',
      label: 'Ships-to regions (JSON array, optional — default ["US"])',
      type: 'textarea',
      placeholder: '["US"]',
    },
  ],
  validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };

    let feeds = cfg.feeds;
    if (typeof feeds === 'string') {
      try {
        feeds = JSON.parse(feeds);
      } catch {
        return { ok: false, error: 'feeds must be a JSON array' };
      }
    }
    if (!Array.isArray(feeds) || feeds.length === 0) {
      return { ok: false, error: 'feeds must be a non-empty array' };
    }
    for (const f of feeds as Array<Record<string, unknown>>) {
      if (!f || typeof f !== 'object') return { ok: false, error: 'each feed must be an object' };
      if (!f.feed_url || typeof f.feed_url !== 'string') {
        return { ok: false, error: 'each feed requires feed_url' };
      }
      try {
        new URL(f.feed_url);
      } catch {
        return { ok: false, error: `invalid feed_url: ${String(f.feed_url).slice(0, 80)}` };
      }
    }
    cfg.feeds = feeds;

    for (const key of ['ships_to_countries', 'ships_to_regions'] as const) {
      let v = cfg[key];
      if (typeof v === 'string' && v.trim()) {
        try {
          v = JSON.parse(v);
        } catch {
          return { ok: false, error: `${key} must be a JSON array` };
        }
      }
      if (v !== undefined && !Array.isArray(v)) {
        return { ok: false, error: `${key} must be a JSON array` };
      }
      if (Array.isArray(v)) cfg[key] = v;
    }

    if (cfg.max_products_per_feed !== undefined) {
      const n = Number(cfg.max_products_per_feed);
      if (!Number.isFinite(n) || n < 1 || n > 10000) {
        return { ok: false, error: 'max_products_per_feed must be between 1 and 10000' };
      }
    }
    if (cfg.max_rows_scanned !== undefined) {
      const n = Number(cfg.max_rows_scanned);
      if (!Number.isFinite(n) || n < 100) {
        return { ok: false, error: 'max_rows_scanned must be at least 100' };
      }
    }
    return { ok: true };
  },
  async runSync(triggered_by: string): Promise<ProviderSyncResult> {
    const r = await runAwinSync(triggered_by);
    return {
      ok: r.ok,
      totals: {
        inserted: r.totals.inserted,
        updated: r.totals.updated,
        skipped: r.totals.skipped,
        errors: r.totals.errors,
      },
      duration_ms: r.duration_ms,
      details: { fetched: r.totals.fetched, feeds_synced: r.feeds_synced, per_feed: r.per_feed },
      error: r.error,
    };
  },
};
