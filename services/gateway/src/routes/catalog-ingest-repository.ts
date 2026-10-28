// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/catalog-ingest.ts — zero coverage today.
/**
 * routes/catalog-ingest.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertCatalogSourceRun(
  sb: SupabaseClient,
  row: { source_network: string; source_url: string | null; triggered_by: string; notes: string | null },
) {
  return sb.from('catalog_sources').insert(row).select('run_id, started_at').single();
}

/** Reused by both /merchants and /products for the run-still-open guard. */
export async function fetchRunStatus(sb: SupabaseClient, runId: string) {
  return sb.from('catalog_sources').select('run_id, finished_at').eq('run_id', runId).maybeSingle();
}

export async function fetchMerchantsExisting(sb: SupabaseClient, sourceNetwork: string, sourceMerchantIds: string[]) {
  return sb.from('merchants').select('source_network, source_merchant_id').eq('source_network', sourceNetwork).in('source_merchant_id', sourceMerchantIds);
}

export async function upsertMerchants(sb: SupabaseClient, rows: Record<string, unknown>[]) {
  return sb.from('merchants').upsert(rows, { onConflict: 'source_network,source_merchant_id' }).select('id, source_merchant_id');
}

/** Reused by both the real /products ingest and the /dry-run merchant-resolution check. */
export async function fetchMerchantIdsBySourceIds(sb: SupabaseClient, sourceNetwork: string, sourceMerchantIds: string[]) {
  return sb.from('merchants').select('id, source_merchant_id').eq('source_network', sourceNetwork).in('source_merchant_id', sourceMerchantIds);
}

export async function fetchExistingProductsWithHash(sb: SupabaseClient, sourceNetwork: string, sourceProductIds: string[]) {
  return sb.from('products').select('id, source_product_id, content_hash').eq('source_network', sourceNetwork).in('source_product_id', sourceProductIds);
}

export async function upsertProducts(sb: SupabaseClient, rows: Record<string, unknown>[]) {
  return sb.from('products').upsert(rows, { onConflict: 'source_network,source_product_id' }).select('source_product_id');
}

export function updateRunProductStats(
  sb: SupabaseClient,
  runId: string,
  stats: { products_inserted: number; products_updated: number; products_skipped: number; errors: number; error_sample: unknown[] },
): PromiseLike<{ error: unknown }> {
  return sb.from('catalog_sources').update(stats).eq('run_id', runId);
}

export async function fetchRunForFinish(sb: SupabaseClient, runId: string) {
  return sb
    .from('catalog_sources')
    .select('run_id, source_network, started_at, finished_at, products_inserted, products_updated, products_skipped, errors')
    .eq('run_id', runId)
    .maybeSingle();
}

export async function deactivateStaleProducts(sb: SupabaseClient, sourceNetwork: string, staleThreshold: string) {
  return sb.from('products').update({ is_active: false }).eq('source_network', sourceNetwork).eq('is_active', true).lt('last_seen_at', staleThreshold).select('id');
}

export function markRunFinished(sb: SupabaseClient, runId: string, finishedAt: string): PromiseLike<{ error: unknown }> {
  return sb.from('catalog_sources').update({ finished_at: finishedAt }).eq('run_id', runId);
}

export async function fetchExistingProductHashesOnly(sb: SupabaseClient, sourceNetwork: string, sourceProductIds: string[]) {
  return sb.from('products').select('source_product_id, content_hash').eq('source_network', sourceNetwork).in('source_product_id', sourceProductIds);
}

export async function checkCatalogSourcesReachable(sb: SupabaseClient) {
  return sb.from('catalog_sources').select('run_id').limit(1);
}
