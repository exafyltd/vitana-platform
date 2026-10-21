// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/pillar-agents.ts — zero coverage today.
/**
 * routes/pillar-agents.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in pillar-agents.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchPillarAgentOutputsForUserDate(sb: SupabaseClient, userId: string, date: string) {
  return sb
    .from('vitana_pillar_agent_outputs')
    .select('pillar, date, subscore_baseline, subscore_completions, subscore_data, subscore_streak, agent_version, computed_at, outputs_jsonb')
    .eq('user_id', userId)
    .eq('date', date)
    .order('pillar', { ascending: true });
}

export async function fetchRecentPillarAgentOutputsAdmin(sb: SupabaseClient, limit: number) {
  return sb
    .from('vitana_pillar_agent_outputs')
    .select('user_id, pillar, date, subscore_baseline, subscore_completions, subscore_data, subscore_streak, agent_version, computed_at')
    .order('computed_at', { ascending: false })
    .limit(limit);
}
