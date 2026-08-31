// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// only keyOk/mapStatus (pure helpers, unrelated to these call sites) are
// tested for vcaop-postback.ts today — the DB-touching handler() is
// untested. MONEY-CRITICAL: this file touches commission_event and
// rewards_ledger — every onConflict target and payload shape below is
// preserved byte-for-byte from the original inline calls.
/**
 * routes/vcaop-postback.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Resolve the member from the subid (reverse attribution). */
export async function fetchSubidMap(sb: SupabaseClient, subId: string) {
  return sb.from('subid_map').select('user_id, tenant_id, affiliate_program_id, network').eq('sub_id', subId).maybeSingle();
}

/** Fire-and-forget OASIS event insert — caller attaches its own no-op catch. */
export function insertOasisEvent(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: unknown }> {
  return sb.from('oasis_events').insert(row);
}

/** Idempotent upsert of the commission event, keyed by deterministic id. */
export async function upsertCommissionEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('commission_event').upsert(row, { onConflict: 'id' });
}

/** Idempotent upsert of the rewards ledger entry, keyed by deterministic id. */
export async function upsertRewardsLedgerEntry(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('rewards_ledger').upsert(row, { onConflict: 'id' });
}
