// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// test/orb-tools/p0-gap-tools.test.ts and test/wave1-voice-tools-flow.test.ts
// both reference this module, but both wholesale jest.mock() /
// jest.doMock() it — zero genuine coverage today.
/**
 * services/wallet/balance-service.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in balance-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic (takes
 * `sb` as a param). Money-adjacent (read-only wallet history/balance).
 *
 * `fetchWalletLedgerEntriesForUser` resolves the terminal await inside
 * an async function (rather than returning a partial builder) so the
 * source's optional currency/cursor conditional filters still apply
 * before the query executes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WalletCurrency } from '../../types/wallet';

export async function fetchWalletAccountsForUser(sb: SupabaseClient, userId: string) {
  return sb.from('wallet_accounts').select('*').eq('user_id', userId).order('currency', { ascending: true });
}

export async function fetchWalletLedgerEntriesForUser(
  sb: SupabaseClient,
  args: { userId: string; currency?: WalletCurrency; cursor?: string | null; limit: number },
) {
  let q = sb
    .from('wallet_ledger_entries')
    .select('*')
    .eq('user_id', args.userId)
    .order('created_at', { ascending: false })
    .limit(args.limit);

  if (args.currency) {
    q = q.eq('currency', args.currency);
  }
  if (args.cursor) {
    q = q.lt('created_at', args.cursor);
  }

  return q;
}
