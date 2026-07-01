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

// ==================== Feed discovery ====================

/**
 * A product feed the publisher account can access, as returned by Awin's
 * datafeed *list* endpoint. This is what removes the manual "go find the
 * feed_id in the dashboard" step: call listAwinFeeds() and you get every
 * feed_id / advertiser_id pair you're entitled to, ready to drop into the
 * `feeds` array of an Awin source config.
 */
export interface AwinAvailableFeed {
  feed_id: string;
  advertiser_id: string;
  advertiser_name: string;
  primary_region?: string;
  membership_status?: string;
  language?: string;
  vertical?: string;
  product_count?: number;
}

/**
 * Minimal RFC-4180 CSV row parser — handles quoted fields containing commas
 * and doubled-quote escapes. Awin advertiser names routinely contain commas
 * ("Acme Health, Inc."), so a naive split() corrupts the columns.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * List every product data feed this publisher's API key can download.
 *
 * Awin exposes a CSV catalog of feeds at
 *   https://productdata.awin.com/datafeed/list/apikey/{key}/
 * with one row per feed the account is entitled to (joined advertisers that
 * publish a datafeed). We map the columns we care about by HEADER NAME rather
 * than position, since Awin has reordered/extended the export over time.
 *
 * @param apiKey  the publisher datafeed API key (path-stamped, not Bearer)
 * @param opts.joinedOnly  keep only rows whose membership status looks joined/active
 */
export async function listAwinFeeds(
  apiKey: string,
  opts: { joinedOnly?: boolean } = {}
): Promise<AwinAvailableFeed[]> {
  if (!apiKey) throw new Error('listAwinFeeds: apiKey required');
  const url = `https://productdata.awin.com/datafeed/list/apikey/${encodeURIComponent(apiKey)}/`;
  const resp = await fetch(url, { headers: { Accept: 'text/csv' } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '(no body)');
    throw new Error(`Awin feed list HTTP ${resp.status} ${body.slice(0, 300)}`);
  }
  const text = await resp.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const iFeed = idx('feed id', 'feedid', 'feed_id');
  const iAdv = idx('advertiser id', 'advertiserid', 'advertiser_id');
  const iName = idx('advertiser name', 'advertisername', 'advertiser_name');
  const iRegion = idx('primary region', 'region');
  const iStatus = idx('membership status', 'membership', 'status');
  const iLang = idx('language', 'languages');
  const iVertical = idx('vertical', 'sector');
  const iCount = idx('no of products', 'number of products', 'products');

  if (iFeed === -1 || iAdv === -1) {
    throw new Error(`Awin feed list: unexpected columns [${header.join(', ')}]`);
  }

  const feeds: AwinAvailableFeed[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = parseCsvLine(lines[r]);
    const feed_id = cols[iFeed];
    const advertiser_id = cols[iAdv];
    if (!feed_id || !advertiser_id) continue;
    const membership_status = iStatus !== -1 ? cols[iStatus] : undefined;
    if (opts.joinedOnly && membership_status) {
      const s = membership_status.toLowerCase();
      if (!(s.includes('join') || s.includes('active') || s.includes('approved'))) continue;
    }
    const rawCount = iCount !== -1 ? Number((cols[iCount] || '').replace(/[^0-9]/g, '')) : NaN;
    feeds.push({
      feed_id,
      advertiser_id,
      advertiser_name: (iName !== -1 ? cols[iName] : '') || `Awin Advertiser ${advertiser_id}`,
      primary_region: iRegion !== -1 ? cols[iRegion] || undefined : undefined,
      membership_status,
      language: iLang !== -1 ? cols[iLang] || undefined : undefined,
      vertical: iVertical !== -1 ? cols[iVertical] || undefined : undefined,
      product_count: Number.isFinite(rawCount) ? rawCount : undefined,
    });
  }
  return feeds;
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
