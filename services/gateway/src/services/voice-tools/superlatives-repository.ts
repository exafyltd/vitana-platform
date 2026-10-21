// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior); exercised
// indirectly by superlatives.ts's existing test suite
// (test/services/voice-tools/superlatives.test.ts), which covers every
// call site here via a real query-mock helper (not a whole-module mock).
/**
 * services/voice-tools/superlatives.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in superlatives.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchHiddenCommunityProfileUserIds(sb: SupabaseClient) {
  return sb.from('global_community_profiles').select('user_id').eq('is_visible', false);
}

export async function fetchAppUsersForHydration(sb: SupabaseClient, userIds: string[]) {
  return sb
    .from('app_users')
    .select('user_id, display_name, vitana_id, created_at, avatar_url:profile->>avatar_url')
    .in('user_id', userIds);
}

export async function fetchProfilesForHydration(sb: SupabaseClient, userIds: string[]) {
  return sb.from('profiles').select('user_id, registration_seq, location').in('user_id', userIds);
}

export async function fetchTopVitanaIndexScores(sb: SupabaseClient, limit: number) {
  return sb
    .from('vitana_index_scores')
    .select('user_id, score_total, date')
    .order('score_total', { ascending: false })
    .order('date', { ascending: false })
    .limit(limit);
}

/**
 * `column` is a runtime-derived `score_<pillar>` name — same dynamic-select
 * shape as the original inline call. The dynamic select string means
 * postgrest-js can't infer a named row type here (same as it never could
 * inline), so the return type is annotated explicitly rather than left
 * inferred — callers already treat these rows via `(row as any)`.
 */
export async function fetchTopPillarScores(
  sb: SupabaseClient,
  column: string,
  limit: number,
): Promise<{ data: any[] | null; error: any }> {
  return sb
    .from('vitana_index_scores')
    .select(`user_id, ${column}, date`)
    .order(column, { ascending: false })
    .order('date', { ascending: false })
    .limit(limit);
}

export async function fetchProfilesByRegistrationOrder(sb: SupabaseClient, ascending: boolean, limit: number) {
  return sb
    .from('profiles')
    .select('user_id, registration_seq')
    .order('registration_seq', { ascending, nullsFirst: false })
    .limit(limit);
}

export async function fetchRelationshipsToUserIdProbe(sb: SupabaseClient, limit: number) {
  return sb.from('relationships').select('to_user_id').limit(limit);
}

export async function fetchRelationshipsFolloweeIdProbe(sb: SupabaseClient, limit: number) {
  return sb.from('relationships').select('followee_id').limit(limit);
}
