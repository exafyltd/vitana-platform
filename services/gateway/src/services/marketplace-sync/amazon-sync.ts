/**
 * VTID-01937: Amazon PA-API v5 (Product Advertising API) sync.
 *
 * https://webservices.amazon.com/paapi5/documentation/
 *
 * Access model:
 *   - Requires an Amazon Associates account in each marketplace you target
 *     (.com, .co.uk, .de, .co.jp, .ca, etc.) — separate accounts per region.
 *   - PA-API access gate: the Associate account must have had 3 qualifying
 *     sales in the last 180 days. Until that threshold, requests return 403.
 *   - After unlocking, the baseline TPS is 1 request/sec, ramping up with
 *     shipped revenue. We rate-limit at 1 req/sec here, conservatively.
 *
 * Config shape (JSON in marketplace_sources_config.config):
 *   {
 *     "access_key": "AKIA...",
 *     "secret_key": "...",
 *     "associate_tag": "vitana-20",
 *     "marketplace": "www.amazon.com",
 *     "keywords": "vitamin,supplement,probiotic",
 *     "merchant_country": "US",
 *     "commission_rate": 0.04,
 *     "max_pages": 10
 *   }
 *
 * One source row per marketplace — credentials differ per region.
 */

import { createHash, createHmac } from 'crypto';
import { getSupabase } from '../../lib/supabase';
import {
  startSyncRun,
  finishSyncRun,
  upsertMerchant,
  upsertProducts,
  type ProductUpsert,
} from './shared';
import { inferSupplementAttributes } from './supplement-inference';

// ==================== Config ====================

interface AmazonSourceConfig {
  access_key: string;
  secret_key: string;
  associate_tag: string;
  /** e.g. "www.amazon.com", "www.amazon.de". Drives host + AWS region + country. */
  marketplace: string;
  /** Comma-separated keywords — one SearchItems call per keyword. */
  keywords?: string;
  merchant_country?: string;
  commission_rate?: number;
  /** Hard cap on SearchItems pages per keyword (Amazon caps at 10 pages × 10 items). */
  max_pages?: number;
}

// https://webservices.amazon.com/paapi5/documentation/common-request-parameters.html
const MARKETPLACE_MAP: Record<string, { host: string; region: string; country: string }> = {
  'www.amazon.com':    { host: 'webservices.amazon.com',       region: 'us-east-1', country: 'US' },
  'www.amazon.co.uk':  { host: 'webservices.amazon.co.uk',     region: 'eu-west-1', country: 'GB' },
  'www.amazon.de':     { host: 'webservices.amazon.de',        region: 'eu-west-1', country: 'DE' },
  'www.amazon.fr':     { host: 'webservices.amazon.fr',        region: 'eu-west-1', country: 'FR' },
  'www.amazon.it':     { host: 'webservices.amazon.it',        region: 'eu-west-1', country: 'IT' },
  'www.amazon.es':     { host: 'webservices.amazon.es',        region: 'eu-west-1', country: 'ES' },
  'www.amazon.co.jp':  { host: 'webservices.amazon.co.jp',     region: 'us-west-2', country: 'JP' },
  'www.amazon.ca':     { host: 'webservices.amazon.ca',        region: 'us-east-1', country: 'CA' },
  'www.amazon.com.au': { host: 'webservices.amazon.com.au',    region: 'us-west-2', country: 'AU' },
  'www.amazon.in':     { host: 'webservices.amazon.in',        region: 'eu-west-1', country: 'IN' },
};

async function loadSourceConfigs(): Promise<AmazonSourceConfig[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from('marketplace_sources_config')
    .select('config')
    .eq('source_network', 'amazon')
    .eq('is_active', true);
  if (!data?.length) return [];
  return data
    .map((r) => r.config as AmazonSourceConfig)
    .filter((c) => c && c.access_key && c.secret_key && c.associate_tag && c.marketplace && MARKETPLACE_MAP[c.marketplace]);
}

// ==================== AWS SigV4 (SearchItems) ====================

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return createHmac('sha256', key).update(msg).digest();
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

interface SearchItemsPayload {
  Keywords: string;
  SearchIndex: string;
  ItemCount: number;
  ItemPage: number;
  PartnerTag: string;
  PartnerType: 'Associates';
  Marketplace: string;
  Resources: string[];
}

async function signedSearchItems(
  cfg: AmazonSourceConfig,
  payload: SearchItemsPayload
): Promise<Record<string, unknown>> {
  const mp = MARKETPLACE_MAP[cfg.marketplace];
  const service = 'ProductAdvertisingAPI';
  const region = mp.region;
  const host = mp.host;
  const path = '/paapi5/searchitems';
  const target = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems';
  const body = JSON.stringify(payload);

  // AWS timestamp: YYYYMMDD'T'HHMMSS'Z'
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${target}\n`;
  const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';
  const payloadHash = sha256Hex(body);

  const canonicalRequest = [
    'POST',
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kSigning = signingKey(cfg.secret_key, dateStamp, region, service);
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${cfg.access_key}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'amz-1.0',
      'Content-Type': contentType,
      Host: host,
      'X-Amz-Date': amzDate,
      'X-Amz-Target': target,
      Authorization: authHeader,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`Amazon PA-API HTTP ${resp.status} ${text.slice(0, 300)}`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

// ==================== Normalization ====================

interface AmazonImage { URL?: string; Height?: number; Width?: number }
interface AmazonImageSet { Large?: AmazonImage; Medium?: AmazonImage; Small?: AmazonImage; Variants?: AmazonImage[] }
interface AmazonItemInfo {
  Title?: { DisplayValue?: string };
  ByLineInfo?: { Brand?: { DisplayValue?: string }; Manufacturer?: { DisplayValue?: string } };
  Features?: { DisplayValues?: string[] };
  Classifications?: { ProductGroup?: { DisplayValue?: string }; Binding?: { DisplayValue?: string } };
  ExternalIds?: { EANs?: { DisplayValues?: string[] }; UPCs?: { DisplayValues?: string[] } };
  ContentInfo?: { Languages?: unknown };
}
interface AmazonOfferListing {
  Price?: { Amount?: number; Currency?: string; DisplayAmount?: string };
  SavingBasis?: { Amount?: number };
  Availability?: { Type?: string; Message?: string };
}
interface AmazonOffers { Listings?: AmazonOfferListing[]; Summaries?: unknown }
interface AmazonItem {
  ASIN: string;
  DetailPageURL?: string;
  Images?: { Primary?: AmazonImageSet; Variants?: AmazonImageSet[] };
  ItemInfo?: AmazonItemInfo;
  Offers?: AmazonOffers;
}

function normalizeAmazonItem(
  item: AmazonItem,
  cfg: AmazonSourceConfig,
  merchantId: string
): ProductUpsert | null {
  if (!item.ASIN) return null;
  const mp = MARKETPLACE_MAP[cfg.marketplace];
  const title = item.ItemInfo?.Title?.DisplayValue ?? '';
  if (!title) return null;

  const listing = item.Offers?.Listings?.[0];
  const priceAmount = listing?.Price?.Amount;
  const currency = (listing?.Price?.Currency ?? 'USD').toUpperCase();
  const priceCents = typeof priceAmount === 'number' ? Math.round(priceAmount * 100) : null;
  if (priceCents === null) return null;

  const compareAmount = listing?.SavingBasis?.Amount;
  const compareCents = typeof compareAmount === 'number' ? Math.round(compareAmount * 100) : undefined;

  const availabilityType = listing?.Availability?.Type;
  const availability: ProductUpsert['availability'] =
    availabilityType === 'Now' ? 'in_stock' :
    availabilityType === 'OutOfStock' ? 'out_of_stock' :
    availabilityType === 'Preorderable' ? 'preorder' : 'unknown';

  const images: string[] = [];
  if (item.Images?.Primary?.Large?.URL) images.push(item.Images.Primary.Large.URL);
  for (const v of item.Images?.Variants ?? []) {
    if (v.Large?.URL && !images.includes(v.Large.URL)) images.push(v.Large.URL);
  }

  const brand = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue
    ?? item.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue;
  const category = item.ItemInfo?.Classifications?.ProductGroup?.DisplayValue;
  const subcategory = item.ItemInfo?.Classifications?.Binding?.DisplayValue;
  const ean = item.ItemInfo?.ExternalIds?.EANs?.DisplayValues?.[0];
  const upc = item.ItemInfo?.ExternalIds?.UPCs?.DisplayValues?.[0];
  const gtin = ean ?? upc;

  const features = item.ItemInfo?.Features?.DisplayValues ?? [];
  const description = features.join('\n\n') || undefined;

  // Amazon's DetailPageURL already carries the PartnerTag (?tag=vitana-20)
  // because we passed PartnerTag in the request; preserve it as-is.
  const affiliateUrl = item.DetailPageURL ?? `https://${cfg.marketplace}/dp/${item.ASIN}?tag=${cfg.associate_tag}`;

  // Inference from title + features + category
  const inferText = [title, description ?? '', category ?? '', subcategory ?? ''].filter(Boolean).join(' ');
  const inferred = inferSupplementAttributes(inferText);

  return {
    merchant_id: merchantId,
    source_network: 'amazon',
    source_product_id: item.ASIN,
    asin: item.ASIN,
    gtin,
    title,
    description,
    description_long: description,
    brand,
    category: category ?? 'supplements',
    subcategory,
    price_cents: priceCents,
    currency,
    compare_at_price_cents: compareCents && compareCents > priceCents ? compareCents : undefined,
    images,
    affiliate_url: affiliateUrl,
    availability,
    origin_country: cfg.merchant_country ?? mp.country,
    ships_to_countries: [mp.country],
    health_goals: inferred.health_goals,
    dietary_tags: inferred.dietary_tags,
    ingredients_primary: inferred.ingredients_primary,
    form: inferred.form,
    certifications: inferred.certifications,
    raw: item as unknown as Record<string, unknown>,
  };
}

// ==================== Per-marketplace sync ====================

const SEARCH_RESOURCES = [
  'Images.Primary.Large',
  'Images.Variants.Large',
  'ItemInfo.Title',
  'ItemInfo.ByLineInfo',
  'ItemInfo.Features',
  'ItemInfo.Classifications',
  'ItemInfo.ExternalIds',
  'Offers.Listings.Price',
  'Offers.Listings.SavingBasis',
  'Offers.Listings.Availability.Type',
];

const RATE_LIMIT_MS = 1100; // 1 req/sec + headroom

async function syncOneMarketplace(
  cfg: AmazonSourceConfig
): Promise<{ inserted: number; updated: number; skipped: number; errors: number; error_sample: unknown[] }> {
  const mp = MARKETPLACE_MAP[cfg.marketplace];
  const merchantId = await upsertMerchant({
    source_network: 'amazon',
    source_merchant_id: cfg.marketplace,
    name: `Amazon ${mp.country}`,
    slug: cfg.marketplace.replace(/^www\./, ''),
    storefront_url: `https://${cfg.marketplace}`,
    merchant_country: cfg.merchant_country ?? mp.country,
    ships_to_countries: [mp.country],
    affiliate_network: 'amazon',
    commission_rate: cfg.commission_rate,
    quality_score: 85,
    customs_risk: 'low',
  });
  if (!merchantId) {
    return { inserted: 0, updated: 0, skipped: 0, errors: 1, error_sample: [{ marketplace: cfg.marketplace, error: 'merchant upsert failed' }] };
  }

  const keywords = (cfg.keywords ?? 'supplement,vitamin')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const maxPages = Math.max(1, Math.min(cfg.max_pages ?? 10, 10));

  let inserted = 0, updated = 0, skipped = 0, errors = 0;
  const errorSample: unknown[] = [];
  let lastReqAt = 0;

  for (const kw of keywords) {
    for (let page = 1; page <= maxPages; page++) {
      // Conservative rate limit: 1 req/sec baseline
      const delta = Date.now() - lastReqAt;
      if (delta < RATE_LIMIT_MS) await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - delta));
      lastReqAt = Date.now();

      let resp: Record<string, unknown>;
      try {
        resp = await signedSearchItems(cfg, {
          Keywords: kw,
          SearchIndex: 'HealthPersonalCare',
          ItemCount: 10,
          ItemPage: page,
          PartnerTag: cfg.associate_tag,
          PartnerType: 'Associates',
          Marketplace: cfg.marketplace,
          Resources: SEARCH_RESOURCES,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors++;
        errorSample.push({ marketplace: cfg.marketplace, keyword: kw, page, error: message });
        // 403 typically means PA-API access not yet granted — skip remaining pages for this kw
        break;
      }

      const searchResult = resp.SearchResult as { Items?: AmazonItem[] } | undefined;
      const items = searchResult?.Items ?? [];
      if (items.length === 0) break;

      const normalized = items
        .map((i) => normalizeAmazonItem(i, cfg, merchantId))
        .filter((p): p is ProductUpsert => p !== null);

      if (normalized.length === 0) continue;

      const result = await upsertProducts(normalized, 'amazon');
      inserted += result.inserted;
      updated += result.updated;
      skipped += result.skipped_unchanged;
      if (result.errors.length) {
        errors += result.errors.length;
        errorSample.push(...result.errors.slice(0, 3));
      }

      if (items.length < 10) break; // last page for this keyword
    }
  }

  return { inserted, updated, skipped, errors, error_sample: errorSample.slice(0, 10) };
}

// ==================== Entry point ====================

export interface AmazonSyncResult {
  ok: boolean;
  marketplaces_synced: number;
  totals: { inserted: number; updated: number; skipped: number; errors: number };
  per_marketplace: Array<{ marketplace: string; inserted: number; updated: number; skipped: number; errors: number }>;
  duration_ms: number;
}

export async function runAmazonSync(triggered_by = 'scheduler'): Promise<AmazonSyncResult> {
  const startTime = Date.now();
  const configs = await loadSourceConfigs();
  if (configs.length === 0) {
    console.log('[amazon-sync] no marketplaces configured — skipping');
    return {
      ok: true,
      marketplaces_synced: 0,
      totals: { inserted: 0, updated: 0, skipped: 0, errors: 0 },
      per_marketplace: [],
      duration_ms: Date.now() - startTime,
    };
  }

  const run = await startSyncRun('amazon', triggered_by);
  const per_marketplace: AmazonSyncResult['per_marketplace'] = [];
  const totals = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
  const errorSample: unknown[] = [];

  for (const cfg of configs) {
    const stats = await syncOneMarketplace(cfg);
    per_marketplace.push({
      marketplace: cfg.marketplace,
      inserted: stats.inserted,
      updated: stats.updated,
      skipped: stats.skipped,
      errors: stats.errors,
    });
    totals.inserted += stats.inserted;
    totals.updated += stats.updated;
    totals.skipped += stats.skipped;
    totals.errors += stats.errors;
    if (stats.error_sample.length) errorSample.push(...stats.error_sample);
  }

  if (run) await finishSyncRun(run, { ...totals, error_sample: errorSample.slice(0, 10) });

  const duration_ms = Date.now() - startTime;
  console.log(
    `[amazon-sync] done in ${duration_ms}ms — ${totals.inserted} inserted, ${totals.updated} updated, ` +
    `${totals.skipped} skipped, ${totals.errors} errors across ${configs.length} marketplaces`
  );

  return { ok: totals.errors === 0, marketplaces_synced: configs.length, totals, per_marketplace, duration_ms };
}
