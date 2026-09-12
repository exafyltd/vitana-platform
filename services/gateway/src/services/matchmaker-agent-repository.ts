/**
 * matchmaker-agent.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in matchmaker-agent.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * directory.
 *
 * Note: this file's `intent_matches`/`user_intents` tables are a distinct,
 * separate "dance intent matching" feature (VTID-DANCE-D12) from the
 * `matches_daily`/`daily_matches`-based matchmaking subsystem flagged as
 * likely-superseded/dead elsewhere in the Aurora migration's B2/B3 audits —
 * not the same call sites, not touched by that finding.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== intent_match_recommendations ====================

// Reused by markRecommendationStatus / persistRecommendation /
// markRecommendationError — same table + onConflict key, different row shape.
export async function upsertIntentMatchRecommendation(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('intent_match_recommendations').upsert(row, { onConflict: 'intent_id' });
}

// ==================== profiles ====================

export async function fetchProfilesByVitanaIds(supabase: SupabaseClient, vitanaIds: string[]) {
  return supabase.from('profiles').select('user_id, vitana_id').in('vitana_id', vitanaIds);
}

export async function fetchRequesterProfile(supabase: SupabaseClient, userId: string) {
  return supabase.from('profiles').select('vitana_id, display_name, city, registration_seq, dance_preferences').eq('user_id', userId).maybeSingle();
}

export async function fetchProfilesByUserIds(supabase: SupabaseClient, userIds: string[]) {
  return supabase.from('profiles').select('user_id, display_name, city, dance_preferences').in('user_id', userIds);
}

export async function fetchProfilesWithDancePreferences(supabase: SupabaseClient, excludeUserId: string, limit: number) {
  return supabase
    .from('profiles')
    .select('user_id, vitana_id, display_name, city, dance_preferences')
    .neq('user_id', excludeUserId)
    .not('dance_preferences', 'eq', '{}')
    .limit(limit);
}

// ==================== user_intents ====================

export async function fetchIntentRequesterAndKind(supabase: SupabaseClient, intentId: string) {
  return supabase.from('user_intents').select('requester_vitana_id, intent_kind').eq('intent_id', intentId).maybeSingle();
}

export async function fetchSourceIntent(supabase: SupabaseClient, intentId: string) {
  return supabase
    .from('user_intents')
    .select('intent_id, intent_kind, category, title, scope, kind_payload, requester_user_id, requester_vitana_id, tenant_id')
    .eq('intent_id', intentId)
    .maybeSingle();
}

export async function fetchIntentsByIds(supabase: SupabaseClient, intentIds: string[]) {
  return supabase
    .from('user_intents')
    .select('intent_id, intent_kind, category, title, scope, kind_payload, requester_user_id, requester_vitana_id, tenant_id')
    .in('intent_id', intentIds);
}

export async function fetchRecentIntents(supabase: SupabaseClient, requesterUserId: string, limit: number) {
  return supabase
    .from('user_intents')
    .select('intent_kind, title, created_at')
    .eq('requester_user_id', requesterUserId)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function countOpenIntentsExcludingUser(supabase: SupabaseClient, excludeUserId: string, statuses: string[]) {
  return supabase
    .from('user_intents')
    .select('intent_id', { count: 'exact', head: true })
    .neq('requester_user_id', excludeUserId)
    .in('status', statuses);
}

// ==================== life_compass_active_view ====================

export async function fetchLifeCompassCategory(supabase: SupabaseClient, userId: string) {
  return supabase.from('life_compass_active_view').select('category').eq('user_id', userId).maybeSingle();
}

// ==================== intent_matches ====================

export async function fetchRecentMatchOutcomes(supabase: SupabaseClient, vitanaIdA: string, limit: number) {
  return supabase
    .from('intent_matches')
    .select('kind_pairing, state, vitana_id_b')
    .eq('vitana_id_a', vitanaIdA)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function fetchSqlMatchesForIntent(supabase: SupabaseClient, intentAId: string, limit: number) {
  return supabase
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, vitana_id_a, vitana_id_b, score, kind_pairing, state')
    .eq('intent_a_id', intentAId)
    .order('score', { ascending: false })
    .limit(limit);
}

export async function upsertProfileFallbackMatches(supabase: SupabaseClient, rows: Array<Record<string, unknown>>) {
  return supabase
    .from('intent_matches')
    .upsert(rows, { onConflict: 'intent_a_id,external_target_kind,external_target_id', ignoreDuplicates: true });
}
