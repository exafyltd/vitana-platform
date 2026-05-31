/**
 * Wallet balance + history read service — VTID-03201
 *
 * Read-only. RLS in the DB also enforces own-row access for safety, but we
 * filter explicitly here too so a config slip can't leak data.
 */

import { getSupabase } from '../../lib/supabase';
import type {
  WalletAccount,
  WalletCurrency,
  WalletLedgerEntry,
} from '../../types/wallet';

export async function getAccountsForUser(userId: string): Promise<WalletAccount[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('wallet_accounts')
    .select('*')
    .eq('user_id', userId)
    .order('currency', { ascending: true });
  if (error) {
    console.error('[wallet/balance] getAccountsForUser failed:', error.message);
    return [];
  }
  return (data ?? []) as WalletAccount[];
}

export interface TransactionsPage {
  entries: WalletLedgerEntry[];
  next_cursor: string | null;
}

export async function getTransactionsForUser(opts: {
  user_id: string;
  currency?: WalletCurrency;
  limit?: number;
  cursor?: string | null;
}): Promise<TransactionsPage> {
  const supabase = getSupabase();
  if (!supabase) return { entries: [], next_cursor: null };

  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  let q = supabase
    .from('wallet_ledger_entries')
    .select('*')
    .eq('user_id', opts.user_id)
    .order('created_at', { ascending: false })
    .limit(limit + 1);

  if (opts.currency) {
    q = q.eq('currency', opts.currency);
  }
  if (opts.cursor) {
    q = q.lt('created_at', opts.cursor);
  }

  const { data, error } = await q;
  if (error) {
    console.error('[wallet/balance] getTransactionsForUser failed:', error.message);
    return { entries: [], next_cursor: null };
  }

  const rows = (data ?? []) as WalletLedgerEntry[];
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const next_cursor = hasMore ? entries[entries.length - 1].created_at : null;

  return { entries, next_cursor };
}
