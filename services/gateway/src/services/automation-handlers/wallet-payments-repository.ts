/**
 * automation-handlers/wallet-payments.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in automation-handlers/
 * wallet-payments.ts now goes through here instead of being written
 * inline. PURE MOVE, not a rewrite: same queries, same columns, same
 * conditional-filter logic, same return shapes — no behavior change
 * today. Client-agnostic (takes `supabase` as a param) — handlers receive
 * their client via `AutomationContext`, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== app_users ====================

export async function fetchStripeAccountStatus(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('stripe_account_id, stripe_charges_enabled').eq('user_id', userId).maybeSingle();
}

export async function fetchCreatorsWithStripeCharges(supabase: SupabaseClient) {
  return supabase.from('app_users').select('user_id, display_name').eq('stripe_charges_enabled', true);
}

// ==================== wallet (RPC) ====================

export async function creditWallet(
  supabase: SupabaseClient,
  params: {
    p_tenant_id: string;
    p_user_id: string;
    p_amount: number;
    p_type: string;
    p_source: string;
    p_source_event_id: string;
    p_description: string;
  }
) {
  return supabase.rpc('credit_wallet', params);
}

// ==================== monetization_signals / d28_emotional_signals ====================
// KNOWN GAP (pre-existing, unchanged by this move): neither table was ever
// deployed — both queries always no-op (error, empty data).

export async function fetchMonetizationSignals(supabase: SupabaseClient, tenantId: string, userId: string, sinceIso: string) {
  return supabase
    .from('monetization_signals')
    .select('signal_type, indicator, weight')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('detected_at', sinceIso);
}

export async function fetchEmotionalVulnerabilitySignals(supabase: SupabaseClient, tenantId: string, userId: string) {
  return supabase
    .from('d28_emotional_signals')
    .select('signal_type')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .in('signal_type', ['emotional_vulnerability', 'distress', 'overwhelmed'])
    .limit(1);
}

// ==================== user_offers_memory ====================
// KNOWN GAP (pre-existing, unchanged by this move): table was never
// deployed live — this query always no-ops (txCount always 0).

export async function countUsedOffersForCreator(supabase: SupabaseClient, tenantId: string, creatorId: string, sinceIso: string) {
  return supabase
    .from('user_offers_memory')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('target_id', creatorId)
    .eq('state', 'used')
    .gte('updated_at', sinceIso);
}

// ==================== user_subscriptions ====================

export async function fetchExpiringSubscriptions(supabase: SupabaseClient, tenantId: string, fromIso: string, toIso: string) {
  return supabase
    .from('user_subscriptions')
    .select('user_id, plan_key, current_period_end')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .eq('cancel_at_period_end', true)
    .gte('current_period_end', fromIso)
    .lte('current_period_end', toIso)
    .limit(500);
}

// ==================== user_notifications ====================

export async function fetchRecentExpiryWarning(supabase: SupabaseClient, userId: string, cutoffIso: string) {
  return supabase
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .contains('data', { automation_id: 'AP-0704' })
    .gte('created_at', cutoffIso)
    .limit(1);
}

// ==================== wallet_transactions ====================

export async function fetchCompletedOutgoingTransactions(supabase: SupabaseClient, userId: string, fromIso: string, toIso: string) {
  return supabase
    .from('wallet_transactions')
    .select('amount, from_currency')
    .eq('from_user_id', userId)
    .eq('status', 'completed')
    .gte('created_at', fromIso)
    .lt('created_at', toIso);
}
