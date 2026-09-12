// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// no test file references routes/automations.ts — zero coverage
// today.
/**
 * routes/automations.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/automations.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param). Read-only wallet queries only — the actual
 * money-moving primitives live in services/wallet/spend-earning-service.ts
 * and are untouched by this seam.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchWalletBalance(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('wallet_balances')
    .select('balance, total_earned, total_spent, updated_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .maybeSingle();
}

export async function fetchWalletTransactions(sb: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return sb
    .from('wallet_transactions')
    .select('id, amount, type, source, description, balance_after, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function insertSharingLink(
  sb: SupabaseClient,
  row: { tenant_id: string; user_id: string; target_type: string; target_id: string; short_code: string; utm_campaign: string },
) {
  return sb.from('sharing_links').insert(row).select('id, short_code').single();
}

export async function fetchSharingLinks(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('sharing_links')
    .select('id, target_type, target_id, short_code, click_count, signup_count, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
}

export async function fetchReferralsForUser(sb: SupabaseClient, tenantId: string, referrerId: string) {
  return sb
    .from('referrals')
    .select('id, source, status, reward_amount, click_count, created_at, activated_at')
    .eq('tenant_id', tenantId)
    .eq('referrer_id', referrerId)
    .order('created_at', { ascending: false })
    .limit(50);
}
