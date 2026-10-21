// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references pillar-agents/base-agent.ts — zero coverage
// today.
/**
 * services/pillar-agents/base-agent.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * pillar-agents/base-agent.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchBaselineSurveyAnswers(sb: SupabaseClient, userId: string) {
  return sb.from('vitana_index_baseline_survey').select('answers').eq('user_id', userId).maybeSingle();
}

export async function fetchCompletedCalendarEventsSince(sb: SupabaseClient, userId: string, cutoffIso: string) {
  return sb
    .from('calendar_events')
    .select('wellness_tags, completed_at, end_time')
    .eq('user_id', userId)
    .eq('completion_status', 'completed')
    .gte('completed_at', cutoffIso);
}

export async function countHealthFeaturesSince(sb: SupabaseClient, userId: string, cutoffIso: string, featureKeys: string[]) {
  return sb
    .from('health_features_daily')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('date', cutoffIso)
    .in('feature_key', featureKeys);
}

export async function fetchPillarStreakDays(sb: SupabaseClient, userId: string, pillar: string) {
  return sb.rpc('vitana_pillar_streak_days', { p_user_id: userId, p_pillar_key: pillar });
}
