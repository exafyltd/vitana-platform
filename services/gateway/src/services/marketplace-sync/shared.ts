/**
 * VTID-02200: Marketplace sync shared helpers — DB upsert + run tracking.
 *
 * Each sync (Shopify, CJ, Amazon, ...) uses these to stamp provenance and
 * write normalized rows. Runs bypass the HTTP /api/v1/catalog/ingest API
 * since we're in the same process — direct Supabase service-role writes.
 */

import { createHash } from 'crypto';
import { getSupabase } from '../../lib/supabase';

export interface SyncRunHandle {
  run_id: string;
  source_network: string;
  started_at: string;
  triggered_by: string;
}

export async function startSyncRun(
  source_network: string,
  triggered_by = 'scheduler'
): Promise<SyncRunHandle | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('catalog_sources')
    .insert({ source_network, triggered_by })
    .select('run_id, started_at, source_network, triggered_by')
    .single();
  if (error || !data) {
    console.error('[marketplace-sync] failed to start run:', error?.message);
    return null;
  }
  return {
    run_id: data.run_id,
    source_network: data.source_network,
    started_at: data.started_at,
    triggered_by: data.triggered_by,
  };
}

export async function finishSyncRun(
  handle: SyncRunHandle,
  stats: { inserted: number; updated: number; skipped: number; errors: number; error_sample?: unknown[] }
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase
    .from('catalog_sources')
    .update({
      finished_at: new Date().toISOString(),
      products_inserted: stats.inserted,
      products_updated: stats.updated,
      products_skipped: stats.skipped,
      errors: stats.errors,
      error_sample: stats.error_sample ? stats.error_sample.slice(0, 10) : null,
    })
    .eq('run_id', handle.run_id);
}

// ==================== Merchant upsert ====================

export interface MerchantUpsert {
  source_network: string;
  source_merchant_id: string;
  name: string;
  slug?: string;
  storefront_url?: string;
  merchant_country?: string;
  ships_to_countries?: string[];
  ships_to_regions?: string[];
  currencies?: string[];
  affiliate_network?: string;
  commission_rate?: number;
  quality_score?: number;
  customs_risk?: 'low' | 'medium' | 'high' | 'unknown';
}

export async function upsertMerchant(m: MerchantUpsert): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('merchants')
    .upsert(
      {
        source_network: m.source_network,
        source_merchant_id: m.source_merchant_id,
        name: m.name,
        slug: m.slug ?? null,
        storefront_url: m.storefront_url ?? null,
        merchant_country: m.merchant_country ?? null,
        ships_to_countries: m.ships_to_countries ?? null,
        ships_to_regions: m.ships_to_regions ?? null,
        currencies: m.currencies ?? [],
        affiliate_network: m.affiliate_network ?? null,
        commission_rate: m.commission_rate ?? null,
        quality_score: m.quality_score ?? 50,
        customs_risk: m.customs_risk ?? null,
        is_active: true,
      },
      { onConflict: 'source_network,source_merchant_id' }
    )
    .select('id')
    .single();
  if (error || !data) {
    console.error('[marketplace-sync] merchant upsert failed:', error?.message);
    return null;
  }
  return data.id;
}

// ==================== Product upsert ====================

export interface ProductUpsert {
  merchant_id: string;
  source_network: string;
  source_product_id: string;
  gtin?: string;
  sku?: string;
  asin?: string;
  title: string;
  description?: string;
  /** Multi-paragraph readable version of description (for the product-detail drawer). */
  description_long?: string;
  brand?: string;
  category?: string;
  subcategory?: string;
  topic_keys?: string[];
  price_cents: number;
  currency: string;
  compare_at_price_cents?: number;
  images?: string[];
  affiliate_url: string;
  availability?: 'in_stock' | 'out_of_stock' | 'preorder' | 'discontinued' | 'unknown';
  rating?: number;
  review_count?: number;
  origin_country?: string;
  ships_to_countries?: string[];
  ships_to_regions?: string[];
  health_goals?: string[];
  dietary_tags?: string[];
  form?: string;
  certifications?: string[];
  ingredients_primary?: string[];
  contains_allergens?: string[];
  raw?: Record<string, unknown>;
}

export function computeProductContentHash(p: ProductUpsert): string {
  const canonical = {
    title: p.title ?? '',
    description: p.description ?? '',
    description_long: p.description_long ?? '',
    brand: p.brand ?? '',
    price_cents: p.price_cents,
    currency: p.currency,
    availability: p.availability ?? 'in_stock',
    origin_country: p.origin_country ?? '',
    ships_to_countries: [...(p.ships_to_countries ?? [])].sort(),
    ships_to_regions: [...(p.ships_to_regions ?? [])].sort(),
    affiliate_url: p.affiliate_url,
    health_goals: [...(p.health_goals ?? [])].sort(),
    dietary_tags: [...(p.dietary_tags ?? [])].sort(),
    ingredients_primary: [...(p.ingredients_primary ?? [])].sort(),
    images_count: (p.images ?? []).length,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface UpsertProductsResult {
  inserted: number;
  updated: number;
  skipped_unchanged: number;
  errors: Array<{ source_product_id: string; error: string }>;
}

export async function upsertProducts(
  products: ProductUpsert[],
  source_network: string
): Promise<UpsertProductsResult> {
  const supabase = getSupabase();
  const result: UpsertProductsResult = {
    inserted: 0,
    updated: 0,
    skipped_unchanged: 0,
    errors: [],
  };
  if (!supabase || products.length === 0) return result;

  // Look up existing rows to detect insert vs update vs unchanged
  const { data: existing } = await supabase
    .from('products')
    .select('source_product_id, content_hash')
    .eq('source_network', source_network)
    .in(
      'source_product_id',
      products.map((p) => p.source_product_id)
    );
  const existingMap = new Map((existing ?? []).map((e) => [e.source_product_id, e.content_hash]));

  const now = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];

  for (const p of products) {
    const content_hash = computeProductContentHash(p);
    const prevHash = existingMap.get(p.source_product_id);

    if (prevHash === content_hash) {
      result.skipped_unchanged++;
      // Bump last_seen_at so stale-detection doesn't accidentally retire the row
      rows.push({
        source_network,
        source_product_id: p.source_product_id,
        merchant_id: p.merchant_id,
        title: p.title,
        affiliate_url: p.affiliate_url,
        price_cents: p.price_cents,
        currency: p.currency,
        origin_country: p.origin_country ?? null,
        last_seen_at: now,
        content_hash,
      });
      continue;
    }

    rows.push({
      merchant_id: p.merchant_id,
      source_network,
      source_product_id: p.source_product_id,
      gtin: p.gtin ?? null,
      sku: p.sku ?? null,
      asin: p.asin ?? null,
      title: p.title,
      description: p.description ?? null,
      description_long: p.description_long ?? null,
      brand: p.brand ?? null,
      category: p.category ?? null,
      subcategory: p.subcategory ?? null,
      topic_keys: p.topic_keys ?? [],
      price_cents: p.price_cents,
      currency: p.currency,
      compare_at_price_cents: p.compare_at_price_cents ?? null,
      images: p.images ?? [],
      affiliate_url: p.affiliate_url,
      availability: p.availability ?? 'in_stock',
      rating: p.rating ?? null,
      review_count: p.review_count ?? null,
      origin_country: p.origin_country ?? null,
      ships_to_countries: p.ships_to_countries ?? null,
      ships_to_regions: p.ships_to_regions ?? null,
      health_goals: p.health_goals ?? [],
      dietary_tags: p.dietary_tags ?? [],
      form: p.form ?? null,
      certifications: p.certifications ?? [],
      ingredients_primary: p.ingredients_primary ?? [],
      contains_allergens: p.contains_allergens ?? [],
      raw: p.raw ?? null,
      content_hash,
      ingested_at: prevHash ? undefined : now,
      last_seen_at: now,
      is_active: true,
    });
  }

  const { data: upserted, error } = await supabase
    .from('products')
    .upsert(rows, { onConflict: 'source_network,source_product_id' })
    .select('source_product_id');

  if (error) {
    result.errors.push({ source_product_id: '(batch)', error: error.message });
    return result;
  }

  // Classify each returned row as insert vs update based on whether we had an existing hash
  for (const u of upserted ?? []) {
    if (existingMap.has(u.source_product_id)) {
      // Already counted as skipped_unchanged above OR it's an update
      const stillUnchanged = rows.find(
        (r) => r.source_product_id === u.source_product_id && r.content_hash === existingMap.get(u.source_product_id)
      );
      if (!stillUnchanged) result.updated++;
    } else {
      result.inserted++;
    }
  }
  return result;
}

// ==================== Region derivation (client-side fallback) ====================

export function deriveRegionGroup(country_code: string | undefined | null): string {
  if (!country_code) return 'OTHER';
  const c = country_code.toUpperCase();
  const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'NO', 'IS', 'CH', 'LI'];
  if (EU.includes(c)) return 'EU';
  if (c === 'GB' || c === 'UK') return 'UK';
  if (c === 'US') return 'US';
  if (c === 'CA') return 'CA';
  if (c === 'CN' || c === 'HK' || c === 'MO') return 'APAC_CN';
  if (['JP', 'KR', 'TW'].includes(c)) return 'APAC_JP_KR_TW';
  return 'OTHER';
}
