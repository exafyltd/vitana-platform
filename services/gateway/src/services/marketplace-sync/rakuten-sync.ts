/**
 * VTID-01938: Rakuten Advertising (LinkShare) Product Search sync.
 *
 * https://developers.rakutenadvertising.com/ — Product Search API v1.
 * Complements CJ with a different advertiser mix (~1000 advertisers,
 * Europe-stronger than CJ).
 *
 * Auth: bearer token issued to the publisher account. Unlike CJ, the
 * token is tied to the whole publisher account (not an advertiser) and
 * can be rotated from the Rakuten dashboard.
 *
 * Config shape (JSON in marketplace_sources_config.config):
 *   {
 *     "bearer_token": "...",
 *     "keywords": "supplement,vitamin,probiotic",
 *     "advertiser_ids": ["12345","67890"],     // optional, filter to these
 *     "merchant_country": "US",                 // fallback when feed lacks it
 *     "max_pages": 10
 *   }
 *
 * One source row per publisher account (there is usually only one).
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

interface RakutenSourceConfig {
  bearer_token: string;
  keywords?: string;
  advertiser_ids?: string[] | string;
  merchant_country?: string;
  max_pages?: number;
}

async function loadSourceConfigs(): Promise<RakutenSourceConfig[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from('marketplace_sources_config')
    .select('config')
    .eq('source_network', 'rakuten')
    .eq('is_active', true);
  if (!data?.length) return [];
  return data.map((r) => r.config as RakutenSourceConfig).filter((c) => c && c.bearer_token);
}

// ==================== API ====================

interface RakutenProductRaw {
  mid?: string;
  merchantname?: string;
  linkid?: string;
  createdon?: string;
  sku?: string;
  productname?: string;
  category?: { primary?: string; secondary?: string };
  price?: { '#text'?: string; '-currency'?: string } | string;
  saleprice?: { '#text'?: string; '-currency'?: string } | string;
  upccode?: string;
  description?: { short?: string; long?: string };
  keywords?: string;
  linkurl?: string;
  imageurl?: string;
}

interface RakutenResp {
  result?: {
    TotalMatches?: string;
    TotalPages?: string;
    PageNumber?: string;
    item?: RakutenProductRaw[] | RakutenProductRaw;
  };
}

async function fetchRakutenPage(
  token: string,
  opts: { keyword?: string; mids?: string; pageNumber: number; max?: number }
): Promise<RakutenProductRaw[]> {
  const qs = new URLSearchParams({
    max: String(opts.max ?? 100),
    pagenumber: String(opts.pageNumber),
  });
  if (opts.keyword) qs.set('keyword', opts.keyword);
  if (opts.mids) qs.set('mid', opts.mids);

  const url = `https://api.linksynergy.com/productsearch/1.0?${qs.toString()}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`Rakuten ${resp.status} ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as RakutenResp;
  const items = data.result?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

// ==================== Normalization ====================

function extractPriceCents(
  field: { '#text'?: string; '-currency'?: string } | string | undefined
): { cents: number | null; currency: string } {
  if (!field) return { cents: null, currency: 'USD' };
  if (typeof field === 'string') {
    const n = parseFloat(field.replace(/[^0-9.]/g, ''));
    return { cents: Number.isNaN(n) ? null : Math.round(n * 100), currency: 'USD' };
  }
  const raw = field['#text'];
  const currency = (field['-currency'] ?? 'USD').toUpperCase();
  if (!raw) return { cents: null, currency };
  const n = parseFloat(raw);
  return { cents: Number.isNaN(n) ? null : Math.round(n * 100), currency };
}

function normalizeRakutenProduct(
  raw: RakutenProductRaw,
  merchantMap: Map<string, string>
): ProductUpsert | null {
  const productId = raw.linkid ?? raw.sku;
  if (!productId) return null;
  const mid = raw.mid;
  if (!mid) return null;
  const merchantId = merchantMap.get(mid);
  if (!merchantId) return null;

  const sale = extractPriceCents(raw.saleprice);
  const list = extractPriceCents(raw.price);
  const priceCents = sale.cents ?? list.cents;
  if (priceCents === null) return null;
  const currency = (sale.cents !== null ? sale.currency : list.currency) ?? 'USD';
  const compareCents = sale.cents !== null && list.cents !== null && list.cents > sale.cents ? list.cents : undefined;

  const shortDesc = raw.description?.short;
  const longDesc = raw.description?.long;

  const inferText = [raw.productname, shortDesc, longDesc, raw.keywords, raw.category?.primary, raw.category?.secondary]
    .filter(Boolean).join(' ');
  const inferred = inferSupplementAttributes(inferText);

  const topic_keys: string[] = [];
  if (raw.keywords) {
    for (const k of raw.keywords.split(/[,;]/)) {
      const s = k.trim().toLowerCase();
      if (s) topic_keys.push(s);
    }
  }

  return {
    merchant_id: merchantId,
    source_network: 'rakuten',
    source_product_id: String(productId),
    gtin: raw.upccode,
    sku: raw.sku,
    title: raw.productname ?? 'Untitled product',
    description: shortDesc,
    description_long: longDesc ?? shortDesc,
    category: raw.category?.primary,
    subcategory: raw.category?.secondary,
    topic_keys: topic_keys.slice(0, 20),
    price_cents: priceCents,
    currency,
    compare_at_price_cents: compareCents,
    images: raw.imageurl ? [raw.imageurl] : [],
    affiliate_url: raw.linkurl ?? '',
    availability: 'in_stock', // Rakuten's search doesn't expose availability — assume in_stock
    health_goals: inferred.health_goals,
    dietary_tags: inferred.dietary_tags,
    ingredients_primary: inferred.ingredients_primary,
    form: inferred.form,
    certifications: inferred.certifications,
    raw: raw as unknown as Record<string, unknown>,
  };
}

async function ensureMerchants(items: RakutenProductRaw[], country?: string): Promise<Map<string, string>> {
  const byMid = new Map<string, { name: string }>();
  for (const i of items) {
    if (!i.mid) continue;
    if (byMid.has(i.mid)) continue;
    byMid.set(i.mid, { name: i.merchantname ?? `Rakuten Merchant ${i.mid}` });
  }
  const out = new Map<string, string>();
  for (const [mid, info] of byMid) {
    const id = await upsertMerchant({
      source_network: 'rakuten',
      source_merchant_id: mid,
      name: info.name,
      affiliate_network: 'rakuten',
      merchant_country: country,
      quality_score: 65,
      customs_risk: 'unknown',
    });
    if (id) out.set(mid, id);
  }
  return out;
}

// ==================== Entry point ====================

export interface RakutenSyncResult {
  ok: boolean;
  totals: { inserted: number; updated: number; skipped: number; errors: number; fetched: number };
  pages_fetched: number;
  advertisers_seen: number;
  duration_ms: number;
  error?: string;
}

export async function runRakutenSync(triggered_by = 'scheduler'): Promise<RakutenSyncResult> {
  const startTime = Date.now();
  const configs = await loadSourceConfigs();
  if (configs.length === 0) {
    console.log('[rakuten-sync] no publishers configured — skipping');
    return {
      ok: true,
      totals: { inserted: 0, updated: 0, skipped: 0, errors: 0, fetched: 0 },
      pages_fetched: 0,
      advertisers_seen: 0,
      duration_ms: Date.now() - startTime,
    };
  }

  const totals = { inserted: 0, updated: 0, skipped: 0, errors: 0, fetched: 0 };
  const errorSample: unknown[] = [];
  const advertisersSeen = new Set<string>();
  let totalPages = 0;

  for (const cfg of configs) {
    const run = await startSyncRun('rakuten', triggered_by);
    const keywords = (cfg.keywords ?? 'supplement,vitamin')
      .split(',').map((k) => k.trim()).filter(Boolean);
    const mids = Array.isArray(cfg.advertiser_ids)
      ? cfg.advertiser_ids.join('|')
      : (typeof cfg.advertiser_ids === 'string' ? cfg.advertiser_ids : undefined);
    const maxPages = Math.max(1, Math.min(cfg.max_pages ?? 10, 20));

    for (const kw of keywords) {
      for (let page = 1; page <= maxPages; page++) {
        let items: RakutenProductRaw[];
        try {
          items = await fetchRakutenPage(cfg.bearer_token, { keyword: kw, mids, pageNumber: page, max: 100 });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          totals.errors++;
          errorSample.push({ keyword: kw, page, error: message });
          break;
        }
        totalPages++;
        totals.fetched += items.length;
        if (items.length === 0) break;

        const merchantMap = await ensureMerchants(items, cfg.merchant_country);
        for (const mid of merchantMap.keys()) advertisersSeen.add(mid);

        const normalized = items
          .map((r) => normalizeRakutenProduct(r, merchantMap))
          .filter((p): p is ProductUpsert => p !== null);
        if (normalized.length === 0) continue;

        const r = await upsertProducts(normalized, 'rakuten');
        totals.inserted += r.inserted;
        totals.updated += r.updated;
        totals.skipped += r.skipped_unchanged;
        if (r.errors.length) {
          totals.errors += r.errors.length;
          errorSample.push(...r.errors.slice(0, 3));
        }

        if (items.length < 100) break; // last page for this keyword
      }
    }

    if (run) await finishSyncRun(run, { ...totals, error_sample: errorSample.slice(0, 10) });
  }

  const duration_ms = Date.now() - startTime;
  console.log(
    `[rakuten-sync] done in ${duration_ms}ms — fetched ${totals.fetched}, ` +
    `${totals.inserted}+ ${totals.updated}~ ${totals.skipped}= ${totals.errors}! across ${advertisersSeen.size} advertisers`
  );

  return {
    ok: totals.errors === 0,
    totals,
    pages_fetched: totalPages,
    advertisers_seen: advertisersSeen.size,
    duration_ms,
  };
}
