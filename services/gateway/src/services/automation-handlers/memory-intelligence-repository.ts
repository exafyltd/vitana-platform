/**
 * automation-handlers/memory-intelligence.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * automation-handlers/memory-intelligence.ts now goes through here instead
 * of being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no behavior
 * change today. Client-agnostic (takes `supabase` as a param) — handlers
 * receive their client via `AutomationContext`, not a module-level
 * singleton. Same convention as the sibling `community-groups-repository.ts`
 * / `engagement-events-repository.ts` in this directory.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== daily_matches ====================

export async function fetchDailyMatchById(supabase: SupabaseClient, matchId: string) {
  return supabase.from('daily_matches').select('id').eq('id', matchId).maybeSingle();
}

// ==================== memory_facts ====================

export async function fetchRecentSelfFactValues(supabase: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return supabase
    .from('memory_facts')
    .select('fact_value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('entity', 'self')
    .is('superseded_at', null)
    .order('extracted_at', { ascending: false })
    .limit(limit);
}

export async function countRecentFactsForUser(supabase: SupabaseClient, tenantId: string, userId: string, sinceIso: string) {
  return supabase
    .from('memory_facts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('extracted_at', sinceIso);
}

export async function fetchRecentActiveFacts(supabase: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return supabase
    .from('memory_facts')
    .select('fact_key, fact_value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .is('superseded_at', null)
    .order('extracted_at', { ascending: false })
    .limit(limit);
}

export async function fetchUserIdsWithRecentFacts(supabase: SupabaseClient, tenantId: string, sinceIso: string, limit: number) {
  return supabase
    .from('memory_facts')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .is('superseded_at', null)
    .gt('extracted_at', sinceIso)
    .limit(limit);
}

export async function fetchExistingPreferenceFacts(supabase: SupabaseClient, tenantId: string, userIds: string[]) {
  return supabase
    .from('memory_facts')
    .select('user_id, fact_key, fact_value')
    .eq('tenant_id', tenantId)
    .in('user_id', userIds)
    .like('fact_key', 'user_preference_%')
    .is('superseded_at', null);
}

export async function fetchNameFactsForGraphProjection(supabase: SupabaseClient, tenantId: string, limit: number) {
  return supabase
    .from('memory_facts')
    .select('user_id, fact_key, fact_value, extracted_at')
    .eq('tenant_id', tenantId)
    .is('superseded_at', null)
    .like('fact_key', '%name%')
    .limit(limit);
}

export async function fetchFactsMissingEmbedding(supabase: SupabaseClient, tenantId: string, limit: number) {
  return supabase
    .from('memory_facts')
    .select('id, fact_key, fact_value')
    .eq('tenant_id', tenantId)
    .is('superseded_at', null)
    .is('embedding', null)
    .limit(limit);
}

export async function updateFactEmbedding(
  supabase: SupabaseClient,
  rowId: string,
  patch: { embedding: string; embedding_model: string; embedding_updated_at: string },
) {
  return supabase.from('memory_facts').update(patch).eq('id', rowId);
}

export async function fetchAllActiveFactUserIds(supabase: SupabaseClient, tenantId: string, limit: number) {
  return supabase.from('memory_facts').select('user_id').eq('tenant_id', tenantId).is('superseded_at', null).limit(limit);
}

// ==================== write_fact RPC ====================

export async function rpcWriteFact(
  supabase: SupabaseClient,
  args: {
    p_tenant_id: string;
    p_user_id: string;
    p_fact_key: string;
    p_fact_value: string;
    p_entity: string;
    p_fact_value_type: string;
    p_provenance_source: string;
    p_provenance_confidence: number;
  },
) {
  return supabase.rpc('write_fact', args);
}

// ==================== knowledge_docs ====================

export async function fetchKnowledgeDocByTags(supabase: SupabaseClient, tags: string[], limit: number) {
  return supabase.from('knowledge_docs').select('id, title, path').overlaps('tags', tags).limit(limit);
}

// ==================== calendar_events ====================

export async function fetchCalendarEventUserIdsSince(supabase: SupabaseClient, sinceIso: string, limit: number) {
  return supabase.from('calendar_events').select('user_id').gte('start_time', sinceIso).not('user_id', 'is', null).limit(limit);
}

// ==================== user_assistant_state ====================

export async function fetchAssistantStateSignal(supabase: SupabaseClient, tenantId: string, userId: string, signalName: string) {
  return supabase
    .from('user_assistant_state')
    .select('value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('signal_name', signalName)
    .maybeSingle();
}

// ==================== user_routines ====================

export async function fetchHighConfidenceRoutines(supabase: SupabaseClient, minConfidence: number, limit: number) {
  return supabase
    .from('user_routines')
    .select('user_id, routine_kind, confidence, metadata')
    .gte('confidence', minConfidence)
    .order('confidence', { ascending: false })
    .limit(limit);
}

// ==================== relationship_nodes ====================

export async function fetchExistingPersonNode(supabase: SupabaseClient, tenantId: string, name: string, ownerUserId: string) {
  return supabase
    .from('relationship_nodes')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('node_type', 'person')
    .eq('title', name)
    .eq('metadata->>owner_user_id', ownerUserId)
    .maybeSingle();
}

export async function insertPersonNode(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('relationship_nodes').insert(row).select('id').single();
}

// ==================== relationship_edges ====================

export async function fetchExistingSuggestedEdge(supabase: SupabaseClient, tenantId: string, sourceId: string, targetId: string) {
  return supabase
    .from('relationship_edges')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', sourceId)
    .eq('target_type', 'person')
    .eq('target_id', targetId)
    .eq('edge_type', 'suggested')
    .maybeSingle();
}

export async function updateEdgeLastInteraction(supabase: SupabaseClient, edgeId: string, lastInteractionAt: string, updatedAt: string) {
  return supabase.from('relationship_edges').update({ last_interaction_at: lastInteractionAt, updated_at: updatedAt }).eq('id', edgeId);
}

export async function insertRelationshipEdge(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('relationship_edges').insert(row);
}

export async function fetchExistingConnectedEdge(supabase: SupabaseClient, tenantId: string, sourceId: string, targetId: string) {
  return supabase
    .from('relationship_edges')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', sourceId)
    .eq('target_type', 'person')
    .eq('target_id', targetId)
    .eq('edge_type', 'connected')
    .maybeSingle();
}

// ==================== user_follows ====================

export async function fetchFollowPairs(supabase: SupabaseClient, limit: number) {
  return supabase.from('user_follows').select('follower_id, following_id').limit(limit);
}

// ==================== vitana_index_scores ====================

export async function fetchRecentIndexScores(supabase: SupabaseClient, tenantId: string, sinceDate: string, limit: number) {
  return supabase
    .from('vitana_index_scores')
    .select('user_id, date, score_sleep, score_nutrition, score_exercise, score_hydration, score_mental')
    .eq('tenant_id', tenantId)
    .gte('date', sinceDate)
    .order('date', { ascending: true })
    .limit(limit);
}

// ==================== diary_entries ====================

export async function fetchRecentDiaryEntries(supabase: SupabaseClient, sinceIso: string, limit: number) {
  return supabase.from('diary_entries').select('user_id, created_at').gte('created_at', sinceIso).limit(limit);
}

// ==================== profile_posts ====================

export async function fetchRecentPostsForCapture(supabase: SupabaseClient, sinceIso: string, limit: number) {
  return supabase
    .from('profile_posts')
    .select('id, user_id, content, created_at')
    .gte('created_at', sinceIso)
    .neq('moderation_status', 'rejected')
    .order('created_at', { ascending: true })
    .limit(limit);
}

// ==================== memory_items ====================

export async function fetchMirroredPostIds(supabase: SupabaseClient, tenantId: string, postIds: string[]) {
  return supabase
    .from('memory_items')
    .select('content_json')
    .eq('tenant_id', tenantId)
    .filter('content_json->>post_id', 'in', `(${postIds.join(',')})`);
}
