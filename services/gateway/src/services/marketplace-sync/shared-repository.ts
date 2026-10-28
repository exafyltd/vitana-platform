// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references marketplace-sync/shared.ts — zero coverage
// today.
/**
 * services/marketplace-sync/shared.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in marketplace-sync/shared.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertCatalogSourceRun(sb: SupabaseClient, sourceNetwork: string, triggeredBy: string) {
  return sb
    .from('catalog_sources')
    .insert({ source_network: sourceNetwork, triggered_by: triggeredBy })
    .select('run_id, started_at, source_network, triggered_by')
    .single();
}

export async function updateCatalogSourceRunStats(
  sb: SupabaseClient,
  runId: string,
  patch: {
    finished_at: string;
    products_inserted: number;
    products_updated: number;
    products_skipped: number;
    errors: number;
    error_sample: unknown[] | null;
  },
) {
  return sb.from('catalog_sources').update(patch).eq('run_id', runId);
}

export async function upsertMerchantRow(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('merchants').upsert(row, { onConflict: 'source_network,source_merchant_id' }).select('id').single();
}

export async function fetchExistingProductHashes(sb: SupabaseClient, sourceNetwork: string, sourceProductIds: string[]) {
  return sb
    .from('products')
    .select('source_product_id, content_hash')
    .eq('source_network', sourceNetwork)
    .in('source_product_id', sourceProductIds);
}

export async function upsertProductRows(sb: SupabaseClient, rows: Array<Record<string, unknown>>) {
  return sb.from('products').upsert(rows, { onConflict: 'source_network,source_product_id' }).select('source_product_id');
}
