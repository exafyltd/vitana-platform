// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references services/marketplace-sync/shopify-sync.ts —
// zero coverage today (test/routes/shopify-sync.test.ts covers the
// unrelated services/shopify-sync.ts).
/**
 * services/marketplace-sync/shopify-sync.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in shopify-sync.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * query, same columns, same filters, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveMarketplaceSourceConfigs(sb: SupabaseClient, sourceNetwork: string) {
  return sb
    .from('marketplace_sources_config')
    .select('config')
    .eq('source_network', sourceNetwork)
    .eq('is_active', true);
}
