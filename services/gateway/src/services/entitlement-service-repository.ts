// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior); exercised indirectly
// by entitlement-service.ts's existing test suite (test/middleware/paywall.test.ts),
// which covers every call site here.
/**
 * services/entitlement-service.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in entitlement-service.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same RPC params, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_subscriptions ====================

export async function fetchUserSubscription(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('user_subscriptions')
    .select('plan_key, status, current_period_end, cancel_at_period_end, trial_end, metadata')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .maybeSingle();
}

// ==================== feature_entitlements ====================

export async function fetchFeatureEntitlementConfig(sb: SupabaseClient, planKey: string, feature: string) {
  return sb
    .from('feature_entitlements')
    .select('plan_key, feature_key, quota, window_seconds, window_5h_quota, weekly_quota, unit, behavior_on_exceed, credit_cost_per_unit, allowed_burn_buckets')
    .eq('plan_key', planKey)
    .eq('feature_key', feature)
    .maybeSingle();
}

// ==================== wallet_balances ====================

export async function fetchWalletBalances(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb.from('wallet_balances').select('purchased_credits, reward_credits, cash_balance').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle();
}

// ==================== paywall_events ====================

export async function insertPaywallEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('paywall_events').insert(row);
}

// ==================== RPCs ====================

export async function getFeatureUsage(sb: SupabaseClient, params: { p_tenant_id: string; p_user_id: string; p_feature_key: string; p_window_seconds: number }) {
  return sb.rpc('fn_get_feature_usage', params);
}

export async function getFeatureUsageInWindow(sb: SupabaseClient, params: { p_tenant_id: string; p_user_id: string; p_feature_key: string; p_window_seconds: number }) {
  return sb.rpc('fn_get_feature_usage_in_window', params);
}

export async function incrementFeatureUsage(sb: SupabaseClient, params: { p_tenant_id: string; p_user_id: string; p_feature_key: string; p_amount: number; p_window_seconds: number }) {
  return sb.rpc('fn_increment_feature_usage', params);
}

export async function consumeCreditsRpc(sb: SupabaseClient, params: { p_tenant_id: string; p_user_id: string; p_credits: number; p_bucket: string; p_feature_key: string; p_idempotency_key: string }) {
  return sb.rpc('fn_consume_credits', params);
}
