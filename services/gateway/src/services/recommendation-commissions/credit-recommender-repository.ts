// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in credit-recommender.ts has any test coverage today — no
// test file in this repo references this module. Extra care taken here
// given this module credits real wallet money (via creditWalletForEarning)
// on the success path — every insert/select was mapped 1:1 against the
// original, no fields added/dropped/reordered.
/**
 * services/recommendation-commissions/credit-recommender.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in credit-recommender.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchDefaultCommissionRateSetting(sb: SupabaseClient) {
  return sb.from('admin_settings').select('value').eq('key', 'recommendation_commission_default_rate').maybeSingle();
}

export async function fetchProductOrderForCommission(sb: SupabaseClient, orderId: string) {
  return sb
    .from('product_orders')
    .select('id, state, commission_cents, currency, attribution_recommendation_id, merchant_id, product_id, user_id, click_id')
    .eq('id', orderId)
    .maybeSingle();
}

/** VTID-04741: return window for conversions the network has not approved. */
export async function fetchReturnWindowSetting(sb: SupabaseClient) {
  return sb.from('admin_settings').select('value').eq('key', 'recommendation_commission_return_window_days').maybeSingle();
}

/**
 * VTID-04741: one page of pending commissions whose return window has passed,
 * keyset-paged by id (`afterId` exclusive, `upToId` inclusive) so rows that
 * stay pending (e.g. no wallet yet) never hide the ones behind them.
 */
export async function fetchDuePendingCommissions(
  sb: SupabaseClient,
  nowIso: string,
  limit: number,
  afterId: string | null = null,
  upToId: string | null = null,
) {
  let q = sb
    .from('recommendation_commissions')
    .select('id, product_order_id, product_recommendation_id, recommender_user_id, payout_amount_minor, currency, rate_applied, vitana_commission_cents')
    .eq('status', 'pending')
    .lte('confirm_after', nowIso);
  if (afterId) q = q.gt('id', afterId);
  if (upToId) q = q.lte('id', upToId);
  return q.order('id', { ascending: true }).limit(limit);
}

/**
 * VTID-04741: confirm one held commission in a single DB transaction
 * (confirm_recommendation_commission): row lock, order-still-converted check,
 * wallet credit, status and stats together. Returns { ok, status, error? }.
 */
export async function confirmRecommendationCommissionRpc(sb: SupabaseClient, commissionId: string) {
  return sb.rpc('confirm_recommendation_commission', { p_commission_id: commissionId });
}

/**
 * VTID-04741: reverse an order's commission in a single DB transaction
 * (reverse_recommendation_commission): pending -> reversed, or a paid one
 * reported once for clawback, each with its OASIS event in the same commit.
 */
export async function reverseRecommendationCommissionRpc(sb: SupabaseClient, orderId: string, reason: string) {
  return sb.rpc('reverse_recommendation_commission', { p_order_id: orderId, p_reason: reason });
}

/**
 * VTID-04741: a reversed commission whose order is a sale again goes back to
 * `pending` (guarded on `reversed`, so only one caller reopens it). A reversed
 * row was never paid, so no ledger entry is touched; the amount and rate stay
 * as recorded.
 */
export async function reopenReversedCommission(sb: SupabaseClient, id: string, confirmAfter: string) {
  return sb
    .from('recommendation_commissions')
    .update({ status: 'pending', confirm_after: confirmAfter, reversed_at: null, reversal_reason: null })
    .eq('id', id)
    .eq('status', 'reversed')
    .select('id');
}

/** VTID-04740: the referrer frozen on the click at redirect time. */
export async function fetchClickReferrer(sb: SupabaseClient, clickId: string) {
  return sb.from('product_clicks').select('referrer_user_id').eq('click_id', clickId).maybeSingle();
}

export async function fetchExistingRecommendationCommission(sb: SupabaseClient, orderId: string) {
  return sb.from('recommendation_commissions').select('id, status').eq('product_order_id', orderId).maybeSingle();
}

export async function fetchProductRecommendationForCommission(sb: SupabaseClient, recommendationId: string) {
  return sb.from('product_recommendations').select('id, user_id, product_id, status').eq('id', recommendationId).maybeSingle();
}

export async function fetchMerchantCommissionEligibility(sb: SupabaseClient, merchantId: string) {
  return sb
    .from('merchants')
    .select('recommendation_commission_eligible, recommendation_commission_rate_override')
    .eq('id', merchantId)
    .maybeSingle();
}

/** Reused across the skipped and pending branches — same table, different row shapes. Returns the new row's id. */
export async function insertRecommendationCommission(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('recommendation_commissions').insert(row).select('id').maybeSingle();
}

/**
 * oasis_events has no `type` column and requires `role`: callers pass `type`
 * (same value as `topic`), so it is dropped here and `role` is set, otherwise
 * PostgREST rejects the insert and the event is lost.
 */
export async function insertCommissionSkippedIneligibleEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  const event: Record<string, unknown> = { role: 'GATEWAY', ...row };
  delete event.type;
  return sb.from('oasis_events').insert(event);
}

export async function fetchRecommenderWalletAccount(sb: SupabaseClient, userId: string, currency: string) {
  return sb.from('wallet_accounts').select('id, currency').eq('user_id', userId).eq('currency', currency).maybeSingle();
}

export async function incrementProductRecommendationStats(
  sb: SupabaseClient,
  params: { p_recommendation_id: string; p_commission_earned_minor: number },
) {
  return sb.rpc('increment_product_recommendation_stats', params);
}
