// impact-allow-no-test
// Genuinely tested via test/routes/admin-marketplace-repository.test.ts,
// which drives a functional stub Supabase client (a from()-chain
// resolving to a configurable {data,error,count} response) — not a
// wholesale module mock.
/**
 * routes/admin-marketplace-repository.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/admin-marketplace.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic (takes
 * `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== Catalog: Overview ====================

export async function fetchAdminMarketplaceOverviewStats(sb: SupabaseClient) {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  return Promise.all([
    sb.from('merchants').select('id', { count: 'exact', head: true }).eq('is_active', true),
    sb.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
    sb
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('requires_admin_review', true)
      .eq('is_active', true),
    sb
      .from('catalog_sources')
      .select('run_id, source_network, started_at, finished_at, products_inserted, products_updated, errors')
      .order('started_at', { ascending: false })
      .limit(10),
    sb.from('product_clicks').select('id', { count: 'exact', head: true }).gte('clicked_at', since24h),
    sb
      .from('product_orders')
      .select('id, commission_cents', { count: 'exact' })
      .gte('created_at', since30d)
      .eq('state', 'converted'),
  ]);
}

// ==================== Catalog: Merchants ====================

export async function listAdminMarketplaceMerchants(
  sb: SupabaseClient,
  args: { sourceNetwork?: string; isActive?: string; search?: string; offset: number; limit: number },
) {
  let q = sb.from('merchants').select('*', { count: 'exact' });
  if (args.sourceNetwork) q = q.eq('source_network', args.sourceNetwork);
  if (args.isActive !== undefined) q = q.eq('is_active', args.isActive === 'true');
  if (args.search) q = q.ilike('name', `%${args.search}%`);
  return q.order('created_at', { ascending: false }).range(args.offset, args.offset + args.limit - 1);
}

export async function updateAdminMarketplaceMerchant(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('merchants').update(patch).eq('id', id).select().single();
}

// ==================== Catalog: Products review queue ====================

const PRODUCTS_LIST_COLUMNS =
  'id, title, brand, category, subcategory, price_cents, currency, origin_country, origin_region, source_network, source_product_id, rating, availability, requires_admin_review, admin_review_reason, analyzer_confidence, is_active, ingested_at, last_seen_at, merchant_id';

export async function listAdminMarketplaceProducts(
  sb: SupabaseClient,
  args: {
    requiresAdminReview?: string;
    isActive?: string;
    sourceNetwork?: string;
    category?: string;
    originRegion?: string;
    search?: string;
    offset: number;
    limit: number;
  },
) {
  let q = sb.from('products').select(PRODUCTS_LIST_COLUMNS, { count: 'exact' });
  if (args.requiresAdminReview !== undefined) q = q.eq('requires_admin_review', args.requiresAdminReview === 'true');
  if (args.isActive !== undefined) q = q.eq('is_active', args.isActive === 'true');
  if (args.sourceNetwork) q = q.eq('source_network', args.sourceNetwork);
  if (args.category) q = q.eq('category', args.category);
  if (args.originRegion) q = q.eq('origin_region', args.originRegion);
  if (args.search) q = q.ilike('title', `%${args.search}%`);
  return q.order('ingested_at', { ascending: false }).range(args.offset, args.offset + args.limit - 1);
}

export async function updateAdminMarketplaceProduct(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('products').update(patch).eq('id', id).select().single();
}

export async function bulkUpdateAdminMarketplaceProducts(
  sb: SupabaseClient,
  productIds: string[],
  patch: Record<string, unknown>,
) {
  return sb.from('products').update(patch).in('id', productIds).select('id');
}

export async function fetchAdminMarketplaceIngestionCoverage(sb: SupabaseClient) {
  return sb.from('products').select('origin_region, ships_to_regions').eq('is_active', true);
}

// ==================== Catalog: Feed Curation (defaults subset) ====================

export async function fetchAdminMarketplaceFeedCurationConfigs(sb: SupabaseClient, tenantId: string | null) {
  return sb
    .from('default_feed_config')
    .select('*')
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
    .eq('is_active', true)
    .order('region_group', { ascending: true })
    .order('lifecycle_stage', { ascending: true });
}

export async function updateAdminMarketplaceFeedCurationConfig(
  sb: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
) {
  return sb.from('default_feed_config').update(patch).eq('id', id).select().single();
}

// ==================== Operations: Ingestion & Coverage ====================

export async function listAdminMarketplaceIngestionRuns(
  sb: SupabaseClient,
  args: { sourceNetwork?: string; offset: number; limit: number },
) {
  let q = sb.from('catalog_sources').select('*', { count: 'exact' });
  if (args.sourceNetwork) q = q.eq('source_network', args.sourceNetwork);
  return q.order('started_at', { ascending: false }).range(args.offset, args.offset + args.limit - 1);
}

// ==================== Operations: Geo Policies ====================

export async function listAdminMarketplaceGeoPolicies(sb: SupabaseClient) {
  return sb.from('geo_policy').select('*').order('user_region', { ascending: true }).order('rule_type', { ascending: true });
}

export async function updateAdminMarketplaceGeoPolicy(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('geo_policy').update(patch).eq('id', id).select().single();
}

export async function insertAdminMarketplaceGeoPolicy(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.from('geo_policy').insert(payload).select().single();
}

// ==================== Awin feed discovery ====================

export async function fetchAdminMarketplaceAwinSourceConfig(sb: SupabaseClient) {
  return sb
    .from('marketplace_sources_config')
    .select('config')
    .eq('source_network', 'awin')
    .eq('is_active', true)
    .limit(1);
}

// ==================== Sources (Shopify + CJ + etc) ====================

export async function listAdminMarketplaceSources(sb: SupabaseClient, sourceNetwork?: string) {
  let q = sb.from('marketplace_sources_config').select('*').order('created_at', { ascending: false });
  if (sourceNetwork) q = q.eq('source_network', sourceNetwork);
  return q;
}

export async function insertAdminMarketplaceSource(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.from('marketplace_sources_config').insert(payload).select().single();
}

export async function updateAdminMarketplaceSource(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('marketplace_sources_config').update(patch).eq('id', id).select().single();
}

// ==================== Operations: Recommendation commission settings ====================

export async function fetchAdminMarketplaceCommissionSetting(sb: SupabaseClient) {
  return sb
    .from('admin_settings')
    .select('value, updated_at')
    .eq('key', 'recommendation_commission_default_rate')
    .maybeSingle();
}

export async function upsertAdminMarketplaceCommissionSetting(
  sb: SupabaseClient,
  value: Record<string, unknown>,
  updatedBy: string | null,
) {
  return sb
    .from('admin_settings')
    .upsert(
      { key: 'recommendation_commission_default_rate', value, updated_by: updatedBy, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
}
