// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// checkout-service.ts's existing test suite, which covers every call site
// here.
/**
 * checkout/checkout-service.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in checkout/checkout-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes, same call ORDER (this file's money-safety sequencing — INTENT
 * before DEBIT before SETTLE — depends on it) — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== universal_carts / universal_cart_items ====================

export async function fetchActiveCartForUser(sb: SupabaseClient, userId: string) {
  return sb.from('universal_carts').select('id, user_id, status').eq('user_id', userId).eq('status', 'active').maybeSingle();
}

export async function fetchActiveCartItems(sb: SupabaseClient, cartId: string) {
  return sb
    .from('universal_cart_items')
    .select(
      'id, product_id, quantity, unit_price_cents_snapshot, currency_snapshot, source_surface, source_video_id, source_creator_id, item_type',
    )
    .eq('cart_id', cartId)
    .eq('status', 'active');
}

export async function completeCartItems(sb: SupabaseClient, cartId: string, itemIds: string[]) {
  return sb.from('universal_cart_items').update({ status: 'completed' }).eq('cart_id', cartId).in('id', itemIds);
}

// ==================== products ====================

export async function fetchProductsByIds(sb: SupabaseClient, productIds: string[]) {
  return sb
    .from('products')
    .select('id, source_network, price_cents, currency, is_active, availability, merchant_id, affiliate_url')
    .in('id', productIds);
}

// ==================== wallet_accounts ====================

export async function fetchWalletAccountForCurrency(sb: SupabaseClient, userId: string, currency: string) {
  return sb.from('wallet_accounts').select('id, status, currency, balance_minor').eq('user_id', userId).eq('currency', currency).maybeSingle();
}

// ==================== product_orders ====================

export async function fetchExistingOrdersForCheckout(sb: SupabaseClient, userId: string, checkoutIdPrefix: string) {
  return sb.from('product_orders').select('id, external_order_id').eq('user_id', userId).like('external_order_id', checkoutIdPrefix);
}

export async function insertPendingOrders(sb: SupabaseClient, rows: Record<string, unknown>[]) {
  return sb.from('product_orders').insert(rows).select('id, external_order_id');
}

export async function convertOrdersByExternalIds(sb: SupabaseClient, userId: string, externalOrderIds: string[], purchasedAtIso: string) {
  return sb
    .from('product_orders')
    .update({ state: 'converted', purchased_at: purchasedAtIso })
    .eq('user_id', userId)
    .in('external_order_id', externalOrderIds);
}

// ==================== shop_video_events ====================

export async function insertShopVideoEvents(sb: SupabaseClient, rows: Record<string, unknown>[]) {
  return sb.from('shop_video_events').insert(rows);
}
