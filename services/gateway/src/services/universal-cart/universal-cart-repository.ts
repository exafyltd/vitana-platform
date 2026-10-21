/**
 * VTID-03213 (Universal Cart) — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase call routes/universal-cart.ts makes against the three
 * tables it is scoped to (per its own file header: "Reads / writes only
 * universal_carts, universal_cart_items, universal_cart_events") now goes
 * through here instead of calling `supabase.from(...)` inline. This is a
 * PURE MOVE, not a rewrite: each function is the exact same query chain
 * that used to live in the route handler — same columns, same filters,
 * same `{ data, error }` return shape — no behavior change today.
 *
 * Deliberately unchanged: the route's own declared exception for the
 * video_shop integrity check (products, shop_video_anchors) and the
 * /budget endpoint's reads (app_users, user_limitations) — those are
 * outside this cart-owned scope and stay inline in the route, same as
 * community-marketplace-repository.ts leaves profiles/
 * global_community_profiles inline. getActiveRole/resolvePrimaryTenantId
 * (user_tenants) are likewise shared/general, not cart-owned, and stay put.
 *
 * Callers pass in whichever Supabase client they already resolved — the
 * user-JWT-scoped client (RLS-enforced, cart/cart_items mutations) or the
 * service-role client (cart_events audit writes) — these functions are
 * client-agnostic, matching the route's existing split.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== universal_carts ====================

export async function fetchActiveCartFull(supabase: SupabaseClient, userId: string) {
  return supabase.from('universal_carts').select('*').eq('user_id', userId).eq('status', 'active').maybeSingle();
}

export async function fetchActiveCartId(supabase: SupabaseClient, userId: string) {
  return supabase.from('universal_carts').select('id').eq('user_id', userId).eq('status', 'active').maybeSingle();
}

export async function insertCart(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('universal_carts').insert(row).select('*').single();
}

export async function insertCartMinimal(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('universal_carts').insert(row).select('id').single();
}

// ==================== universal_cart_items ====================

export async function fetchActiveCartItems(supabase: SupabaseClient, cartId: string) {
  return supabase
    .from('universal_cart_items')
    .select('*')
    .eq('cart_id', cartId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
}

export async function fetchActiveCartItemsForBudget(supabase: SupabaseClient, cartId: string) {
  return supabase
    .from('universal_cart_items')
    .select('unit_price_cents_snapshot, quantity')
    .eq('cart_id', cartId)
    .eq('status', 'active');
}

export async function fetchActiveCartItemByProduct(supabase: SupabaseClient, cartId: string, productId: string) {
  return supabase
    .from('universal_cart_items')
    .select('*')
    .eq('cart_id', cartId)
    .eq('product_id', productId)
    .eq('status', 'active')
    .maybeSingle();
}

export async function insertCartItem(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('universal_cart_items').insert(row).select('*').single();
}

export async function fetchCartItemForPatch(supabase: SupabaseClient, itemId: string) {
  return supabase.from('universal_cart_items').select('id, cart_id, quantity, metadata, status').eq('id', itemId).maybeSingle();
}

export async function fetchCartItemForDelete(supabase: SupabaseClient, itemId: string) {
  return supabase.from('universal_cart_items').select('id, cart_id, status').eq('id', itemId).maybeSingle();
}

export async function fetchCartItemForComplete(supabase: SupabaseClient, itemId: string) {
  return supabase.from('universal_cart_items').select('id, cart_id, status, product_id').eq('id', itemId).maybeSingle();
}

export async function updateCartItem(supabase: SupabaseClient, itemId: string, payload: Record<string, unknown>) {
  return supabase.from('universal_cart_items').update(payload).eq('id', itemId).select('*').single();
}

// ==================== universal_cart_events ====================

export async function fetchCartEvents(supabase: SupabaseClient, cartId: string, limit: number) {
  return supabase
    .from('universal_cart_events')
    .select('*')
    .eq('cart_id', cartId)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function insertCartEvent(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('universal_cart_events').insert(row);
}
