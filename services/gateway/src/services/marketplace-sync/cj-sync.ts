/**
 * VTID-02200: CJ Affiliate (Commission Junction) Product Search sync.
 *
 * https://developers.cj.com/ — Product Search API v2.
 * Uses a single publisher account per environment. Configure:
 *   CJ_DEVELOPER_KEY           — Bearer token
 *   CJ_WEBSITE_ID              — publisher website ID (e.g. 12345678)
 *   CJ_ADVERTISER_IDS          — comma-separated advertiser IDs (optional filter)
 *   CJ_KEYWORDS                — comma-separated keyword filters (optional)
 *   CJ_PRODUCT_LIMIT           — max products per run (default 1000)
 *
 * Deep-link pattern for CJ affiliate URLs:
 *   https://www.anrdoezrs.net/links/{websiteId}/type/dlg/sid/{click_id}/{encoded_target_url}
 * The click_id is stamped at click-redirect time by our own /r/:product_id
 * handler (from Phase 0), so during sync we store the merchant's target URL
 * as `affiliate_url` and let /r/:product_id build the CJ deep-link.
 */

import { getSupabase } from '../../lib/supabase';
import {
  startSyncRun,
  finishSyncRun,
  upsertMerchant,
  upsertProducts,
  deriveRegionGroup,
  type ProductUpsert,
} from './shared';

function cjCreds(): { developer_key: string; website_id: string } | null {
  const developer_key = process.env.CJ_DEVELOPER_KEY;
  const website_id = process.env.CJ_WEBSITE_ID;
  if (!developer_key || !website_id) return null;
  return { developer_key, website_id };
}

// ==================== CJ Product Search API ====================

interface CjProductRaw {
  'ad-id'?: string;
  'catalog-id'?: string;
  'advertiser-id'?: string;
  'advertiser-name'?: string;
  'buy-url'?: string;
  'currency'?: string;
  'description'?: string;
  'image-url'?: string;
  'in-stock'?: string | boolean;
  'manufacturer-name'?: string;
  'manufacturer-sku'?: string;
  'name'?: string;
  'price'?: string;
  'retail-price'?: string;
  'sale-price'?: string;
  'upc'?: string;
  'isbn'?: string;
  'ean'?: string;
  'keywords'?: string;
  'advertiser-category'?: string;
  'third-party-category'?: string;
  'third-party-id'?: string;
  'country-of-origin'?: string;
}

interface CjProductSearchResp {
  products?: {
    '@attributes'?: { 'total-matched'?: string; 'records-returned'?: string; 'page-number'?: string };
    product?: CjProductRaw[] | CjProductRaw;
  };
}

async function fetchCjPage(
  creds: { developer_key: string; website_id: string },
  opts: { keywords?: string; advertiserIds?: string; pageNumber: number; recordsPerPage?: number }
): Promise<CjProductRaw[]> {
  const qs = new URLSearchParams({
    'website-id': creds.website_id,
    'records-per-page': String(opts.recordsPerPage ?? 100),
    'page-number': String(opts.pageNumber),
    'serviceable-area': 'US,GB,DE,FR,IT,ES,NL,SE',
  });
  if (opts.keywords) qs.set('keywords', opts.keywords);
  if (opts.advertiserIds) qs.set('advertiser-ids', opts.advertiserIds);

  const url = `https://product-search.api.cj.com/v2/product-search?${qs.toString()}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.developer_key}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`CJ ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as CjProductSearchResp;
  const products = data.products?.product;
  if (!products) return [];
  return Array.isArray(products) ? products : [products];
}

// ==================== Normalization ====================

function parseCents(amountStr: string | undefined): number | null {
  if (!amountStr) return null;
  const cleaned = amountStr.replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

function boolish(v: string | boolean | undefined): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'yes' || v === 'true' || v === '1';
  return true; // default to in-stock
}

function normalizeCjProduct(raw: CjProductRaw, merchantMap: Map<string, string>): ProductUpsert | null {
  const adId = raw['ad-id'] ?? raw['catalog-id'];
  if (!adId) return null;
  const advertiserId = raw['advertiser-id'];
  if (!advertiserId) return null;

  const merchantId = merchantMap.get(advertiserId);
  if (!merchantId) return null; // will be skipped at upsert; caller retries after merchant upsert

  const priceCents = parseCents(raw['sale-price']) ?? parseCents(raw['price']) ?? parseCents(raw['retail-price']);
  if (priceCents === null) return null;

  const currency = (raw['currency'] ?? 'USD').toUpperCase();
  const gtin = raw['ean'] ?? raw['isbn'] ?? raw['upc'];
  const origin_country = raw['country-of-origin']?.toUpperCase();
  const compareAt = parseCents(raw['retail-price']);

  const images: string[] = [];
  if (raw['image-url']) images.push(raw['image-url']);

  const tags: string[] = [];
  if (raw['keywords']) {
    for (const k of raw['keywords'].split(',')) {
      const clean = k.trim().toLowerCase();
      if (clean) tags.push(clean);
    }
  }

  return {
    merchant_id: merchantId,
    source_network: 'cj',
    source_product_id: String(adId),
    gtin,
    sku: raw['manufacturer-sku'],
    title: raw['name'] ?? 'Untitled product',
    description: raw['description'],
    brand: raw['manufacturer-name'],
    category: raw['advertiser-category'] ?? raw['third-party-category'],
    topic_keys: tags.slice(0, 20),
    price_cents: priceCents,
    currency,
    compare_at_price_cents: compareAt && compareAt > priceCents ? compareAt : undefined,
    images,
    affiliate_url: raw['buy-url'] ?? '',
    availability: boolish(raw['in-stock']) ? 'in_stock' : 'out_of_stock',
    origin_country,
    raw: raw as unknown as Record<string, unknown>,
  };
}

// ==================== Merchant resolution ====================

async function ensureCjMerchants(rawProducts: CjProductRaw[]): Promise<Map<string, string>> {
  const supabase = getSupabase();
  if (!supabase) return new Map();

  // Gather unique advertisers from the batch
  const advertisers = new Map<string, { name: string; country?: string }>();
  for (const p of rawProducts) {
    const id = p['advertiser-id'];
    if (!id) continue;
    if (advertisers.has(id)) continue;
    advertisers.set(id, {
      name: p['advertiser-name'] ?? `CJ Advertiser ${id}`,
      country: p['country-of-origin']?.toUpperCase(),
    });
  }

  const merchantMap = new Map<string, string>();
  for (const [advertiserId, info] of advertisers) {
    const merchantId = await upsertMerchant({
      source_network: 'cj',
      source_merchant_id: advertiserId,
      name: info.name,
      merchant_country: info.country,
      affiliate_network: 'cj',
      quality_score: 60,
      customs_risk: 'unknown',
    });
    if (merchantId) merchantMap.set(advertiserId, merchantId);
  }
  return merchantMap;
}

// ==================== Entry point ====================

export interface CjSyncResult {
  ok: boolean;
  totals: { inserted: number; updated: number; skipped: number; errors: number; fetched: number };
  pages_fetched: number;
  advertisers_seen: number;
  duration_ms: number;
  error?: string;
}

export async function runCjSync(triggered_by = 'scheduler'): Promise<CjSyncResult> {
  const startTime = Date.now();
  const creds = cjCreds();
  if (!creds) {
    console.log('[cj-sync] CJ_DEVELOPER_KEY / CJ_WEBSITE_ID not set — skipping');
    return {
      ok: true,
      totals: { inserted: 0, updated: 0, skipped: 0, errors: 0, fetched: 0 },
      pages_fetched: 0,
      advertisers_seen: 0,
      duration_ms: Date.now() - startTime,
    };
  }

  const run = await startSyncRun('cj', triggered_by);
  const maxProducts = parseInt(process.env.CJ_PRODUCT_LIMIT ?? '1000', 10);
  const keywords = process.env.CJ_KEYWORDS;          // optional comma list
  const advertiserIds = process.env.CJ_ADVERTISER_IDS; // optional comma list

  const totals = { inserted: 0, updated: 0, skipped: 0, errors: 0, fetched: 0 };
  const errorSample: unknown[] = [];
  const advertisersSeen = new Set<string>();
  let pageNumber = 1;

  while (totals.fetched < maxProducts) {
    let rawPage: CjProductRaw[];
    try {
      rawPage = await fetchCjPage(creds, {
        keywords,
        advertiserIds,
        pageNumber,
        recordsPerPage: 100,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errorSample.push({ pageNumber, error: message });
      totals.errors++;
      break;
    }
    if (rawPage.length === 0) break;
    totals.fetched += rawPage.length;

    const merchantMap = await ensureCjMerchants(rawPage);
    for (const id of merchantMap.keys()) advertisersSeen.add(id);

    const normalized = rawPage
      .map((r) => normalizeCjProduct(r, merchantMap))
      .filter((p): p is ProductUpsert => p !== null);

    if (normalized.length === 0) {
      pageNumber++;
      continue;
    }

    const result = await upsertProducts(normalized, 'cj');
    totals.inserted += result.inserted;
    totals.updated += result.updated;
    totals.skipped += result.skipped_unchanged;
    if (result.errors.length) {
      totals.errors += result.errors.length;
      errorSample.push(...result.errors.slice(0, 5));
    }

    if (rawPage.length < 100) break; // last page
    pageNumber++;
  }

  if (run) await finishSyncRun(run, { ...totals, error_sample: errorSample });

  const duration_ms = Date.now() - startTime;
  console.log(`[cj-sync] done in ${duration_ms}ms — fetched ${totals.fetched}, ${totals.inserted}+ ${totals.updated}~ ${totals.skipped}= ${totals.errors}! across ${advertisersSeen.size} advertisers`);

  return { ok: totals.errors === 0, totals, pages_fetched: pageNumber, advertisers_seen: advertisersSeen.size, duration_ms };
}
