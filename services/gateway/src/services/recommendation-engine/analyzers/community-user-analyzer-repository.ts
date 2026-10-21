// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in gatherUserContext() has any test coverage today — both
// referencing test files
// (test/services/guide/awareness-context.test.ts, test/companion-qa.test.ts)
// mock this entire module wholesale; test/services/decision-contract/marketplace-community-policies.test.ts
// only imports the pure functions detectCanonicalWeaknesses/detectOnboardingStage,
// never gatherUserContext.
/**
 * services/recommendation-engine/analyzers/community-user-analyzer.ts —
 * Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md
 * Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call inside gatherUserContext()'s 8-way
 * Promise.all fan-out now goes through here instead of being written
 * inline. PURE MOVE, not a rewrite: same queries, same columns, same
 * conditional-filter logic, same return shapes — no behavior change
 * today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchRecentVitanaIndexScores(sb: SupabaseClient, userId: string) {
  return sb
    .from('vitana_index_scores')
    .select('score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(2);
}

export async function fetchProfileMemoryFacts(sb: SupabaseClient, userId: string) {
  return sb
    .from('memory_facts')
    .select('fact_key, fact_value')
    .eq('user_id', userId)
    .in('fact_key', ['name', 'display_name', 'goals', 'interests', 'hobbies', 'preferred_language']);
}

export async function fetchRecentDiaryEntries(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('memory_items')
    .select('content, tags, metadata')
    .eq('user_id', userId)
    .eq('item_type', 'diary')
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function countConnectedRelationshipEdges(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('relationship_edges')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .eq('target_type', 'person')
    .eq('relationship_type', 'connected');
}

export async function countGroupRelationshipEdges(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('relationship_edges')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .eq('target_type', 'group');
}

export async function countPendingDailyMatches(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('matches_daily')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .is('feedback', null);
}

export async function fetchAppUserAccountInfo(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('created_at, display_name').eq('user_id', userId).maybeSingle();
}

export async function fetchDiaryStreakDates(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('memory_items')
    .select('created_at')
    .eq('user_id', userId)
    .eq('item_type', 'diary')
    .order('created_at', { ascending: false })
    .limit(limit);
}
