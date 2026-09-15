/**
 * automation-handlers/connect-people.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in automation-handlers/connect-people.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes
 * `supabase` as a param) — handlers receive their client via
 * `AutomationContext`, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_tenants ====================

export async function fetchPrimaryTenantUsers(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('user_tenants').select('user_id').eq('tenant_id', tenantId).eq('is_primary', true);
}

// ==================== user_notification_preferences ====================

export async function fetchNotificationPrefs(supabase: SupabaseClient, tenantId: string, userId: string) {
  return supabase
    .from('user_notification_preferences')
    .select('push_enabled, match_notifications')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .maybeSingle();
}

// ==================== daily_matches ====================

export async function countTodaysUnviewedMatches(supabase: SupabaseClient, userId: string, sinceIso: string) {
  return supabase
    .from('daily_matches')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .is('viewed_at', null);
}

export async function fetchTopMatch(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('daily_matches')
    .select('matched_user_id, match_score')
    .eq('user_id', userId)
    .order('match_score', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchMatchById(supabase: SupabaseClient, matchId: string) {
  return supabase.from('daily_matches').select('user_id, matched_user_id').eq('id', matchId).maybeSingle();
}

export async function fetchReciprocalAcceptedMatch(supabase: SupabaseClient, otherUserId: string, userId: string) {
  return supabase
    .from('daily_matches')
    .select('id')
    .eq('user_id', otherUserId)
    .eq('matched_user_id', userId)
    .eq('action', 'accepted')
    .maybeSingle();
}

// ==================== user_interests ====================

export async function fetchTopUserInterests(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase.from('user_interests').select('interest, confidence_score').eq('user_id', userId).order('confidence_score', { ascending: false }).limit(limit);
}

export async function fetchUserInterestNames(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase.from('user_interests').select('interest').eq('user_id', userId).order('confidence_score', { ascending: false }).limit(limit);
}

// ==================== app_users ====================

export async function fetchUserDisplayName(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('display_name').eq('user_id', userId).maybeSingle();
}

export async function fetchUserDisplayNamesIn(supabase: SupabaseClient, userIds: string[]) {
  return supabase.from('app_users').select('display_name').in('user_id', userIds);
}

// ==================== relationship_edges ====================

export async function countUserConnections(supabase: SupabaseClient, tenantId: string, userId: string) {
  return supabase
    .from('relationship_edges')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userId)
    .eq('edge_type', 'connected');
}

export async function upsertConnectionEdge(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('relationship_edges').upsert(row, {
    onConflict: 'tenant_id,source_type,source_id,target_type,target_id,edge_type',
  });
}

export async function fetchRecentConnectedEdges(supabase: SupabaseClient, tenantId: string, sinceIso: string, untilIso: string) {
  return supabase
    .from('relationship_edges')
    .select('source_id, target_id, metadata')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('target_type', 'person')
    .eq('edge_type', 'connected')
    .gte('created_at', sinceIso)
    .lte('created_at', untilIso)
    .limit(50);
}

export async function fetchConnectionTargetIds(supabase: SupabaseClient, tenantId: string, userId: string) {
  return supabase
    .from('relationship_edges')
    .select('target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userId)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected');
}

// ==================== chat_messages ====================

export async function countMessagesBetween(supabase: SupabaseClient, tenantId: string, idA: string, idB: string) {
  return supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .or(`sender_id.eq.${idA},sender_id.eq.${idB}`)
    .or(`receiver_id.eq.${idA},receiver_id.eq.${idB}`)
    .limit(1);
}

// ==================== group_recommendations ====================

export async function fetchGroupRecommendations(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('group_recommendations')
    .select('id, group_id, match_score')
    .eq('user_id', userId)
    .eq('is_dismissed', false)
    .order('match_score', { ascending: false })
    .limit(3);
}

// ==================== global_community_group_members ====================

export async function fetchGroupMembersAmong(supabase: SupabaseClient, groupId: string, userIds: string[]) {
  return supabase.from('global_community_group_members').select('user_id').eq('group_id', groupId).in('user_id', userIds);
}

// ==================== contextual_opportunities ====================

export async function fetchPeerOpportunities(
  supabase: SupabaseClient,
  tenantId: string,
  opportunityType: string,
  userIds: string[]
) {
  return supabase
    .from('contextual_opportunities')
    .select('id, user_id', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('opportunity_type', opportunityType)
    .in('user_id', userIds)
    .in('status', ['active', 'engaged'])
    .limit(10);
}
