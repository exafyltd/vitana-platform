// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references event-sync.ts — zero coverage today.
/**
 * services/event-sync.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in event-sync.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same filters, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchVtidLedgerStatus(sb: SupabaseClient, vtid: string) {
  return sb.from('vtid_ledger').select('vtid, status').eq('vtid', vtid).single();
}

export async function insertVtidLedgerRow(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('vtid_ledger').insert(row);
}

export async function updateVtidLedgerStatus(sb: SupabaseClient, vtid: string, status: string, updatedAtIso: string) {
  return sb.from('vtid_ledger').update({ status, updated_at: updatedAtIso }).eq('vtid', vtid);
}
