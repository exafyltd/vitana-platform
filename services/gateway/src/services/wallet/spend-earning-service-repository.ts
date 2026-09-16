// Coverage note: test/wallet-spend-earning.test.ts (plus
// test/checkout-service.test.ts and test/wave1-voice-tools-flow.test.ts)
// exercise this module against a mocked '../../lib/supabase' client (a
// functional fake, not a wholesale mock of this repository module), so
// these wrappers get genuine coverage, not a documented zero.
/**
 * services/wallet/spend-earning-service.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in spend-earning-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC names, same params, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 *
 * Money-adjacent: these RPCs own the transactional integrity of wallet
 * movements (SELECT FOR UPDATE → ledger insert → balance update). This
 * move does not touch that logic — it lives entirely in the DB-side RPC
 * functions, unchanged.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function debitWalletForSpendRpc(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('debit_wallet_for_spend', params);
}

export async function creditWalletForEarningRpc(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('credit_wallet_for_earning', params);
}
