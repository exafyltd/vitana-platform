/**
 * VTID-01938: Awin product data feed sync.
 *
 * https://wiki.awin.com/index.php/Product_Feeds — Awin distributes catalogs
 * via per-advertiser "product data feeds" that can be downloaded in JSON
 * with selectable columns. We pull one feed per advertiser we're joined to.
 *
 * EU-strongest network (~25k advertisers), useful when Vitana expands to
 * European retailers that aren't on CJ/Rakuten.
 *
 * Config shape (JSON in marketplace_sources_config.config):
 *   {
 *     "api_key": "...",                       // Publisher API key
 *     "publisher_id": "123456",               // Publisher SID
 *     "feeds": [
 *       { "feed_id": "1234", "advertiser_id": "5678", "advertiser_name": "Acme Vitamins" }
 *     ],
 *     "merchant_country": "GB",
 *     "max_products_per_feed": 500
 *   }
 *
 * Auth: the api_key is stamped into the feed URL path
 *   https://productdata.awin.com/datafeed/download/apikey/{key}/...
 */

import {
  startSyncRun,
  finishSyncRun,
  upsertMerchant,
  upsertProducts,
  type ProductUpsert,
} from './shared';
import { inferSupplementAttributes } from './supplement-inference';
import { getSupabase } from '../../lib/supabase';

interface AwinFeedRef {
  feed_id: string;
  advertiser_id: string;
  advertiser_name?: string;
}

interface AwinSourceConfig {
  api_key: string;
  publisher_id: string;
  feeds: AwinFeedRef[];
  merchant_country?: string;
  max_products_per_feed?: number;
}

async function loadSourceConfigs(): Promise<AwinSourceConfig[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from('marketplace_sources_config')
    .select('config')
    .eq('source_network', 'awin')
    .eq('is_active', true);
  if (!data?.length) return [];
  return data
    .map((r) => r.config as AwinSourceConfig)
    .filter((c) => c && c.api_key && c.publisher_id && Array.isArray(c.feeds) && c.feeds.length > 0);
}

// ==================== Feed fetch ====================

// Column list we care about — Awin supports >100 columns but we only need these.
const FEED_COLUMNS = [
  'aw_deep_link',
  'aw_product_id',
  'merchant_product_id',
  'product_name',
  'description',
  'product_short_description',
  'merchant_name',
  'merchant_id',
  'merchant_category',
  'category_name',
  'brand_name',
  'merchant_image_url',
  'aw_image_url',
  'search_price',
  'rrp_price',
  'currency',
  'ean',
  'upc',
  'product_gtin',
  'in_stock',
  'stock_status',
  'language',
  'keywords',
  'specifications',
  'condition',
  'delivery_restrictions',
].join(',');

interface AwinFeedItem {
  aw_deep_link?: string;
  aw_product_id?: string;
  merchant_product_id?: string;
  product_name?: string;
  description?: string;
  product_short_description?: string;
  merchant_name?: string;
  merchant_id?: string;
  merchant_category?: string;
  category_name?: string;
  brand_name?: string;
  merchant_image_url?: string;
  aw_image_url?: string;
  search_price?: string;
  rrp_price?: string;
  currency?: string;
  ean?: string;
  upc?: string;
  product_gtin?: string;
  in_stock?: string;
  stock_status?: string;
  keywords?: string;
  specifications?: string;
  delivery_restrictions?: string;
}

async function fetchAwinFeed(
  cfg: AwinSourceConfig,
  feed: AwinFeedRef
): Promise<AwinFeedItem[]> {
  const url =
    `https://productdata.awin.com/datafeed/download/apikey/${encodeURIComponent(cfg.api_key)}` +
    `/language/any/fid/${encodeURIComponent(feed.feed_id)}/bandwidth/low` +
    `/sid/${encodeURIComponent(cfg.publisher_id)}/mid/${encodeURIComponent(feed.advertiser_id)}` +
    `/columns/${FEED_COLUMNS}/format/json`;

  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`Awin feed ${feed.feed_id} HTTP ${resp.status} ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as AwinFeedItem[] | { products?: AwinFeedItem[] };
  if (Array.isArray(data)) return data;
  return data.products ?? [];
}

// ==================== Normalization ====================

function parseCents(amountStr: string | undefined): number | null {
  if (!amountStr) return null;
  const n = parseFloat(amountStr.replace(/[^0-9.]/g, ''));
  return Number.isNaN(n) ? null : Math.round(n * 100);
}

function parseStock(item: AwinFeedItem): ProductUpsert['availability'] {
  const s = (item.stock_status ?? item.in_stock ?? '').toLowerCase();
  if (s.includes('out')) return 'out_of_stock';
  if (s.includes('preorder') || s.includes('pre-order')) return 'preorder';
  if (s.includes('discontinued')) return 'discontinued';
  if (item.in_stock === '1' || s === 'in stock' || s === 'yes' || s === 'true') return 'in_stock';
  return 'unknown';
}

function normalizeAwinItem(
  item: AwinFeedItem,
  feed: AwinFeedRef,
  merchantId: string,
  country?: string
): ProductUpsert | null {
  const id = item.aw_product_id ?? item.merchant_product_id;
  if (!id) return null;
  const title = item.product_name;
  if (!title) return null;

  const priceCents = parseCents(item.search_price);
  if (priceCents === null) return null;
  const currency = (item.currency ?? 'EUR').toUpperCase();
  const rrp = parseCents(item.rrp_price);
  const compareCents = rrp && rrp > priceCents ? rrp : undefined;

  const gtin = item.product_gtin ?? item.ean ?? item.upc;
  const description = item.product_short_description ?? item.description;
  const images: string[] = [];
  if (item.aw_image_url) images.push(item.aw_image_url);
  if (item.merchant_image_url && item.merchant_image_url !== item.aw_image_url) {
    images.push(item.merchant_image_url);
  }

  const topic_keys: string[] = [];
  if (item.keywords) {
    for (const k of item.keywords.split(/[,;]/)) {
      const s = k.trim().toLowerCase();
      if (s) topic_keys.push(s);
    }
  }

  const inferText = [title, description, item.merchant_category, item.category_name, item.specifications, item.keywords]
    .filter(Boolean).join(' ');
  const inferred = inferSupplementAttributes(inferText);

  // delivery_restrictions contains ISO country codes the merchant WILL NOT ship to — invert for ships_to_countries if needed.
  // For now we skip this (requires global country list); leave null.

  return {
    merchant_id: merchantId,
    source_network: 'awin',
    source_product_id: String(id),
    gtin,
    sku: item.merchant_product_id,
    title,
    description,
    description_long: item.description,
    brand: item.brand_name,
    category: item.merchant_category ?? item.category_name,
    subcategory: item.category_name,
    topic_keys: topic_keys.slice(0, 20),
    price_cents: priceCents,
    currency,
    compare_at_price_cents: compareCents,
    images,
    affiliate_url: item.aw_deep_link ?? '',
    availability: parseStock(item),
    origin_country: country,
    health_goals: inferred.health_goals,
    dietary_tags: inferred.dietary_tags,
    ingredients_primary: inferred.ingredients_primary,
    form: inferred.form,
    certifications: inferred.certifications,
    raw: item as unknown as Record<string, unknown>,
  };
}

// ==================== Per-feed sync ====================

async function syncOneFeed(
  cfg: AwinSourceConfig,
  feed: AwinFeedRef
): Promise<{ inserted: number; updated: number; skipped: number; errors: number; fetched: number; error_sample: unknown[] }> {
  const merchantId = await upsertMerchant({
    source_network: 'awin',
    source_merchant_id: feed.advertiser_id,
    name: feed.advertiser_name ?? `Awin Advertiser ${feed.advertiser_id}`,
    affiliate_network: 'awin',
    merchant_country: cfg.merchant_country,
    quality_score: 65,
    customs_risk: 'unknown',
  });
  if (!merchantId) {
    return { inserted: 0, updated: 0, skipped: 0, errors: 1, fetched: 0, error_sample: [{ feed_id: feed.feed_id, error: 'merchant upsert failed' }] };
  }

  let items: AwinFeedItem[];
  try {
    items = await fetchAwinFeed(cfg, feed);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { inserted: 0, updated: 0, skipped: 0, errors: 1, fetched: 0, error_sample: [{ feed_id: feed.feed_id, error: message }] };
  }

  const max = cfg.max_products_per_feed ?? 500;
  const limited = items.slice(0, max);

  const normalized = limited
    .map((i) => normalizeAwinItem(i, feed, merchantId, cfg.merchant_country))
    .filter((p): p is ProductUpsert => p !== null);

  if (normalized.length === 0) {
    return { inserted: 0, updated: 0, skipped: 0, errors: 0, fetched: items.length, error_sample: [] };
  }

  const r = await upsertProducts(normalized, 'awin');
  return {
    inserted: r.inserted,
    updated: r.updated,
    skipped: r.skipped_unchanged,
    errors: r.errors.length,
    fetched: items.length,
    error_sample: r.errors.slice(0, 5),
  };
}

// ==================== Entry point ====================

export interface AwinSyncResult {
  ok: boolean;
  totals: { inserted: number; updated: number; skipped: number; errors: number; fetched: number };
  feeds_synced: number;
  duration_ms: number;
  per_feed: Array<{ feed_id: string; advertiser_id: string; inserted: number; updated: number; skipped: number; errors: number }>;
  error?: string;
}

export async function runAwinSync(triggered_by = 'scheduler'): Promise<AwinSyncResult> {
  const startTime = Date.now();
  const configs = await loadSourceConfigs();
  if (configs.length === 0) {
    console.log('[awin-sync] no feeds configured — skipping');
    return {
      ok: true,
      totals: { inserted: 0, updated: 0, skipped: 0, errors: 0, fetched: 0 },
      feeds_synced: 0,
      per_feed: [],
      duration_ms: Date.now() - startTime,
    };
  }

  const totals = { inserted: 0, updated: 0, skipped: 0, errors: 0, fetched: 0 };
  const per_feed: AwinSyncResult['per_feed'] = [];
  const errorSample: unknown[] = [];
  let feedCount = 0;

  for (const cfg of configs) {
    const run = await startSyncRun('awin', triggered_by);
    for (const feed of cfg.feeds) {
      feedCount++;
      const stats = await syncOneFeed(cfg, feed);
      per_feed.push({
        feed_id: feed.feed_id,
        advertiser_id: feed.advertiser_id,
        inserted: stats.inserted,
        updated: stats.updated,
        skipped: stats.skipped,
        errors: stats.errors,
      });
      totals.inserted += stats.inserted;
      totals.updated += stats.updated;
      totals.skipped += stats.skipped;
      totals.errors += stats.errors;
      totals.fetched += stats.fetched;
      if (stats.error_sample.length) errorSample.push(...stats.error_sample);
    }
    if (run) await finishSyncRun(run, { ...totals, error_sample: errorSample.slice(0, 10) });
  }

  const duration_ms = Date.now() - startTime;
  console.log(
    `[awin-sync] done in ${duration_ms}ms — fetched ${totals.fetched}, ` +
    `${totals.inserted}+ ${totals.updated}~ ${totals.skipped}= ${totals.errors}! across ${feedCount} feeds`
  );

  return { ok: totals.errors === 0, totals, feeds_synced: feedCount, per_feed, duration_ms };
}
