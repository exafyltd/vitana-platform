/**
 * VTID-01938 (rewrite): Awin "Darwin" product data feed sync.
 *
 * The classic Awin API this file used to target
 * (`productdata.awin.com/datafeed/download/apikey/...`) is dead — verified
 * live: `format/json` returns "json is not supported. Please use CSV
 * format", and the classic feed-discovery endpoint
 * (`productdata.awin.com/datafeed/list/apikey/...`) redirects to
 * `legacydatafeeds.awin.com` and 500s regardless of format.
 *
 * The real, working mechanism is the "Darwin" download system exposed in the
 * publisher UI (Toolbox → Create a Feed → Feed List Download):
 *   - Feed list (CSV):
 *       https://ui.awin.com/productdata-darwin-download/publisher/{publisher_id}/{download_token}/1/feedList
 *   - Per-feed catalog (gzip CSV, Google-Shopping/Content-API column set):
 *       https://ui.awin.com/productdata-darwin-download/publisher/{publisher_id}/{download_token}/1/feed/{FeedID}.csv.gz
 *
 * Both URLs embed the download_token directly — no separate Authorization
 * header/api_key needed at fetch time (mirrors admitad-sync.ts's feed_url
 * pattern, where the export credential is baked into the URL itself).
 *
 * Verified real feed columns (MISSHA US, Feed ID F3660 — Google Shopping /
 * Content API for Shopping export):
 *   advertiser_id,advertiser_name,id,title,description,link,image_link,
 *   additional_image_link,mobile_link,virtual_model_link,aw_deep_link,
 *   aw_mobile_link,google_product_category,product_type,gtin,mpn,brand,
 *   identifier_exists,availability,availability_date,expiration_date,price,
 *   sale_price,sale_price_effective_date,unit_pricing_measure,
 *   unit_pricing_base_measure,installment,subscription_cost,loyalty_program,
 *   condition,adult,multipack,is_bundle,energy_efficiency_class,
 *   min_energy_efficiency_class,max_energy_efficiency_class,age_group,color,
 *   gender,material,pattern,size,size_type,size_system,item_group_id,
 *   product_weight,product_height,product_width,product_length,
 *   product_detail,product_highlight,certification,lifestyle_image_link,
 *   shipping,shipping_weight,shipping_height,shipping_width,shipping_length,
 *   min_handling_time,max_handling_time,ships_from_country,tax
 *
 * `price`/`sale_price` are a single combined string ("11.50 USD"), unlike
 * Admitad's separate price/currencyId columns — parsed by parsePriceString().
 * `aw_deep_link` already carries `awinmid`/`awinaffid` query params — use it
 * as-is, do not rebuild the affiliate URL.
 *
 * Config shape (JSON in marketplace_sources_config.config):
 *   {
 *     "feeds": [
 *       { "feed_url": "https://ui.awin.com/productdata-darwin-download/publisher/2938137/<token>/1/feed/F3660.csv.gz",
 *         "advertiser_name": "MISSHA US" }
 *     ],
 *     "category": "skincare",
 *     "max_products_per_feed": 500,
 *     "max_rows_scanned": 50000,
 *     "merchant_country": "US",
 *     "ships_to_countries": ["DE", "AT", "US", ...],
 *     "ships_to_regions": ["EU", "US"]
 *   }
 *
 * The download_token in each feed_url is a personal export credential tied
 * to the publisher account — treat it as sensitive (same handling as every
 * other provider's secrets in this file: stored only in this JSON config
 * column, never in git/code, never returned to the client).
 */

import { Readable } from 'stream';
import { createInterface } from 'readline';
import { createGunzip } from 'zlib';
import {
  startSyncRun,
  finishSyncRun,
  upsertMerchant,
  upsertProducts,
  type ProductUpsert,
} from './shared';
import { getSupabase } from '../../lib/supabase';

interface AwinFeedRef {
  feed_url: string;
  advertiser_name?: string;
}

interface AwinSourceConfig {
  feeds: AwinFeedRef[];
  /** Top-level products.category value for every row from this source (default 'skincare'). */
  category?: string;
  max_products_per_feed?: number;
  /** Safety bound on CSV rows scanned per feed (default 50000 — these are single-advertiser feeds, not whole-network dumps). */
  max_rows_scanned?: number;
  merchant_country?: string;
  ships_to_countries?: string[];
  ships_to_regions?: string[];
}

const DEFAULT_CATEGORY = 'skincare';
// Confirmed with the operator: MISSHA US ships to the EU/Germany too, not
// just the US despite the storefront name — the feed itself carries no
// shipping data to derive this from. Mirrors admitad-sync.ts's default
// (broad dropship-style coverage) rather than assuming "US" from a brand name.
const DEFAULT_SHIPS_TO_COUNTRIES = [
  'DE', 'AT', 'CH', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE', 'DK', 'FI', 'GB', 'IE', 'US', 'CA', 'AE', 'SA',
];
const DEFAULT_SHIPS_TO_REGIONS = ['EU', 'UK', 'US', 'MENA', 'GLOBAL'];

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
    .filter((c) => c && Array.isArray(c.feeds) && c.feeds.length > 0);
}

// ==================== CSV parsing (comma-delimited, RFC4180 quoting) ====================

/** Parses one already-quote-balanced logical record into fields. */
function parseDelimitedRecord(line: string, delim: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function hasUnbalancedQuotes(line: string): boolean {
  let count = 0;
  for (const ch of line) if (ch === '"') count++;
  return count % 2 !== 0;
}

interface AwinRow {
  advertiser_id?: string;
  advertiser_name?: string;
  id?: string;
  title?: string;
  description?: string;
  link?: string;
  image_link?: string;
  additional_image_link?: string;
  aw_deep_link?: string;
  google_product_category?: string;
  product_type?: string;
  gtin?: string;
  mpn?: string;
  brand?: string;
  availability?: string;
  price?: string;
  sale_price?: string;
  ships_from_country?: string;
  [key: string]: string | undefined;
}

/**
 * Fetches + gunzips the feed and streams normalized row objects, keyed by
 * the header row's own column names.
 */
async function* streamAwinRows(
  feedUrl: string,
  maxRowsScanned: number
): AsyncGenerator<AwinRow> {
  const resp = await fetch(feedUrl, { headers: { Accept: 'application/gzip,application/octet-stream,text/csv,*/*' } });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`Awin feed HTTP ${resp.status} ${text.slice(0, 300)}`);
  }

  const nodeStream = Readable.fromWeb(resp.body as import('stream/web').ReadableStream);
  const gunzip = createGunzip();
  let streamError: Error | null = null;
  nodeStream.on('error', (e) => { streamError = e; });
  gunzip.on('error', (e) => { streamError = e; });
  nodeStream.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

  let header: string[] | null = null;
  let buffered = '';
  let rowsScanned = 0;

  for await (const rawLine of rl) {
    if (rowsScanned >= maxRowsScanned) break;
    buffered = buffered ? `${buffered}\n${rawLine}` : rawLine;
    if (hasUnbalancedQuotes(buffered)) continue; // multi-line quoted field — keep buffering

    const record = buffered;
    buffered = '';
    if (!record.trim()) continue;

    const fields = parseDelimitedRecord(record, ',');
    if (!header) {
      header = fields.map((h) => h.trim());
      continue;
    }
    rowsScanned++;
    const row: AwinRow = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = fields[i];
    yield row;
  }

  if (streamError) throw streamError;
}

// ==================== Normalization ====================

/** Parses a combined "11.50 USD" price string into cents + currency. */
function parsePriceString(raw: string | undefined): { cents: number; currency: string } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]{3})?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  return { cents: Math.round(n * 100), currency: (m[2] ?? 'USD').toUpperCase() };
}

function parseAvailability(raw: string | undefined): ProductUpsert['availability'] {
  const s = (raw ?? '').toLowerCase().trim();
  if (s === 'in_stock' || s === 'in stock') return 'in_stock';
  if (s === 'out_of_stock' || s === 'out of stock') return 'out_of_stock';
  if (s === 'preorder' || s === 'pre-order' || s === 'backorder') return 'preorder';
  return 'unknown';
}

// Google's `google_product_category` taxonomy branch determines the
// subcategory bucket. Order matters — e.g. "...Cosmetics > Make-Up > Eye
// Make-Up..." contains "eye" but must classify as makeup, not a hypothetical
// eye-care bucket, so the make-up check runs before any looser skin/eye rule.
const SUBCATEGORY_RULES: Array<{ key: string; patterns: RegExp[] }> = [
  { key: 'makeup', patterns: [/make-?up/] },
  { key: 'hair-care', patterns: [/hair\s*care/, /shampoo/, /conditioner/] },
  { key: 'fragrance', patterns: [/fragrance/, /perfume/, /cologne/] },
  { key: 'sun-care', patterns: [/sun\s*care/, /sunscreen/, /tanning/] },
  { key: 'body-care', patterns: [/bath\s*&\s*body/, /body\s*wash/, /deodorant/, /body\s*care/] },
  { key: 'face-care', patterns: [/skin\s*care/, /facial/, /\bface\b/] },
];

// MISSHA's feed leaves google_product_category/product_type BLANK for a
// meaningful chunk of SKUs (verified: ~20% of a real 200-row sync). Title
// keywords are a weaker signal than a real taxonomy field, so this only
// runs as a fallback when the primary rules above found nothing.
const TITLE_FALLBACK_RULES: Array<{ key: string; patterns: RegExp[] }> = [
  { key: 'makeup', patterns: [/\blip\s*(balm|tint|stick)\b/, /\bmascara\b/, /\bbb\s*cream\b/, /\bcc\s*cream\b/, /\bblush(er)?\b/, /\beyeliner\b/, /\beyebrow\b/, /\bconcealer\b/, /\bfoundation\b/] },
  { key: 'hair-care', patterns: [/\bhair\b/] },
  { key: 'body-care', patterns: [/\bbody\s*lotion\b/, /\bbody\s*wash\b/] },
  { key: 'face-care', patterns: [/\bessence\b/, /\bampoule\b/, /\bserum\b/, /\btoner\b/, /\beye\s*cream\b/, /\bnight\s*repair\b/, /\bemulsion\b/, /\bcollagen\b/, /\bmoistur/] },
];

function guessSubcategory(googleProductCategory: string | undefined, productType: string | undefined, title: string | undefined): string | undefined {
  const hay = `${googleProductCategory ?? ''} ${productType ?? ''}`.toLowerCase();
  if (hay.trim()) {
    for (const rule of SUBCATEGORY_RULES) {
      if (rule.patterns.some((p) => p.test(hay))) return rule.key;
    }
  }
  const titleHay = (title ?? '').toLowerCase();
  for (const rule of TITLE_FALLBACK_RULES) {
    if (rule.patterns.some((p) => p.test(titleHay))) return rule.key;
  }
  return undefined;
}

function normalizeAwinRow(
  row: AwinRow,
  merchantId: string,
  cfg: AwinSourceConfig
): ProductUpsert | null {
  const id = row.id;
  const title = row.title;
  if (!id || !title) return null;

  const priceParsed = parsePriceString(row.price);
  if (!priceParsed) return null;
  const saleParsed = parsePriceString(row.sale_price);

  // sale_price is the current selling price when present (Google Shopping
  // convention); price becomes the "compare at" strike-through.
  const priceCents = saleParsed ? saleParsed.cents : priceParsed.cents;
  const currency = saleParsed ? saleParsed.currency : priceParsed.currency;
  const compareCents = saleParsed && priceParsed.cents > saleParsed.cents ? priceParsed.cents : undefined;

  const images = [row.image_link, ...(row.additional_image_link ? row.additional_image_link.split(',') : [])]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);

  const affiliateUrl = row.aw_deep_link || row.link;
  if (!affiliateUrl) return null;

  return {
    merchant_id: merchantId,
    source_network: 'awin',
    source_product_id: String(id),
    gtin: row.gtin || undefined,
    sku: row.mpn || undefined,
    title,
    description: row.description,
    description_long: row.description,
    brand: row.brand,
    category: cfg.category ?? DEFAULT_CATEGORY,
    subcategory: guessSubcategory(row.google_product_category, row.product_type, row.title),
    price_cents: priceCents,
    currency,
    compare_at_price_cents: compareCents,
    images: [...new Set(images)],
    affiliate_url: affiliateUrl,
    availability: parseAvailability(row.availability),
    origin_country: row.ships_from_country || cfg.merchant_country,
    ships_to_countries: cfg.ships_to_countries ?? DEFAULT_SHIPS_TO_COUNTRIES,
    ships_to_regions: cfg.ships_to_regions ?? DEFAULT_SHIPS_TO_REGIONS,
    raw: row as unknown as Record<string, unknown>,
  };
}

// ==================== Per-feed sync ====================

async function syncOneFeed(
  cfg: AwinSourceConfig,
  feed: AwinFeedRef
): Promise<{ inserted: number; updated: number; skipped: number; errors: number; scanned: number; matched: number; error_sample: unknown[] }> {
  const advertiserName = feed.advertiser_name ?? 'Awin Advertiser';
  const advertiserSlug = advertiserName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'awin';

  const merchantId = await upsertMerchant({
    source_network: 'awin',
    source_merchant_id: advertiserSlug,
    name: advertiserName,
    affiliate_network: 'awin',
    merchant_country: cfg.merchant_country,
    ships_to_countries: cfg.ships_to_countries ?? DEFAULT_SHIPS_TO_COUNTRIES,
    ships_to_regions: cfg.ships_to_regions ?? DEFAULT_SHIPS_TO_REGIONS,
    quality_score: 65,
    customs_risk: 'unknown',
  });
  if (!merchantId) {
    return { inserted: 0, updated: 0, skipped: 0, errors: 1, scanned: 0, matched: 0, error_sample: [{ feed: advertiserName, error: 'merchant upsert failed' }] };
  }

  const maxProducts = cfg.max_products_per_feed ?? 500;
  const maxRowsScanned = cfg.max_rows_scanned ?? 50_000;

  const matched: ProductUpsert[] = [];
  let scanned = 0;
  let errors = 0;
  const errorSample: unknown[] = [];

  try {
    for await (const row of streamAwinRows(feed.feed_url, maxRowsScanned)) {
      scanned++;
      const p = normalizeAwinRow(row, merchantId, cfg);
      if (p) matched.push(p);
      if (matched.length >= maxProducts) break;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    errors++;
    errorSample.push({ feed: advertiserName, error: message });
  }

  if (matched.length === 0) {
    return { inserted: 0, updated: 0, skipped: 0, errors, scanned, matched: 0, error_sample: errorSample };
  }

  const r = await upsertProducts(matched, 'awin');
  return {
    inserted: r.inserted,
    updated: r.updated,
    skipped: r.skipped_unchanged,
    errors: errors + r.errors.length,
    scanned,
    matched: matched.length,
    error_sample: [...errorSample, ...r.errors.slice(0, 5)],
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
        feed_id: feed.feed_url,
        advertiser_id: feed.advertiser_name ?? 'unknown',
        inserted: stats.inserted,
        updated: stats.updated,
        skipped: stats.skipped,
        errors: stats.errors,
      });
      totals.inserted += stats.inserted;
      totals.updated += stats.updated;
      totals.skipped += stats.skipped;
      totals.errors += stats.errors;
      totals.fetched += stats.scanned;
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
