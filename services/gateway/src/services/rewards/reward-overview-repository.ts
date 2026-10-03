/**
 * VTID-04864 — DB reads for the Wallet → Rewards overview. Read-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Reward credits the member received on the VTNA ledger, newest first. */
export function fetchRewardTransactions(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('wallet_transactions')
    .select('amount, idempotency_key, created_at')
    .eq('to_user_id', userId)
    .eq('transaction_type', 'reward')
    .order('created_at', { ascending: false })
    .limit(limit);
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
