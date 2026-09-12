// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references orb-tools/cart-checkout-tools.ts — zero
// coverage today.
/**
 * orb-tools/cart-checkout-tools.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/cart-checkout-tools.ts
 * now goes through here instead of being written inline. PURE MOVE, not
 * a rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic (takes
 * `sb` as a param) — tools receive their client per-call, not a
 * module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const CART_ITEM_COLS =
  'id, cart_id, product_id, item_type, quantity, status, source_surface, unit_price_cents_snapshot, currency_snapshot, metadata';
const PRODUCT_COLS = 'id, title, category, price_cents, currency, is_active, availability';

export async function fetchActiveCart(sb: SupabaseClient, userId: string) {
  return sb.from('universal_carts').select('id, user_id, tenant_id, status').eq('user_id', userId).eq('status', 'active').maybeSingle();
}

export async function insertActiveCart(sb: SupabaseClient, userId: string, tenantId: string | null) {
  return sb.from('universal_carts').insert({ user_id: userId, tenant_id: tenantId, status: 'active', metadata: {} }).select('id').single();
}

export async function fetchActiveCartItems(sb: SupabaseClient, cartId: string) {
  return sb.from('universal_cart_items').select(CART_ITEM_COLS).eq('cart_id', cartId).eq('status', 'active').order('created_at', { ascending: true });
}

export async function fetchProductsByIds(sb: SupabaseClient, productIds: string[]) {
  return sb.from('products').select(PRODUCT_COLS).in('id', productIds);
}

export async function fetchProductById(sb: SupabaseClient, productId: string) {
  return sb.from('products').select(PRODUCT_COLS).eq('id', productId).maybeSingle();
}

export async function searchActiveProductsByTitle(sb: SupabaseClient, query: string) {
  return sb.from('products').select(PRODUCT_COLS).eq('is_active', true).ilike('title', `%${query}%`).order('title', { ascending: true }).limit(5);
}

export async function fetchExistingCartItem(sb: SupabaseClient, cartId: string, productId: string) {
  return sb.from('universal_cart_items').select('id, quantity, metadata').eq('cart_id', cartId).eq('product_id', productId).eq('status', 'active').maybeSingle();
}

export async function bumpCartItemQuantity(sb: SupabaseClient, itemId: string, newQuantity: number) {
  return sb.from('universal_cart_items').update({ quantity: newQuantity }).eq('id', itemId).select('id').single();
}

export async function insertCartItem(
  sb: SupabaseClient,
  payload: {
    cart_id: string;
    item_type: string;
    product_id: string;
    quantity: number;
    status: string;
    source_surface: string;
    unit_price_cents_snapshot: number | null;
    currency_snapshot: string | null;
    metadata: Record<string, unknown>;
  },
) {
  return sb.from('universal_cart_items').insert(payload).select('id').single();
}

export async function updateCartItemQuantityActive(sb: SupabaseClient, itemId: string, quantity: number) {
  return sb.from('universal_cart_items').update({ quantity }).eq('id', itemId).eq('status', 'active').select('id').single();
}

export async function markCartItemRemoved(sb: SupabaseClient, itemId: string) {
  return sb.from('universal_cart_items').update({ status: 'removed' }).eq('id', itemId).eq('status', 'active').select('id').single();
}

export async function markAllCartItemsRemoved(sb: SupabaseClient, cartId: string) {
  return sb.from('universal_cart_items').update({ status: 'removed' }).eq('cart_id', cartId).eq('status', 'active').select('id');
}

export async function fetchAppUserTenantId(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('tenant_id').eq('user_id', userId).maybeSingle();
}

export async function fetchAppUserCurrencyPreference(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('currency_preference').eq('user_id', userId).maybeSingle();
}

export async function fetchUserLimitationsExists(sb: SupabaseClient, userId: string) {
  return sb.from('user_limitations').select('user_id').eq('user_id', userId).maybeSingle();
}

export function clearUserLimitationsBudgetCap(sb: SupabaseClient, userId: string): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('user_limitations').update({ budget_monthly_cap_cents: null }).eq('user_id', userId);
}

export function upsertUserLimitationsBudgetCap(
  sb: SupabaseClient,
  userId: string,
  tenantId: string,
  capCents: number,
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('user_limitations').upsert({ user_id: userId, tenant_id: tenantId, budget_monthly_cap_cents: capCents }, { onConflict: 'user_id' });
}
