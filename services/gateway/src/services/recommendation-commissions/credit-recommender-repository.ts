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
    .select('id, state, commission_cents, currency, attribution_recommendation_id, merchant_id')
    .eq('id', orderId)
    .maybeSingle();
}

export async function fetchExistingRecommendationCommission(sb: SupabaseClient, orderId: string) {
  return sb.from('recommendation_commissions').select('id, status').eq('product_order_id', orderId).maybeSingle();
}

export async function fetchProductRecommendationForCommission(sb: SupabaseClient, recommendationId: string) {
  return sb.from('product_recommendations').select('id, user_id').eq('id', recommendationId).maybeSingle();
}

export async function fetchMerchantCommissionEligibility(sb: SupabaseClient, merchantId: string) {
  return sb
    .from('merchants')
    .select('recommendation_commission_eligible, recommendation_commission_rate_override')
    .eq('id', merchantId)
    .maybeSingle();
}

/** Reused across the ineligible/failed/credited branches — same table, different row shapes. */
export async function insertRecommendationCommission(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('recommendation_commissions').insert(row);
}

export async function insertCommissionSkippedIneligibleEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('oasis_events').insert(row);
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
