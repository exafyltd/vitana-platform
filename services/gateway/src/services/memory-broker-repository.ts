/**
 * memory-broker.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in memory-broker.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param) — the broker receives its client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== app_users (IDENTITY) ====================

export async function fetchAppUserIdentity(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('app_users')
    .select('user_id, display_name, email, locale, vitana_id, profile')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
}

// ==================== mem_episodes (EPISODIC) ====================

export async function fetchMemEpisodesRecency(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  limit: number,
  cutoffIso: string | null,
) {
  let q = sb
    .from('mem_episodes')
    .select('id, kind, content, category_key, source, importance, occurred_at, actor_id, conversation_id')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .is('valid_to', null) // active rows only
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (cutoffIso) q = q.gte('occurred_at', cutoffIso);
  return q;
}

export async function rpcMemEpisodesSemanticSearch(
  sb: SupabaseClient,
  params: {
    p_query_embedding: string;
    p_top_k: number;
    p_tenant_id: string;
    p_user_id: string;
    p_workspace_scope: null;
    p_active_role: null;
    p_categories: null;
    p_visibility_scope: string;
    p_max_age_hours: number | null;
    p_recency_boost: boolean;
  },
) {
  return sb.rpc('mem_episodes_semantic_search', params);
}

// ==================== memory_items / memory_semantic_search (legacy EPISODIC fallback) ====================

export async function rpcMemorySemanticSearch(
  sb: SupabaseClient,
  params: {
    p_query_embedding: string;
    p_top_k: number;
    p_tenant_id: string;
    p_user_id: string;
    p_workspace_scope: null;
    p_active_role: null;
    p_categories: null;
    p_visibility_scope: string;
    p_max_age_hours: null;
    p_recency_boost: boolean;
  },
) {
  return sb.rpc('memory_semantic_search', params);
}

export async function fetchMemoryItemsLegacyRest(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  fetchLimit: number,
) {
  return sb
    .from('memory_items')
    .select('id, category_key, content, importance, occurred_at, source')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('importance', { ascending: false })
    .order('occurred_at', { ascending: false })
    .limit(fetchLimit);
}

// ==================== mem_facts (SEMANTIC) ====================

export async function fetchActiveMemFacts(sb: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return sb
    .from('mem_facts')
    .select('id, fact_key, fact_value, fact_value_type, entity, confidence, actor_id, asserted_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .is('valid_to', null)
    .order('asserted_at', { ascending: false })
    .limit(limit);
}

// ==================== vitana_index_scores (TRAJECTORY) ====================

export async function fetchTrajectoryScores(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  cutoffDate: string,
  limit: number,
) {
  return sb
    .from('vitana_index_scores')
    .select('date, score_total, score_sleep, score_nutrition, score_exercise, score_hydration, score_mental')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('date', cutoffDate)
    .order('date', { ascending: true })
    .limit(limit);
}

// ==================== relationship_edges / relationship_nodes (NETWORK) ====================

export async function fetchRelationshipEdgesForPerson(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  limit: number,
) {
  return sb
    .from('relationship_edges')
    .select('source_type, source_id, target_type, target_id, edge_type, strength, last_interaction_at')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userId)
    .order('strength', { ascending: false })
    .order('last_interaction_at', { ascending: false, nullsFirst: false })
    .limit(limit);
}

export async function fetchRelationshipNodesByIds(sb: SupabaseClient, nodeIds: string[]) {
  return sb.from('relationship_nodes').select('id, title, node_type').in('id', nodeIds);
}

// ==================== user_location_history / user_location_settings (LOCATION) ====================

export async function fetchCurrentLocationHistory(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('user_location_history')
    .select('location_type, locality, country, timezone, source, valid_from')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .is('valid_to', null)
    .order('valid_from', { ascending: false })
    .limit(1);
}

export async function fetchNamedLocationSettings(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('user_location_settings')
    .select('name, locality, country, timezone, user_confirmed')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('is_primary_home', { ascending: false })
    .limit(20);
}

// ==================== biometric_trends / biometric_events (BIOMETRICS) ====================

export async function fetchBiometricTrends(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('biometric_trends')
    .select('feature_key, pillar, trend_class, latest, mean_30d, anomaly_flag')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('computed_at', { ascending: false })
    .limit(20);
}

export async function fetchActiveBiometricEvents(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('biometric_events')
    .select('event_type, feature_key, pillar, observed_at, detail')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .is('acknowledged_at', null)
    .order('observed_at', { ascending: false })
    .limit(10);
}

// ==================== memory_diary_entries (DIARY) ====================

export async function fetchDiaryEntriesSince(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  cutoffIso: string,
  limit: number,
) {
  return sb
    .from('memory_diary_entries')
    .select('id, occurred_at, category_key, content')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('occurred_at', cutoffIso)
    .order('occurred_at', { ascending: false })
    .limit(limit);
}

// ==================== autopilot_recommendations / user_proactive_pause (GOVERNANCE) ====================

export async function fetchDismissedAutopilotRecommendations(
  sb: SupabaseClient,
  userId: string,
  statuses: string[],
  cooldownStartIso: string,
) {
  return sb
    .from('autopilot_recommendations')
    .select('id, title, domain, status, snoozed_until, expires_at, signal_fingerprint, updated_at')
    .eq('user_id', userId)
    .in('status', statuses)
    .gte('updated_at', cooldownStartIso)
    .order('updated_at', { ascending: false })
    .limit(50);
}

export async function fetchUserProactivePauses(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_proactive_pause')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
}

// ==================== user_feature_introductions (PROGRESSION) ====================

export async function fetchUserFeatureIntroductions(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_feature_introductions')
    .select('feature_key, introduced_at, channel')
    .eq('user_id', userId)
    .order('introduced_at', { ascending: false })
    .limit(50);
}
