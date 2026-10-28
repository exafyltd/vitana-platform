// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references services/marketplace-sync/amazon-sync.ts —
// zero coverage today.
/**
 * services/marketplace-sync/amazon-sync.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in amazon-sync.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same filters, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveMarketplaceSourceConfigs(sb: SupabaseClient, sourceNetwork: string) {
  return sb
    .from('marketplace_sources_config')
    .select('config')
    .eq('source_network', sourceNetwork)
    .eq('is_active', true);
}

export async function fetchCuratedAmazonAeProducts(sb: SupabaseClient) {
  return sb
    .from('products')
    .select('id, affiliate_url')
    .eq('source_network', 'amazon')
    .like('source_product_id', 'amazonae-%');
}

export async function updateProductImages(sb: SupabaseClient, productId: string, images: string[], updatedAtIso: string) {
  return sb.from('products').update({ images, updated_at: updatedAtIso }).eq('id', productId);
}
