// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior); exercised indirectly
// by routes/universal-cart.ts's existing test suite (test/universal-cart.test.ts),
// which covers every call site here.
/**
 * routes/universal-cart.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Covers the auxiliary/context call sites in universal-cart.ts that are
 * NOT already routed through services/universal-cart/universal-cart-repository.ts
 * (that existing repository owns universal_carts/universal_cart_items/
 * universal_cart_events; this file owns everything else the route reads —
 * user_tenants, app_users, user_limitations, products, shop_video_anchors,
 * and the me_context RPC). PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchMeContext(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

// ==================== user_tenants ====================

export async function fetchActiveRoleForTenant(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('user_tenants').select('active_role').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle();
}

export async function fetchPrimaryTenantId(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).maybeSingle();
}

// ==================== app_users / user_limitations ====================

export async function fetchUserCurrencyPreference(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('currency_preference').eq('user_id', userId).maybeSingle();
}

export async function fetchUserBudgetMonthlyCap(sb: SupabaseClient, userId: string) {
  return sb.from('user_limitations').select('budget_monthly_cap_cents').eq('user_id', userId).maybeSingle();
}

// ==================== products / shop_video_anchors ====================

export async function fetchProductAvailabilityForVideoShop(sb: SupabaseClient, productId: string) {
  return sb.from('products').select('id, is_active, availability').eq('id', productId).maybeSingle();
}

export async function fetchApprovedShopVideoAnchor(sb: SupabaseClient, videoId: string, productId: string) {
  return sb
    .from('shop_video_anchors')
    .select('id, shop_videos!inner(id, status, moderation_status)')
    .eq('video_id', videoId)
    .eq('product_id', productId)
    .eq('shop_videos.status', 'active')
    .eq('shop_videos.moderation_status', 'approved')
    .maybeSingle();
}
