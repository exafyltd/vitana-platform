// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// buildRankerContext (the only DB-touching function in
// index-pillar-weighter.ts, all 7 call sites) has NO genuine test coverage
// in this repo today — every test file that references it either mocks
// the whole index-pillar-weighter module wholesale
// (test/routes/autopilot-recommendations.test.ts,
// test/services/autopilot-voice-next-actions.test.ts) or is a source-check
// regex test that never invokes it
// (test/services/recommendation-engine/recommendation-generator-provenance-wireup.test.ts).
// Every other test file in this area (pillar-weighter-strategy,
// feedback-path-provenance, index-pillar-weighter-economic-boost) only
// imports the pure scoring functions (scoreRec/rankBatch/hasEconomicGoal),
// never buildRankerContext. This is a pure mechanical move, verified by
// tsc and by the full existing 149-test suite passing unchanged — flagged
// here rather than silently presented as covered.
/**
 * services/recommendation-engine/ranking/index-pillar-weighter.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in buildRankerContext() now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchLatestVitanaIndexScoreRow(sb: SupabaseClient, userId: string) {
  return sb
    .from('vitana_index_scores')
    .select('score_nutrition, score_hydration, score_exercise, score_sleep, score_mental, feature_inputs, date')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchFirstVitanaIndexScoreDate(sb: SupabaseClient, userId: string) {
  return sb
    .from('vitana_index_scores')
    .select('date')
    .eq('user_id', userId)
    .order('date', { ascending: true })
    .limit(1)
    .maybeSingle();
}

export async function fetchActiveLifeCompassCategory(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('category')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function countRecentCompletedCalendarEvents(sb: SupabaseClient, userId: string, since: string) {
  return sb
    .from('calendar_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('completion_status', 'completed')
    .gte('completed_at', since);
}

export async function fetchBaselineSurveyExists(sb: SupabaseClient, userId: string) {
  return sb.from('vitana_index_baseline_survey').select('user_id').eq('user_id', userId).limit(1).maybeSingle();
}

export async function fetchUserPillarRecentActivity(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_pillar_recent_activity')
    .select('pillar, last_completed_at, completions_24h, completions_7d, plan_events_24h')
    .eq('user_id', userId);
}

export async function fetchRecentRecommendationsForRejectionRate(sb: SupabaseClient, userId: string, since: string) {
  return sb.from('autopilot_recommendations').select('domain, status').eq('user_id', userId).gte('created_at', since);
}
