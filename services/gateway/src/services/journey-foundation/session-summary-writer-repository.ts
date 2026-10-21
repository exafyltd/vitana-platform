// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references session-summary-writer.ts — zero coverage today.
/**
 * services/journey-foundation/session-summary-writer.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in session-summary-writer.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchLatestJourneySessionUpdate(sb: SupabaseClient, userId: string) {
  return sb
    .from('journey_session_updates')
    .select('completed_steps')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function insertJourneySessionUpdate(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('journey_session_updates').insert(row);
}
