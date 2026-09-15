// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/community-find-member.ts — zero coverage
// today.
/**
 * routes/community-find-member.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in community-find-member.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchViewerVitanaId(sb: SupabaseClient, viewerUserId: string) {
  return sb.from('app_users').select('vitana_id').eq('user_id', viewerUserId).maybeSingle();
}

export async function insertCommunitySearchHistory(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('community_search_history').insert(row).select('search_id').maybeSingle();
}

export async function fetchCommunitySearchHistoryById(sb: SupabaseClient, searchId: string) {
  return sb
    .from('community_search_history')
    .select('search_id, viewer_user_id, query, tier, lane, winner_vitana_id, recipe_json, created_at')
    .eq('search_id', searchId)
    .maybeSingle();
}
