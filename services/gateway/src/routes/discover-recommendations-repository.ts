// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// routes/discover-recommendations.ts's existing test suite
// (test/routes/discover-recommendations.test.ts), which covers every call
// site here.
/**
 * routes/discover-recommendations.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/discover-recommendations.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== products ====================

export async function fetchActiveProductForRecommendation(sb: SupabaseClient, productId: string) {
  return sb.from('products').select('id, merchant_id, title, is_active').eq('id', productId).eq('is_active', true).maybeSingle();
}

// ==================== product_recommendations ====================

export async function fetchExistingRecommendation(sb: SupabaseClient, userId: string, productId: string) {
  return sb.from('product_recommendations').select('id, sharing_link_id').eq('user_id', userId).eq('product_id', productId).maybeSingle();
}

export async function insertProductRecommendation(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('product_recommendations').insert(row).select('id').single();
}

export async function fetchMyRecommendations(sb: SupabaseClient, userId: string) {
  return sb
    .from('product_recommendations')
    .select('id, product_id, status, click_count, conversion_count, commission_earned_minor, commission_currency, created_at, products(title, images)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
}

// ==================== sharing_links ====================

export async function insertSharingLink(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('sharing_links').insert(row).select('id').single();
}
