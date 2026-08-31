// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/vitana-index.ts — zero coverage today.
/**
 * routes/vitana-index.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in vitana-index.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchOpenAutopilotRecommendationsWithVector(sb: SupabaseClient, userId: string) {
  return sb
    .from('autopilot_recommendations')
    .select('id, title, summary, contribution_vector, impact_score, status')
    .eq('user_id', userId)
    .in('status', ['pending', 'new', 'snoozed'])
    .not('contribution_vector', 'is', null)
    .order('impact_score', { ascending: false, nullsFirst: false })
    .limit(50);
}
