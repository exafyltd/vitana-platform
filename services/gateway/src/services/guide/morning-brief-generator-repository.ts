/**
 * guide/morning-brief-generator.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/morning-brief-generator.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filters/ordering, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * codebase.
 *
 * NOTE: `fetchLifeCompass` and `buildRankerContext` used elsewhere in
 * morning-brief-generator.ts are calls into OTHER modules' own functions,
 * not raw calls belonging to this file — deliberately not moved here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== vitana_index_scores ====================

export async function fetchLatestIndexScore(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('vitana_index_scores')
    .select('score_total, date')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchFirstIndexScoreDate(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('vitana_index_scores')
    .select('date')
    .eq('user_id', userId)
    .order('date', { ascending: true })
    .limit(1)
    .maybeSingle();
}

// ==================== autopilot_recommendations ====================

export async function fetchTopNewCommunityRecommendations(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase
    .from('autopilot_recommendations')
    .select('id, title, source_ref, impact_score, economic_axis, contribution_vector, domain, status')
    .eq('user_id', userId)
    .eq('source_type', 'community')
    .eq('status', 'new')
    .order('impact_score', { ascending: false })
    .limit(limit);
}
