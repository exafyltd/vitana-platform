/**
 * guide/awareness-extensions.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/awareness-extensions.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes
 * `supabase` as a param), same convention as every other *-repository.ts
 * in this codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_guided_journey_state ====================

export async function fetchGuidedJourneyState(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('user_guided_journey_state')
    .select('mode, onboarding_status, current_session, completed_topic_ids, last_opened_topic_id')
    .eq('user_id', userId)
    .maybeSingle();
}

// ==================== journey_checklist_topics ====================

export async function fetchNextChecklistTopics(supabase: SupabaseClient, fromSession: number, limit: number) {
  return supabase
    .from('journey_checklist_topics')
    .select('topic_id, session, position')
    .eq('status', 'published')
    .eq('enabled', true)
    .gte('session', fromSession)
    .order('session', { ascending: true })
    .order('position', { ascending: true })
    .limit(limit);
}

// ==================== user_journey ====================

export async function fetchRecentGreetingOpenings(supabase: SupabaseClient, userId: string) {
  return supabase.from('user_journey').select('recent_greeting_openings').eq('user_id', userId).maybeSingle();
}

// ==================== app_users ====================

export async function fetchProfileCompletionFields(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('app_users')
    .select('first_name, last_name, date_of_birth, gender, city, country, avatar_url')
    .eq('user_id', userId)
    .maybeSingle();
}

// ==================== autopilot_recommendations ====================

export async function countActivatedRecommendations(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('autopilot_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'activated');
}

// ==================== user_proactive_pause ====================

export async function fetchActivePauseRows(supabase: SupabaseClient, userId: string, nowIso: string) {
  return supabase
    .from('user_proactive_pause')
    .select('scope, scope_value, paused_until')
    .eq('user_id', userId)
    .gt('paused_until', nowIso);
}

// ==================== memory_diary_entries ====================

export async function countDiaryEntriesSince(supabase: SupabaseClient, userId: string, sinceIso: string) {
  return supabase
    .from('memory_diary_entries')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', sinceIso);
}
