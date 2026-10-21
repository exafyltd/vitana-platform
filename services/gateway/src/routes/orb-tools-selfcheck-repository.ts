// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// the one referencing test (test/orb-tools-selfcheck.test.ts)
// deliberately deletes SUPABASE_URL/SUPABASE_SERVICE_ROLE before
// import so getSupabase() returns null and the handler 503s before
// any of these call sites execute — zero genuine coverage today.
/**
 * routes/orb-tools-selfcheck.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools-selfcheck.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filters, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAppUserIdentity(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('tenant_id, vitana_id').eq('user_id', userId).maybeSingle();
}

export async function deleteSelfcheckIndexPlanCalendarEvents(sb: SupabaseClient, userId: string, sinceIso: string) {
  return sb
    .from('calendar_events')
    .delete()
    .eq('user_id', userId)
    .eq('metadata->>plan', 'index_improvement')
    .gte('created_at', sinceIso);
}

export async function insertSelfcheckOasisEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('oasis_events').insert(row);
}
