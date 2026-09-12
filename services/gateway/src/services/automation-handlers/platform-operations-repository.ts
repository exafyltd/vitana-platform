// Genuinely tested via test/services/automation-handlers-phase1-batch2.test.ts,
// which drives a functional fake Supabase client (makeFakeSupabase) — not
// a wholesale module mock.
/**
 * services/automation-handlers/platform-operations.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase
 * 3b/B1).
 *
 * Every Supabase `.from(...)` call in platform-operations.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * `checkTableReachable` preserves AP-1005's dynamic-table-name
 * existence probe (queries an arbitrary caller-supplied table name and
 * reports whether the query errored) exactly as it was written inline.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchRecentDeployEvents(sb: SupabaseClient, sinceIso: string) {
  return sb
    .from('oasis_events')
    .select('topic, service, status, message, created_at')
    .like('topic', 'deploy.%')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(50);
}

export async function fetchRecentErrorEvents(sb: SupabaseClient, windowStartIso: string) {
  return sb
    .from('oasis_events')
    .select('service, message, created_at')
    .eq('status', 'error')
    .gte('created_at', windowStartIso)
    .limit(1000);
}

export async function fetchRecentServiceAlertRun(sb: SupabaseClient, service: string, cooldownCutoffIso: string) {
  return sb
    .from('automation_runs')
    .select('id')
    .eq('automation_id', 'AP-1004')
    .gte('completed_at', cooldownCutoffIso)
    .contains('metadata', { alerted_service: service })
    .limit(1);
}

export async function checkTableReachable(sb: SupabaseClient, table: string) {
  return sb.from(table).select('*', { head: true, count: 'exact' }).limit(1);
}
