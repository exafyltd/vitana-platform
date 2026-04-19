/**
 * VTID-01938: Awin provider registration.
 *
 * EU-strongest affiliate network (~25k advertisers). Catalog is distributed
 * as per-advertiser product data feeds — we configure one "feed entry" per
 * advertiser we've joined.
 *
 * Sync logic: ../awin-sync.ts.
 */

import type { MarketplaceProvider, ProviderSyncResult } from '../provider';
import { runAwinSync } from '../awin-sync';

export const awinProvider: MarketplaceProvider = {
  key: 'awin',
  displayName: 'Awin',
  description:
    'Awin product data feeds. Configure one publisher account + a list of advertiser feeds you have access to. Strongest in the EU market; use in addition to CJ/Rakuten for broader retailer coverage.',
  configSchema: [
    {
      key: 'api_key',
      label: 'Awin publisher API key',
      type: 'password',
      required: true,
      help: 'Publisher API key from My Account → API Credentials on awin.com.',
    },
    {
      key: 'publisher_id',
      label: 'Publisher ID (SID)',
      type: 'text',
      placeholder: '123456',
      required: true,
    },
    {
      key: 'feeds',
      label: 'Feed refs (JSON array)',
      type: 'textarea',
      placeholder: '[{"feed_id":"1234","advertiser_id":"5678","advertiser_name":"Acme Vitamins"}]',
      required: true,
      help: 'JSON array of {feed_id, advertiser_id, advertiser_name?} objects — one per advertiser you have product-feed access to.',
    },
    {
      key: 'max_products_per_feed',
      label: 'Max products per feed (default 500)',
      type: 'number',
      placeholder: '500',
    },
    {
      key: 'merchant_country',
      label: 'Fallback merchant country (ISO-2, optional)',
      type: 'text',
      placeholder: 'GB',
    },
  ],
  validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
    if (!cfg.api_key || typeof cfg.api_key !== 'string') return { ok: false, error: 'api_key is required' };
    if (!cfg.publisher_id) return { ok: false, error: 'publisher_id is required' };

    // feeds may come in as an array (direct JSON) or as a JSON-encoded string from the textarea.
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
      if (!f.feed_id || !f.advertiser_id) {
        return { ok: false, error: 'each feed requires feed_id and advertiser_id' };
      }
    }
    // Normalize back — the admin route will persist this.
    cfg.feeds = feeds;

    if (cfg.max_products_per_feed !== undefined) {
      const n = Number(cfg.max_products_per_feed);
      if (!Number.isFinite(n) || n < 1 || n > 10000) {
        return { ok: false, error: 'max_products_per_feed must be between 1 and 10000' };
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
