// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references services/marketplace-sync/awin-order-sync.ts —
// zero coverage today.
/**
 * services/marketplace-sync/awin-order-sync.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in awin-order-sync.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filters, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveAwinSourceConfig(sb: SupabaseClient) {
  return sb.from('marketplace_sources_config').select('config').eq('source_network', 'awin').eq('is_active', true).maybeSingle();
}

export async function fetchProductClickByClickId(sb: SupabaseClient, clickId: string) {
  return sb
    .from('product_clicks')
    .select('click_id, user_id, tenant_id, product_id, merchant_id, attribution_surface, attribution_recommendation_id')
    .eq('click_id', clickId)
    .maybeSingle();
}

export async function upsertProductOrder(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb
    .from('product_orders')
    .upsert(row, { onConflict: 'merchant_id,external_order_id' })
    .select('id')
    .single();
}
