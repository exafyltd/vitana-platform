// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/discover-feed.ts — zero coverage today.
/**
 * routes/discover-feed.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in discover-feed.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 *
 * `buildCandidateProductsFeedQuery` returns only the query-initiating
 * `.from('products').select(...).eq().eq()` builder, `: any` typed, so
 * the source file's conditional filters (category, geo scope, sort,
 * limit) keep mutating it in place exactly as before — the same
 * reasoning already applied to discover-search-repository.ts's
 * buildProductSearchQuery and
 * marketplace-analyzer-repository.ts's buildCandidateProductsQuery.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchDefaultFeedConfig(
  sb: SupabaseClient,
  args: { regionGroup: string; lifecycleStage: string },
) {
  return sb
    .from('default_feed_config')
    .select(
      'id, tenant_id, region_group, lifecycle_stage, featured_product_ids, category_mix, max_products_per_merchant, max_products_per_category, starter_conditions, personalization_weight_override, diversity_rules, notes'
    )
    .in('region_group', [args.regionGroup, 'GLOBAL'])
    .eq('lifecycle_stage', args.lifecycleStage)
    .eq('is_active', true);
}

export function buildCandidateProductsFeedQuery(sb: SupabaseClient, selectColumns: string): any {
  return sb.from('products').select(selectColumns).eq('is_active', true).eq('availability', 'in_stock');
}
