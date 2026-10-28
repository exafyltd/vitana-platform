// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references orb-tools/wallet-payments-tools.ts — zero
// coverage today.
/**
 * orb-tools/wallet-payments-tools.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * orb-tools/wallet-payments-tools.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param) — tools
 * receive their client per-call, not a module-level singleton. Note: the
 * actual money-moving primitives (debitWalletForSpend /
 * creditWalletForEarning) live in services/wallet/spend-earning-service.ts
 * and are NOT touched by this seam — this file only moves the direct
 * Supabase reads/writes that were inline in the tool handlers themselves.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserSubscriptionForWalletSummary(sb: SupabaseClient, userId: string, tenantId?: string | null) {
  let subQuery = sb
    .from('user_subscriptions')
    .select('plan_key, status, current_period_end')
    .eq('user_id', userId);
  if (tenantId) subQuery = subQuery.eq('tenant_id', tenantId);
  return subQuery.maybeSingle();
}

export async function fetchRewardsLedgerForUser(sb: SupabaseClient, userId: string) {
  return sb.from('rewards_ledger').select('amount, state, currency').eq('user_id', userId);
}

export async function resolveRecipientCandidates(sb: SupabaseClient, actorUserId: string, token: string, limit: number) {
  return sb.rpc('resolve_recipient_candidates', {
    p_actor: actorUserId,
    p_token: token,
    p_limit: limit,
    p_global: true,
  });
}

export async function fetchAppUserForTransfer(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('user_id, display_name, vitana_id').eq('user_id', userId).maybeSingle();
}

export async function insertWalletAccount(sb: SupabaseClient, userId: string, currency: string) {
  return sb
    .from('wallet_accounts')
    .insert({ user_id: userId, currency })
    .select('id, user_id, currency, balance_minor, status, created_at, updated_at')
    .single();
}

export async function fetchReferralEarnings(sb: SupabaseClient, userId: string) {
  return sb
    .from('rewards_ledger')
    .select('amount, state, currency, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
}

export async function fetchCommissionsForMonth(sb: SupabaseClient, userId: string, monthStartIso: string) {
  return sb
    .from('commission_event')
    .select('gross_commission, currency, status, merchant, created_at')
    .eq('user_id', userId)
    .gte('created_at', monthStartIso)
    .order('created_at', { ascending: false });
}

export async function fetchPendingRewards(sb: SupabaseClient, userId: string) {
  return sb
    .from('rewards_ledger')
    .select('amount, currency, created_at')
    .eq('user_id', userId)
    .eq('state', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);
}
