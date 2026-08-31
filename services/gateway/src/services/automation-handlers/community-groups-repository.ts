/**
 * automation-handlers/community-groups.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in automation-handlers/community-groups.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes
 * `supabase` as a param) — handlers receive their client via
 * `AutomationContext`, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== community_group_invitations ====================

export async function fetchPendingGroupInvites(supabase: SupabaseClient, tenantId: string, cutoffIso: string) {
  return supabase
    .from('community_group_invitations')
    .select('id, invited_user_id, group_id, invited_by')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .lte('created_at', cutoffIso)
    .limit(100);
}

// ==================== global_community_groups ====================

export async function fetchGroupNameById(supabase: SupabaseClient, groupId: string) {
  return supabase.from('global_community_groups').select('name').eq('id', groupId).maybeSingle();
}

export async function fetchGroupDetails(supabase: SupabaseClient, groupId: string) {
  return supabase.from('global_community_groups').select('name, description, created_by').eq('id', groupId).maybeSingle();
}

export async function fetchGroupWithCategory(supabase: SupabaseClient, groupId: string) {
  return supabase.from('global_community_groups').select('name, description, created_by, category').eq('id', groupId).maybeSingle();
}

export async function fetchRelatedPublicGroups(supabase: SupabaseClient, category: string, excludeGroupId: string) {
  return supabase
    .from('global_community_groups')
    .select('id, name')
    .eq('category', category)
    .eq('is_public', true)
    .neq('id', excludeGroupId)
    .limit(2);
}

export async function fetchGroupsWithCreator(supabase: SupabaseClient) {
  return supabase.from('global_community_groups').select('id, name, created_by').not('created_by', 'is', null);
}

export async function fetchApprovedGroupsWithMembers(supabase: SupabaseClient) {
  return supabase
    .from('global_community_groups')
    .select('id, name, created_by, member_count')
    .eq('status', 'approved')
    .not('created_by', 'is', null)
    .gte('member_count', 1)
    .limit(500);
}

export async function fetchExistingGroupByCategory(supabase: SupabaseClient, interest: string) {
  return supabase.from('global_community_groups').select('id').ilike('category', interest).limit(1).maybeSingle();
}

export async function insertGroup(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('global_community_groups').insert(row).select('id, name').single();
}

export async function fetchGroupsWithChatThread(supabase: SupabaseClient) {
  return supabase
    .from('global_community_groups')
    .select('id, name, created_by, chat_thread_id')
    .not('chat_thread_id', 'is', null)
    .not('created_by', 'is', null)
    .limit(500);
}

export async function fetchApprovedGroupsForHealth(supabase: SupabaseClient) {
  return supabase.from('global_community_groups').select('id, name, member_count').eq('status', 'approved').limit(1000);
}

// ==================== global_community_group_members ====================

export async function fetchGroupMemberCount(supabase: SupabaseClient, groupId: string) {
  return supabase.from('global_community_group_members').select('id', { count: 'exact', head: true }).eq('group_id', groupId);
}

export async function fetchGroupMembersOrderedByJoin(supabase: SupabaseClient, groupId: string, excludeUserId: string) {
  return supabase
    .from('global_community_group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .neq('user_id', excludeUserId)
    .order('joined_at', { ascending: true })
    .limit(50);
}

export async function countNewGroupMembers(supabase: SupabaseClient, groupId: string, sinceIso: string) {
  return supabase
    .from('global_community_group_members')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId)
    .gte('joined_at', sinceIso);
}

export async function insertGroupMembers(supabase: SupabaseClient, rows: Array<Record<string, unknown>>) {
  return supabase.from('global_community_group_members').insert(rows);
}

export async function fetchAllGroupMemberships(supabase: SupabaseClient) {
  return supabase.from('global_community_group_members').select('user_id, group_id').limit(5000);
}

export async function fetchSharedMemberships(supabase: SupabaseClient, userIds: string[]) {
  return supabase.from('global_community_group_members').select('group_id, user_id').in('user_id', userIds);
}

// ==================== app_users ====================

export async function fetchUserDisplayName(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('display_name').eq('user_id', userId).maybeSingle();
}

// ==================== global_community_events / global_event_participants ====================

export async function fetchUpcomingEventsForEncouragement(supabase: SupabaseClient, fromIso: string, toIso: string) {
  return supabase
    .from('global_community_events')
    .select('id, title, created_by, start_time, participant_count, max_participants')
    .gte('start_time', fromIso)
    .lte('start_time', toIso)
    .not('created_by', 'is', null);
}

export async function fetchEventAttendeesForConnect(supabase: SupabaseClient, eventId: string) {
  return supabase.from('global_event_participants').select('user_id').eq('event_id', eventId).eq('status', 'attending');
}

export async function fetchEventTitle(supabase: SupabaseClient, eventId: string) {
  return supabase.from('global_community_events').select('title').eq('id', eventId).maybeSingle();
}

// ==================== group_posts ====================

export async function fetchLastGroupPost(supabase: SupabaseClient, groupId: string) {
  return supabase.from('group_posts').select('created_at').eq('group_id', groupId).order('created_at', { ascending: false }).limit(1).maybeSingle();
}

// ==================== user_notifications ====================

export async function fetchRecentReviveNudge(supabase: SupabaseClient, userId: string, groupId: string, cutoffIso: string) {
  return supabase
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .eq('type', 'orb_proactive_message')
    .contains('data', { automation_id: 'AP-0211', group_id: groupId })
    .gte('created_at', cutoffIso)
    .limit(1);
}

export async function fetchRecentActivitySuggestion(supabase: SupabaseClient, userId: string, groupId: string, cutoffIso: string) {
  return supabase
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .contains('data', { automation_id: 'AP-0204', group_id: groupId })
    .gte('created_at', cutoffIso)
    .limit(1);
}

// ==================== user_interests ====================

export async function fetchInterestRows(supabase: SupabaseClient, minConfidence: number) {
  return supabase.from('user_interests').select('user_id, interest, confidence_score').gte('confidence_score', minConfidence).limit(2000);
}

// ==================== global_messages ====================

export async function countMessagesInThreadSince(supabase: SupabaseClient, threadId: string, sinceIso: string) {
  return supabase.from('global_messages').select('id', { count: 'exact', head: true }).eq('thread_id', threadId).gte('created_at', sinceIso);
}

// ==================== relationship_edges ====================

export async function fetchExistingConnectionEdge(supabase: SupabaseClient, tenantId: string, userA: string, userB: string) {
  return supabase
    .from('relationship_edges')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userA)
    .eq('target_type', 'person')
    .eq('target_id', userB)
    .limit(1);
}

export async function fetchConnectedEdges(supabase: SupabaseClient, tenantId: string, limit: number) {
  return supabase
    .from('relationship_edges')
    .select('source_id, target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('target_type', 'person')
    .eq('edge_type', 'connected')
    .limit(limit);
}
