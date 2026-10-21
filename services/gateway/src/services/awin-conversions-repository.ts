// impact-allow-no-test: pure data-access seam (thin Supabase query/upsert
// wrappers, no independent request-handling behavior). Coverage note:
// test/routes/awin-conversions.test.ts only exercises the pure helpers
// (mapAwinTxStatus, mapAwinTransaction, resolveAwinTxConfig, awinDateParam,
// awinCreditIds) — creditAwinConversions (the only function that touches
// these call sites) has no test coverage today.
/**
 * services/awin-conversions.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in awin-conversions.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

export async function fetchAwinProgramMerchants(sb: any) {
  return sb.from('affiliate_program').select('id,merchant').eq('network', 'awin');
}

export async function fetchSubidMapEntry(sb: any, subId: string) {
  return sb.from('subid_map').select('user_id, affiliate_program_id, network').eq('sub_id', subId).maybeSingle();
}

export async function fetchCommissionEventStatus(sb: any, commissionId: string) {
  return sb.from('commission_event').select('status').eq('id', commissionId).maybeSingle();
}

export async function upsertCommissionEvent(sb: any, row: Record<string, unknown>) {
  return sb.from('commission_event').upsert(row, { onConflict: 'id' });
}

export async function upsertRewardsLedgerEntry(sb: any, row: Record<string, unknown>) {
  return sb.from('rewards_ledger').upsert(row, { onConflict: 'id' });
}

export async function insertOasisAuditEvent(sb: any, row: Record<string, unknown>) {
  return sb.from('oasis_events').insert(row);
}
