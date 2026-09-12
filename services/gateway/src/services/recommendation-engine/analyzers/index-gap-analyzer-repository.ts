// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// test/services/autopilot-community-actions-coverage.test.ts only imports
// the MENTAL_COMMUNITY_SOURCE_REFS constant from index-gap-analyzer.ts,
// not analyzeIndexGaps itself — zero genuine coverage today.
/**
 * services/recommendation-engine/analyzers/index-gap-analyzer.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in index-gap-analyzer.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchRecentPillarAgentOutputs(sb: SupabaseClient, userId: string) {
  return sb
    .from('vitana_pillar_agent_outputs')
    .select('pillar, subscore_baseline, subscore_completions, subscore_data, subscore_streak, date')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(20);
}

export async function fetchCompletedCalendarEventsSince(sb: SupabaseClient, userId: string, sinceIso: string) {
  return sb
    .from('calendar_events')
    .select('source_ref, source_ref_id')
    .eq('user_id', userId)
    .eq('completion_status', 'completed')
    .gte('completed_at', sinceIso);
}
