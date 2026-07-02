/**
 * VCAOP: Admitad product catalog sync.
 *
 * Admitad (Mitgo) is already wired as a rewards/postback network — publisher
 * account live, "Vitanaland Discover" ad space verified, Alibaba WW joined,
 * token verified (HTTP 200) against https://api.admitad.com/token/. This module
 * adds the *catalog* half: pull product data via the Admitad Products API and
 * upsert it into `products` so items show on /discover.
 *
 * AUTH: OAuth2 client_credentials. POST /token/ with HTTP Basic
 *   (base64(client_id:client_secret)) + grant_type=client_credentials&scope=...
 * Credentials come from the source config row, falling back to the
 * Secret-Manager-bound env (VCAOP_ADMITAD_*) used by the existing postback flow.
 *
 * PRODUCTS: GET /products/ — paginated ({results, _meta:{count,limit,offset}}).
 * Admitad's product schema is not pinned from public docs (the API is
 * account-gated), so normalization is DEFENSIVE: every field tries several
 * candidate names, the raw item is stored on the row, and the first item of
 * each campaign is logged so the field mapping can be confirmed live on the
 * first real sync (activation step). Get a field wrong and you see it in the
 * sample log / `raw` column rather than silently shipping garbage.
 *
 * Config shape (JSON in marketplace_sources_config.config):
 *   {
 *     "client_id": "...",            // optional — falls back to VCAOP_ADMITAD_CLIENT_ID
 *     "client_secret": "...",        // optional — falls back to VCAOP_ADMITAD_CLIENT_SECRET
 *     "scope": "products",           // optional, default "products"
 *     "campaign_ids": ["12345"],     // advertiser campaign ids to pull; empty = all connected
 *     "gotolink_base": "https://rzekl.com/g/.../",  // optional — wraps product url as affiliate link
 *     "merchant_country": "DE",      // optional fallback
 *     "max_products": 1000,          // optional, default 1000 (across all campaigns)
 *     "page_size": 200               // optional, default 200 (Admitad max is typically 500)
 *   }
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

const ADMITAD_API_BASE = process.env.ADMITAD_API_BASE || 'https://api.admitad.com';

export interface AdmitadSourceConfig {
  client_id?: string;
  client_secret?: string;
  scope?: string;
  campaign_ids?: string[];
  gotolink_base?: string;
  merchant_country?: string;
  max_products?: number;
  page_size?: number;
}

async function loadSourceConfigs(): Promise<AdmitadSourceConfig[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from('marketplace_sources_config')
    .select('config')
    .eq('source_network', 'admitad')
    .eq('is_active', true);
  if (!data?.length) return [];
  return data.map((r) => r.config as AdmitadSourceConfig).filter(Boolean);
}

// ==================== Auth ====================

function resolveCredentials(cfg: AdmitadSourceConfig): {
  clientId: string;
  clientSecret: string;
  basicHeader: string;
} | null {
  const clientId = cfg.client_id || process.env.VCAOP_ADMITAD_CLIENT_ID || '';
  const clientSecret = cfg.client_secret || process.env.VCAOP_ADMITAD_CLIENT_SECRET || '';
  // A pre-built base64 "client_id:client_secret" header may be bound in Secret
  // Manager (VCAOP_ADMITAD_BASE64_HEADER) — prefer it when id/secret absent.
  const envHeader = process.env.VCAOP_ADMITAD_BASE64_HEADER;
  if (clientId && clientSecret) {
    const basicHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    return { clientId, clientSecret, basicHeader };
  }
  if (envHeader) {
    // Derive client_id from the header so the token body can include it.
    const decoded = Buffer.from(envHeader, 'base64').toString('utf8');
    const [id, ...rest] = decoded.split(':');
    return { clientId: id, clientSecret: rest.join(':'), basicHeader: envHeader };
  }
  return null;
}

async function fetchAccessToken(cfg: AdmitadSourceConfig): Promise<string> {
  const creds = resolveCredentials(cfg);
  if (!creds) {
    throw new Error('Admitad credentials missing (config.client_id/secret or VCAOP_ADMITAD_* env)');
  }
  const scope = cfg.scope || 'products';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    scope,
  });
  const resp = await fetch(`${ADMITAD_API_BASE}/token/`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds.basicHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`Admitad token HTTP ${resp.status} ${text.slice(0, 300)}`);
  }
  const json = (await resp.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('Admitad token response missing access_token');
  return json.access_token;
}

// ==================== Products fetch ====================

interface AdmitadProductItem {
  [key: string]: unknown;
}

interface AdmitadProductsPage {
  results?: AdmitadProductItem[];
  _meta?: { count?: number; limit?: number; offset?: number };
}

/**
 * Fetch one page of products. `campaignId` filters to a single advertiser
 * campaign when provided; otherwise the publisher's whole connected catalog.
 */
async function fetchProductsPage(
  token: string,
  campaignId: string | undefined,
  limit: number,
  offset: number
): Promise<AdmitadProductsPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (campaignId) params.set('campaign', campaignId);
  const url = `${ADMITAD_API_BASE}/products/?${params.toString()}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`Admitad products HTTP ${resp.status} ${text.slice(0, 300)}`);
  }
  const json = (await resp.json()) as AdmitadProductsPage | AdmitadProductItem[];
  if (Array.isArray(json)) return { results: json };
  return json;
}

// ==================== Normalization (defensive) ====================

function pick(item: AdmitadProductItem, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = item[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function pickFirstImage(item: AdmitadProductItem): string | undefined {
  const single = pick(item, 'picture', 'image', 'image_url', 'picture_url', 'imageUrl');
  if (single) return single;
  // Some feeds nest images as arrays under various keys.
  for (const k of ['pictures', 'images', 'image_urls']) {
    const v = item[k];
    if (Array.isArray(v) && v.length) {
      const first = v[0];
      if (typeof first === 'string' && first.trim()) return first.trim();
      if (first && typeof first === 'object') {
        const u = (first as Record<string, unknown>).url ?? (first as Record<string, unknown>).src;
        if (typeof u === 'string' && u.trim()) return u.trim();
      }
    }
  }
  return undefined;
}

function parseCents(amountStr: string | undefined): number | null {
  if (!amountStr) return null;
  const n = parseFloat(amountStr.replace(/[^0-9.]/g, ''));
  return Number.isNaN(n) ? null : Math.round(n * 100);
}

function parseAvailability(item: AdmitadProductItem): ProductUpsert['availability'] {
  const raw = item.available ?? item.in_stock ?? item.availability ?? item.is_available;
  if (raw === true || raw === 1) return 'in_stock';
  if (raw === false || raw === 0) return 'out_of_stock';
  const s = String(raw ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('out')) return 'out_of_stock';
  if (s.includes('preorder') || s.includes('pre-order')) return 'preorder';
  if (s.includes('discontinued')) return 'discontinued';
  if (s === 'true' || s === 'yes' || s === '1' || s.includes('in stock') || s.includes('available')) {
    return 'in_stock';
  }
  return 'unknown';
}

/** Build the affiliate destination: explicit deeplink wins; else wrap via gotolink_base. */
function resolveAffiliateUrl(item: AdmitadProductItem, cfg: AdmitadSourceConfig): string {
  const deeplink = pick(item, 'deeplink', 'gotolink', 'gotourl', 'aw_deep_link', 'affiliate_url');
  if (deeplink) return deeplink;
  const productUrl = pick(item, 'url', 'link', 'product_url') ?? '';
  if (cfg.gotolink_base && productUrl) {
    const sep = cfg.gotolink_base.includes('?') ? '&' : '?';
    return `${cfg.gotolink_base}${sep}ulp=${encodeURIComponent(productUrl)}`;
  }
  return productUrl;
}

export function normalizeAdmitadItem(
  item: AdmitadProductItem,
  cfg: AdmitadSourceConfig,
  merchantId: string
): ProductUpsert | null {
  const id = pick(item, 'id', 'product_id', 'sku', 'model');
  if (!id) return null;
  const title = pick(item, 'name', 'title', 'product_name');
  if (!title) return null;

  const priceCents = parseCents(pick(item, 'price', 'search_price', 'current_price'));
  if (priceCents === null) return null;
  const currency = (pick(item, 'currency', 'currency_code') ?? 'EUR').toUpperCase();
  const oldCents = parseCents(pick(item, 'oldprice', 'old_price', 'rrp_price', 'compare_at_price'));
  const compareCents = oldCents && oldCents > priceCents ? oldCents : undefined;

  const description = pick(item, 'description', 'short_description', 'product_short_description');
  const brand = pick(item, 'vendor', 'brand', 'brand_name', 'manufacturer');
  const category = pick(item, 'category', 'category_name', 'merchant_category');
  const gtin = pick(item, 'product_gtin', 'gtin', 'ean', 'upc', 'barcode');

  const images: string[] = [];
  const img = pickFirstImage(item);
  if (img) images.push(img);

  const keywords = pick(item, 'keywords', 'tags');
  const topic_keys: string[] = [];
  if (keywords) {
    for (const k of keywords.split(/[,;]/)) {
      const s = k.trim().toLowerCase();
      if (s) topic_keys.push(s);
    }
  }

  const inferText = [title, description, category, keywords].filter(Boolean).join(' ');
  const inferred = inferSupplementAttributes(inferText);

  return {
    merchant_id: merchantId,
    source_network: 'admitad',
    source_product_id: String(id),
    gtin,
    sku: pick(item, 'sku', 'merchant_product_id'),
    title,
    description,
    brand,
    category,
    topic_keys: topic_keys.slice(0, 20),
    price_cents: priceCents,
    currency,
    compare_at_price_cents: compareCents,
    images,
    affiliate_url: resolveAffiliateUrl(item, cfg),
    availability: parseAvailability(item),
    origin_country: cfg.merchant_country,
    health_goals: inferred.health_goals,
    dietary_tags: inferred.dietary_tags,
    ingredients_primary: inferred.ingredients_primary,
    form: inferred.form,
    certifications: inferred.certifications,
    raw: item as Record<string, unknown>,
  };
}

// ==================== Per-campaign sync ====================

interface CampaignStats {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  fetched: number;
  error_sample: unknown[];
}

const EMPTY_STATS = (): CampaignStats => ({
  inserted: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
  fetched: 0,
  error_sample: [],
});

async function fetchAllForCampaign(
  token: string,
  campaignId: string | undefined,
  pageSize: number,
  maxProducts: number
): Promise<AdmitadProductItem[]> {
  const out: AdmitadProductItem[] = [];
  let offset = 0;
  // Hard page ceiling as a runaway guard independent of _meta correctness.
  for (let page = 0; page < 100 && out.length < maxProducts; page++) {
    const limit = Math.min(pageSize, maxProducts - out.length);
    const data = await fetchProductsPage(token, campaignId, limit, offset);
    const items = data.results ?? [];
    if (items.length === 0) break;
    out.push(...items);
    offset += items.length;
    const total = data._meta?.count;
    if (typeof total === 'number' && offset >= total) break;
    if (items.length < limit) break;
  }
  return out.slice(0, maxProducts);
}

async function syncOneCampaign(
  token: string,
  cfg: AdmitadSourceConfig,
  campaignId: string | undefined,
  pageSize: number,
  maxProducts: number
): Promise<CampaignStats> {
  const stats = EMPTY_STATS();
  const merchantSourceId = campaignId ?? 'admitad-all';
  const merchantId = await upsertMerchant({
    source_network: 'admitad',
    source_merchant_id: merchantSourceId,
    name: campaignId ? `Admitad Campaign ${campaignId}` : 'Admitad (all connected)',
    affiliate_network: 'admitad',
    merchant_country: cfg.merchant_country,
    quality_score: 65,
    customs_risk: 'unknown',
  });
  if (!merchantId) {
    stats.errors = 1;
    stats.error_sample.push({ campaign: merchantSourceId, error: 'merchant upsert failed' });
    return stats;
  }

  let items: AdmitadProductItem[];
  try {
    items = await fetchAllForCampaign(token, campaignId, pageSize, maxProducts);
  } catch (err: unknown) {
    stats.errors = 1;
    stats.error_sample.push({ campaign: merchantSourceId, error: err instanceof Error ? err.message : String(err) });
    return stats;
  }
  stats.fetched = items.length;

  // Log the first item's keys + a redacted sample so the defensive field
  // mapping can be confirmed on the first real (activation) sync.
  if (items.length > 0) {
    console.log(
      `[admitad-sync] campaign=${merchantSourceId} fetched=${items.length} sample_keys=` +
        JSON.stringify(Object.keys(items[0]).slice(0, 40))
    );
  }

  const normalized = items
    .map((i) => normalizeAdmitadItem(i, cfg, merchantId))
    .filter((p): p is ProductUpsert => p !== null);

  if (normalized.length === 0) return stats;

  const r = await upsertProducts(normalized, 'admitad');
  stats.inserted = r.inserted;
  stats.updated = r.updated;
  stats.skipped = r.skipped_unchanged;
  stats.errors += r.errors.length;
  if (r.errors.length) stats.error_sample.push(...r.errors.slice(0, 5));
  return stats;
}

// ==================== Entry point ====================

export interface AdmitadSyncResult {
  ok: boolean;
  totals: { inserted: number; updated: number; skipped: number; errors: number; fetched: number };
  campaigns_synced: number;
  duration_ms: number;
  per_campaign: Array<{ campaign: string; inserted: number; updated: number; skipped: number; errors: number; fetched: number }>;
  error?: string;
}

export async function runAdmitadSync(triggered_by = 'scheduler'): Promise<AdmitadSyncResult> {
  const startTime = Date.now();
  const configs = await loadSourceConfigs();
  if (configs.length === 0) {
    console.log('[admitad-sync] no active config — skipping');
    return {
      ok: true,
      totals: { inserted: 0, updated: 0, skipped: 0, errors: 0, fetched: 0 },
      campaigns_synced: 0,
      per_campaign: [],
      duration_ms: Date.now() - startTime,
    };
  }

  const totals = { inserted: 0, updated: 0, skipped: 0, errors: 0, fetched: 0 };
  const per_campaign: AdmitadSyncResult['per_campaign'] = [];
  const errorSample: unknown[] = [];
  let campaignCount = 0;
  let fatalError: string | undefined;

  for (const cfg of configs) {
    const pageSize = Math.min(Math.max(cfg.page_size ?? 200, 1), 500);
    const maxProducts = Math.min(Math.max(cfg.max_products ?? 1000, 1), 50000);
    // Empty/absent campaign_ids → one pass over the whole connected catalog.
    const campaigns: Array<string | undefined> =
      Array.isArray(cfg.campaign_ids) && cfg.campaign_ids.length > 0 ? cfg.campaign_ids : [undefined];

    let token: string;
    try {
      token = await fetchAccessToken(cfg);
    } catch (err: unknown) {
      fatalError = err instanceof Error ? err.message : String(err);
      totals.errors += 1;
      errorSample.push({ error: fatalError });
      continue;
    }

    const run = await startSyncRun('admitad', triggered_by);
    for (const campaignId of campaigns) {
      campaignCount++;
      const stats = await syncOneCampaign(token, cfg, campaignId, pageSize, maxProducts);
      per_campaign.push({
        campaign: campaignId ?? 'all',
        inserted: stats.inserted,
        updated: stats.updated,
        skipped: stats.skipped,
        errors: stats.errors,
        fetched: stats.fetched,
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
    `[admitad-sync] done in ${duration_ms}ms — fetched ${totals.fetched}, ` +
      `${totals.inserted}+ ${totals.updated}~ ${totals.skipped}= ${totals.errors}! across ${campaignCount} campaigns`
  );

  return {
    ok: totals.errors === 0,
    totals,
    campaigns_synced: campaignCount,
    per_campaign,
    duration_ms,
    error: fatalError,
  };
}
