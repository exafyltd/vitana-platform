/**
 * VTID-04982 — DB access for the Rewards shop. Every write goes through the
 * locked SQL functions (redeem / settle / release / set status); the only
 * direct writes are attaching the Stripe session to an order and the admin
 * catalogue upsert, both service-role only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const ITEM_COLUMNS =
  'id, slug, titles, descriptions, images, vtna_price, fulfilment, age_restricted, min_age, ships_to_countries, stock, reserved, is_active, sort_order';
export const ORDER_COLUMNS =
  'id, item_id, vtna_amount, fulfilment, status, country, shipping_fee_cents, shipping_currency, age_confirmed_at, reservation_expires_at, paid_at, status_reason, created_at, updated_at';

export function fetchActiveItems(sb: SupabaseClient) {
  return sb.from('reward_shop_items').select(ITEM_COLUMNS).eq('is_active', true)
    .order('sort_order', { ascending: true }).order('vtna_price', { ascending: true });
}

export function fetchAllItems(sb: SupabaseClient) {
  return sb.from('reward_shop_items').select(ITEM_COLUMNS).order('sort_order', { ascending: true });
}

export function fetchShippingFees(sb: SupabaseClient) {
  return sb.from('reward_shipping_fees').select('country, currency, fee_cents');
}

export function fetchEarnedBalance(sb: SupabaseClient, userId: string) {
  return sb.from('user_wallets').select('earned_balance').eq('user_id', userId).eq('currency_type', 'CREDITS').maybeSingle();
}

export function fetchMemberOrders(sb: SupabaseClient, userId: string, limit = 50) {
  return sb.from('reward_orders').select(ORDER_COLUMNS).eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(limit);
}

export function fetchOrder(sb: SupabaseClient, orderId: string) {
  return sb.from('reward_orders').select(`${ORDER_COLUMNS}, user_id, tenant_id, stripe_session_id, stripe_payment_intent`)
    .eq('id', orderId).maybeSingle();
}

export function fetchOrdersForAdmin(sb: SupabaseClient, status: string | null, limit = 100) {
  let q = sb.from('reward_orders')
    .select(`${ORDER_COLUMNS}, user_id, tenant_id, shipping_address, stripe_session_id`)
    .order('created_at', { ascending: false }).limit(limit);
  if (status) q = q.eq('status', status);
  return q;
}

export function attachStripeSession(sb: SupabaseClient, orderId: string, sessionId: string) {
  return sb.from('reward_orders').update({ stripe_session_id: sessionId, updated_at: new Date().toISOString() })
    .eq('id', orderId).eq('status', 'awaiting_shipping_payment');
}

export function upsertItem(sb: SupabaseClient, item: Record<string, unknown>) {
  return sb.from('reward_shop_items').upsert(item, { onConflict: 'slug' }).select(ITEM_COLUMNS).single();
}

export function upsertShippingFee(sb: SupabaseClient, fee: { country: string; currency: string; fee_cents: number }) {
  return sb.from('reward_shipping_fees').upsert({ ...fee, updated_at: new Date().toISOString() }, { onConflict: 'country,currency' });
}

/** VTID-05035 — admin: every fee row, so the admin sees what is configured. */
export function fetchAllShippingFees(sb: SupabaseClient) {
  return sb.from('reward_shipping_fees').select('country, currency, fee_cents, updated_at')
    .order('country', { ascending: true }).order('currency', { ascending: true });
}

/** VTID-05035 — admin: remove one fee row (country × currency). */
export function deleteShippingFee(sb: SupabaseClient, country: string, currency: string) {
  return sb.from('reward_shipping_fees').delete().eq('country', country).eq('currency', currency);
}

export function rpcRedeem(sb: SupabaseClient, params: {
  p_tenant_id: string;
  p_user_id: string;
  p_item_id: string;
  p_idempotency_key: string;
  p_currency: string;
  p_country: string | null;
  p_address: Record<string, string> | null;
  p_birth_date: string | null;
  p_age_confirmed: boolean;
}) {
  return sb.rpc('redeem_reward_item', params);
}

export function rpcSettleShipping(sb: SupabaseClient, params: { p_order_id: string; p_session_id: string; p_payment_intent: string | null }) {
  return sb.rpc('settle_reward_order_shipping', params);
}

export function rpcReleaseReservation(sb: SupabaseClient, orderId: string, reason: string) {
  return sb.rpc('release_reward_reservation', { p_order: orderId, p_reason: reason });
}

export function rpcReleaseExpired(sb: SupabaseClient) {
  return sb.rpc('release_expired_reward_reservations', {});
}

export function rpcSetStatus(sb: SupabaseClient, orderId: string, status: string, reason: string | null) {
  return sb.rpc('set_reward_order_status', { p_order_id: orderId, p_status: status, p_reason: reason });
}
