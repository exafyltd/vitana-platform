/**
 * VTID-04864 — DB reads for the Wallet → Rewards overview. Read-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** The member's most recent reward credits on the VTNA ledger (history list). */
export function fetchRecentRewards(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('wallet_transactions')
    .select('amount, idempotency_key, created_at')
    .eq('to_user_id', userId)
    .eq('transaction_type', 'reward')
    .order('created_at', { ascending: false })
    .limit(limit);
}

/** Which of the given once-only rule keys this member has EVER been paid —
 *  lifetime, independent of how many other rewards came since. */
export function fetchEarnedKeys(sb: SupabaseClient, userId: string, keys: string[]) {
  return sb
    .from('wallet_transactions')
    .select('idempotency_key')
    .eq('to_user_id', userId)
    .in('idempotency_key', keys);
}

/** Rewards whose key starts with `prefix` since `sinceIso` (rolling caps). */
export function fetchKeyPrefixSince(sb: SupabaseClient, userId: string, prefix: string, sinceIso: string) {
  return sb
    .from('wallet_transactions')
    .select('idempotency_key, created_at')
    .eq('to_user_id', userId)
    .like('idempotency_key', `${prefix}%`)
    .gte('created_at', sinceIso);
}

/** The earned part of the member's VTNA (CREDITS) wallet. */
export function fetchEarnedBalance(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_wallets')
    .select('earned_balance')
    .eq('user_id', userId)
    .eq('currency_type', 'CREDITS')
    .maybeSingle();
}
