// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/marketplace.ts — zero coverage
// today.
/**
 * services/admin-scanners/marketplace.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countProductsPendingAdminReview(sb: SupabaseClient) {
  return sb.from('products').select('id', { count: 'exact', head: true }).eq('requires_admin_review', true).eq('is_active', true);
}

export async function fetchRecentFailedCatalogSourceRuns(sb: SupabaseClient, since: string) {
  return sb
    .from('catalog_sources')
    .select('id, source_network, started_at, errors, products_inserted, products_updated, error_sample')
    .gte('started_at', since)
    .gt('errors', 0)
    .order('started_at', { ascending: false })
    .limit(20);
}

export async function countActiveProducts(sb: SupabaseClient) {
  return sb.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true);
}

export async function countStaleActiveProducts(sb: SupabaseClient, olderThan: string) {
  return sb.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true).lt('last_seen_at', olderThan);
}

export async function countUnmatchedTenantOrders(sb: SupabaseClient, tenantId: string) {
  return sb.from('product_orders').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('state', 'unmatched');
}
