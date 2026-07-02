/**
 * VTID-02000: Admitad product-feed sync.
 *
 * Admitad distributes catalogs as per-advertiser CSV/XML "product feeds"
 * generated from the publisher dashboard (Tools → Product Feeds → Original
 * Product Feed). Each generated link is a stable, repeatable download —
 * there is no separate OAuth "Products API" step for this path.
 *
 * Verified real feed sample (AliExpress/Alibaba WW "Basic" template,
 * semicolon-delimited CSV):
 *
 *   id;name;url;category;currencyId;param;picture;oldprice;price
 *   1005011660569097;100ML Espresso...;https://rzekl.com/g/.../?ulp=...aliexpress.com%2Fitem%2F1005011660569097.html...;Kitchen,Dining & Bar;USD;"discount|69%|;commissionRate|5.38%|;shopId|1105297342|;";https://ae-pic-a1.aliexpress-media.com/kf/....jpg;33.64;10.43
 *
 * Two important properties of this feed shape (do not assume for other
 * templates without re-verifying):
 *   - `url` is ALREADY the complete, ready-to-use affiliate deep link,
 *     pointing at the SPECIFIC product page (not a search/category page).
 *   - `picture` is the REAL merchant CDN product photo.
 *   - `currencyId` reflects whatever the export template/feed actually
 *     returns — it does NOT necessarily match the "Currency" dropdown
 *     selected when generating the link. We pass it through as-is rather
 *     than assume/convert.
 *
 * These feeds are NOT pre-filtered to a category — a "WW Basic" feed is the
 * advertiser's ENTIRE catalog (drone motors, kitchen tools, car parts, …).
 * We apply a client-side keyword allow-list (config.keywords) against
 * name+category to keep only wellness/supplement-relevant rows.
 *
 * Config shape (JSON in marketplace_sources_config.config):
 *   {
 *     "feeds": [
 *       { "feed_url": "https://export.admitad.com/en/webmaster/websites/.../export_adv_products/?user=...&code=...&template=...&currency=EUR&feed_id=...",
 *         "advertiser_name": "AliExpress" }
 *     ],
 *     "keywords": "vitamin,supplement,omega,collagen,magnesium,ashwagandha,creatine,probiotic,coq10,curcumin,turmeric,resveratrol,multivitamin,fish oil,protein powder,biotin,zinc,melatonin,electrolyte,theanine,rhodiola",
 *     "max_products_per_feed": 200,
 *     "max_rows_scanned": 300000
 *   }
 *
 * The feed_url's `code` query param is a personal export credential tied to
 * the publisher account — treat it as sensitive (same handling as Awin's
 * api_key: stored in this JSON config, never returned to the client).
 */

import { Readable } from 'stream';
import { createInterface } from 'readline';
import {
  startSyncRun,
  finishSyncRun,
  upsertMerchant,
  upsertProducts,
  type ProductUpsert,
} from './shared';
import { inferSupplementAttributes } from './supplement-inference';
import { getSupabase } from '../../lib/supabase';

interface AdmitadFeedRef {
  feed_url: string;
  advertiser_name?: string;
}

interface AdmitadSourceConfig {
  feeds: AdmitadFeedRef[];
  /** Comma-separated allow-list matched (case-insensitive substring) against name+category. */
  keywords?: string;
  max_products_per_feed?: number;
  /** Safety bound on how many CSV rows we scan before giving up on a feed (default 300k). */
  max_rows_scanned?: number;
  merchant_country?: string;
}

const DEFAULT_KEYWORDS =
  'vitamin,supplement,omega,collagen,magnesium,ashwagandha,creatine,probiotic,coq10,' +
  'curcumin,turmeric,resveratrol,multivitamin,fish oil,protein powder,biotin,zinc,' +
  'melatonin,electrolyte,theanine,rhodiola,ginseng,spirulina,glucosamine,iron supplement,' +
  'calcium supplement,vitamin d,vitamin c,vitamin b';

async function loadSourceConfigs(): Promise<AdmitadSourceConfig[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from('marketplace_sources_config')
    .select('config')
    .eq('source_network', 'admitad_feed')
    .eq('is_active', true);
  if (!data?.length) return [];
  return data
    .map((r) => r.config as AdmitadSourceConfig)
    .filter((c) => c && Array.isArray(c.feeds) && c.feeds.length > 0);
}

// ==================== CSV parsing (semicolon-delimited, RFC4126-ish quoting) ====================

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

interface AdmitadRow {
  id?: string;
  name?: string;
  url?: string;
  category?: string;
  currencyId?: string;
  param?: string;
  picture?: string;
  oldprice?: string;
  price?: string;
  [key: string]: string | undefined;
}

/**
 * Streams the feed and yields normalized row objects, keyed by the header
 * row's own column names — so we don't hardcode column order/position, only
 * the set of names we read from each row.
 */
async function* streamAdmitadRows(
  feedUrl: string,
  delim: string,
  maxRowsScanned: number
): AsyncGenerator<AdmitadRow> {
  const resp = await fetch(feedUrl, { headers: { Accept: 'text/csv,text/plain,*/*' } });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`Admitad feed HTTP ${resp.status} ${text.slice(0, 300)}`);
  }

  const nodeStream = Readable.fromWeb(resp.body as import('stream/web').ReadableStream);
  const rl = createInterface({ input: nodeStream, crlfDelay: Infinity });

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

    const fields = parseDelimitedRecord(record, delim);
    if (!header) {
      header = fields.map((h) => h.trim());
      continue;
    }
    rowsScanned++;
    const row: AdmitadRow = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = fields[i];
    yield row;
  }
}

// ==================== Normalization ====================

function parseCents(amountStr: string | undefined): number | null {
  if (!amountStr) return null;
  const n = parseFloat(amountStr.replace(/[^0-9.]/g, ''));
  return Number.isNaN(n) ? null : Math.round(n * 100);
}

function matchesKeywords(row: AdmitadRow, keywords: string[]): boolean {
  const hay = `${row.name ?? ''} ${row.category ?? ''}`.toLowerCase();
  return keywords.some((k) => hay.includes(k));
}

function normalizeAdmitadRow(
  row: AdmitadRow,
  merchantId: string,
  advertiserSlug: string,
  country?: string
): ProductUpsert | null {
  const id = row.id;
  const title = row.name;
  const url = row.url;
  if (!id || !title || !url) return null;

  const priceCents = parseCents(row.price);
  if (priceCents === null) return null;
  const currency = (row.currencyId || 'USD').toUpperCase();
  const oldCents = parseCents(row.oldprice);
  const compareCents = oldCents && oldCents > priceCents ? oldCents : undefined;

  const images = row.picture ? [row.picture] : [];

  const inferText = [title, row.category ?? ''].filter(Boolean).join(' ');
  const inferred = inferSupplementAttributes(inferText);

  return {
    merchant_id: merchantId,
    source_network: 'admitad_feed',
    source_product_id: `${advertiserSlug}-${id}`,
    title,
    category: row.category,
    price_cents: priceCents,
    currency,
    compare_at_price_cents: compareCents,
    images,
    affiliate_url: url,
    availability: 'in_stock', // this feed template carries no explicit stock column
    origin_country: country,
    health_goals: inferred.health_goals,
    dietary_tags: inferred.dietary_tags,
    ingredients_primary: inferred.ingredients_primary,
    form: inferred.form,
    certifications: inferred.certifications,
    raw: row as unknown as Record<string, unknown>,
  };
}

// ==================== Per-feed sync ====================

async function syncOneFeed(
  cfg: AdmitadSourceConfig,
  feed: AdmitadFeedRef
): Promise<{ inserted: number; updated: number; skipped: number; errors: number; scanned: number; matched: number; error_sample: unknown[] }> {
  const advertiserName = feed.advertiser_name ?? 'Admitad Advertiser';
  const advertiserSlug = advertiserName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'admitad';

  const merchantId = await upsertMerchant({
    source_network: 'admitad_feed',
    source_merchant_id: advertiserSlug,
    name: advertiserName,
    affiliate_network: 'admitad',
    merchant_country: cfg.merchant_country,
    quality_score: 60,
    customs_risk: 'unknown',
  });
  if (!merchantId) {
    return { inserted: 0, updated: 0, skipped: 0, errors: 1, scanned: 0, matched: 0, error_sample: [{ feed: advertiserName, error: 'merchant upsert failed' }] };
  }

  const keywords = (cfg.keywords ?? DEFAULT_KEYWORDS).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const maxProducts = cfg.max_products_per_feed ?? 200;
  const maxRowsScanned = cfg.max_rows_scanned ?? 300_000;

  const matched: ProductUpsert[] = [];
  let scanned = 0;
  let errors = 0;
  const errorSample: unknown[] = [];

  try {
    for await (const row of streamAdmitadRows(feed.feed_url, ';', maxRowsScanned)) {
      scanned++;
      if (!matchesKeywords(row, keywords)) continue;
      const p = normalizeAdmitadRow(row, merchantId, advertiserSlug, cfg.merchant_country);
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

  const r = await upsertProducts(matched, 'admitad_feed');
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

export interface AdmitadSyncResult {
  ok: boolean;
  totals: { inserted: number; updated: number; skipped: number; errors: number; scanned: number; matched: number };
  feeds_synced: number;
  duration_ms: number;
  per_feed: Array<{ advertiser_name: string; inserted: number; updated: number; skipped: number; errors: number; scanned: number; matched: number }>;
}

export async function runAdmitadSync(triggered_by = 'scheduler'): Promise<AdmitadSyncResult> {
  const startTime = Date.now();
  const configs = await loadSourceConfigs();
  if (configs.length === 0) {
    console.log('[admitad-sync] no feeds configured — skipping');
    return {
      ok: true,
      totals: { inserted: 0, updated: 0, skipped: 0, errors: 0, scanned: 0, matched: 0 },
      feeds_synced: 0,
      per_feed: [],
      duration_ms: Date.now() - startTime,
    };
  }

  const totals = { inserted: 0, updated: 0, skipped: 0, errors: 0, scanned: 0, matched: 0 };
  const per_feed: AdmitadSyncResult['per_feed'] = [];
  const errorSample: unknown[] = [];
  let feedCount = 0;

  for (const cfg of configs) {
    const run = await startSyncRun('admitad_feed', triggered_by);
    for (const feed of cfg.feeds) {
      feedCount++;
      const stats = await syncOneFeed(cfg, feed);
      per_feed.push({
        advertiser_name: feed.advertiser_name ?? 'Admitad Advertiser',
        inserted: stats.inserted,
        updated: stats.updated,
        skipped: stats.skipped,
        errors: stats.errors,
        scanned: stats.scanned,
        matched: stats.matched,
      });
      totals.inserted += stats.inserted;
      totals.updated += stats.updated;
      totals.skipped += stats.skipped;
      totals.errors += stats.errors;
      totals.scanned += stats.scanned;
      totals.matched += stats.matched;
      if (stats.error_sample.length) errorSample.push(...stats.error_sample);
    }
    if (run) {
      await finishSyncRun(run, {
        inserted: totals.inserted,
        updated: totals.updated,
        skipped: totals.skipped,
        errors: totals.errors,
        error_sample: errorSample.slice(0, 10),
      });
    }
  }

  const duration_ms = Date.now() - startTime;
  console.log(
    `[admitad-sync] done in ${duration_ms}ms — scanned ${totals.scanned}, matched ${totals.matched}, ` +
    `${totals.inserted} inserted, ${totals.updated} updated, ${totals.skipped} skipped, ${totals.errors} errors ` +
    `across ${feedCount} feeds`
  );

  return { ok: totals.errors === 0, totals, feeds_synced: feedCount, per_feed, duration_ms };
}
