/**
 * VTID-02000: Admitad product-feed provider registration.
 *
 * Distinct from `admitad` (the existing postback-conversion crediting flow in
 * routes/vcaop.ts) — this is a CATALOG source: per-advertiser downloadable
 * product feeds (Tools → Product Feeds in the Admitad publisher dashboard).
 * Registered as source_network 'admitad_feed' so it never collides with the
 * hand-curated 'admitad' rows already seeded for AliExpress/Bodylab24.
 *
 * Sync logic: ../admitad-sync.ts.
 */

import type { MarketplaceProvider, ProviderSyncResult } from '../provider';
import { runAdmitadSync } from '../admitad-sync';

export const admitadFeedProvider: MarketplaceProvider = {
  key: 'admitad_feed',
  displayName: 'Admitad (Product Feeds)',
  description:
    'Admitad per-advertiser product feeds (Tools → Product Feeds → Original Product Feed in the publisher dashboard). ' +
    'Each generated link already carries a specific-product deep link + real product photo. ' +
    'Feeds are the advertiser’s full catalog — a keyword allow-list filters to wellness/supplement items.',
  configSchema: [
    {
      key: 'feeds',
      label: 'Feed refs (JSON array)',
      type: 'textarea',
      placeholder: '[{"feed_url":"https://export.admitad.com/en/webmaster/websites/.../export_adv_products/?user=...&code=...","advertiser_name":"AliExpress"}]',
      required: true,
      help: 'JSON array of {feed_url, advertiser_name?} — one per generated Product Feed link. Generate the link at Admitad → Product Feeds → Original Product Feed (pick the program + a feed + CSV format), then copy the Generated Link.',
    },
    {
      key: 'keywords',
      label: 'Keyword allow-list (comma-separated, optional)',
      type: 'textarea',
      placeholder: 'vitamin,supplement,omega,collagen,magnesium,ashwagandha,creatine,probiotic,coq10',
      help: 'Only rows whose name/category contain one of these (case-insensitive) are imported. Defaults to a built-in wellness/supplement list if left blank.',
    },
    {
      key: 'max_products_per_feed',
      label: 'Max matched products per feed (default 200)',
      type: 'number',
      placeholder: '200',
    },
    {
      key: 'max_rows_scanned',
      label: 'Max CSV rows scanned per feed (default 300000)',
      type: 'number',
      placeholder: '300000',
      help: 'Safety bound — these feeds can be an advertiser’s entire catalog (hundreds of thousands of rows).',
    },
    {
      key: 'merchant_country',
      label: 'Fallback merchant country (ISO-2, optional)',
      type: 'text',
      placeholder: 'CN',
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

    if (cfg.max_products_per_feed !== undefined) {
      const n = Number(cfg.max_products_per_feed);
      if (!Number.isFinite(n) || n < 1 || n > 5000) {
        return { ok: false, error: 'max_products_per_feed must be between 1 and 5000' };
      }
    }
    if (cfg.max_rows_scanned !== undefined) {
      const n = Number(cfg.max_rows_scanned);
      if (!Number.isFinite(n) || n < 1000) {
        return { ok: false, error: 'max_rows_scanned must be at least 1000' };
      }
    }
    return { ok: true };
  },
  async runSync(triggered_by: string): Promise<ProviderSyncResult> {
    const r = await runAdmitadSync(triggered_by);
    return {
      ok: r.ok,
      totals: {
        inserted: r.totals.inserted,
        updated: r.totals.updated,
        skipped: r.totals.skipped,
        errors: r.totals.errors,
      },
      duration_ms: r.duration_ms,
      details: { scanned: r.totals.scanned, matched: r.totals.matched, feeds_synced: r.feeds_synced, per_feed: r.per_feed },
    };
  },
};
