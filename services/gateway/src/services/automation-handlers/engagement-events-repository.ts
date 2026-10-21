/**
 * automation-handlers/engagement-events.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in automation-handlers/engagement-events.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes
 * `supabase` as a param) — handlers receive their client via
 * `AutomationContext`, not a module-level singleton. Same convention as the
 * sibling `community-groups-repository.ts` in this directory.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== relationship_edges ====================

export async function fetchUserConnectionEdges(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  limit: number,
) {
  return supabase
    .from('relationship_edges')
    .select('target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userId)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected')
    .limit(limit);
}

// ==================== global_event_participants ====================

export async function fetchAttendingConnectionsForEvent(
  supabase: SupabaseClient,
  eventId: string,
  userIds: string[],
) {
  return supabase
    .from('global_event_participants')
    .select('user_id')
    .eq('event_id', eventId)
    .in('user_id', userIds)
    .eq('status', 'attending');
}

export async function fetchAttendingParticipants(supabase: SupabaseClient, eventId: string) {
  return supabase.from('global_event_participants').select('user_id').eq('event_id', eventId).eq('status', 'attending');
}

export async function countUserRegisteredForEvent(supabase: SupabaseClient, eventId: string, userId: string) {
  return supabase
    .from('global_event_participants')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .eq('user_id', userId);
}

// ==================== app_users ====================

export async function fetchUserDisplayName(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('display_name').eq('user_id', userId).maybeSingle();
}

// ==================== global_community_events ====================

export async function fetchEndedEventsInWindow(
  supabase: SupabaseClient,
  windowStartIso: string,
  windowEndIso: string,
  limit: number,
) {
  return supabase
    .from('global_community_events')
    .select('id, title')
    .gte('end_time', windowStartIso)
    .lte('end_time', windowEndIso)
    .limit(limit);
}

export async function fetchTrendingUpcomingEvents(
  supabase: SupabaseClient,
  fromIso: string,
  toIso: string,
  limit: number,
) {
  return supabase
    .from('global_community_events')
    .select('id, title, start_time, participant_count')
    .gte('start_time', fromIso)
    .lte('start_time', toIso)
    .order('participant_count', { ascending: false })
    .limit(limit);
}

export async function fetchUpcomingEventsForConcierge(
  supabase: SupabaseClient,
  leadCutoffIso: string,
  horizonCutoffIso: string,
  limit: number,
) {
  return supabase
    .from('global_community_events')
    .select('id, title, start_time, participant_count, max_participants, created_by, slug')
    .gte('start_time', leadCutoffIso)
    .lte('start_time', horizonCutoffIso)
    .not('created_by', 'is', null)
    .order('start_time', { ascending: true })
    .limit(limit);
}

export async function fetchPastPopularEvents(
  supabase: SupabaseClient,
  beforeIso: string,
  minParticipants: number,
  limit: number,
) {
  return supabase
    .from('global_community_events')
    .select('id, title, created_by, participant_count, end_time')
    .lt('end_time', beforeIso)
    .gte('participant_count', minParticipants)
    .not('created_by', 'is', null)
    .order('end_time', { ascending: false })
    .limit(limit);
}

export async function countUpcomingEventsByCreator(supabase: SupabaseClient, createdBy: string, afterIso: string) {
  return supabase
    .from('global_community_events')
    .select('id', { count: 'exact', head: true })
    .eq('created_by', createdBy)
    .gt('start_time', afterIso);
}

// ==================== global_community_groups ====================

export async function fetchGroupsWithChatThreadForTrending(supabase: SupabaseClient, limit: number) {
  return supabase
    .from('global_community_groups')
    .select('id, name, created_by, chat_thread_id')
    .not('chat_thread_id', 'is', null)
    .not('created_by', 'is', null)
    .limit(limit);
}

// ==================== global_messages ====================

export async function countRecentGroupMessages(supabase: SupabaseClient, threadId: string, sinceIso: string) {
  return supabase
    .from('global_messages')
    .select('id', { count: 'exact', head: true })
    .eq('thread_id', threadId)
    .gte('created_at', sinceIso);
}

// ==================== user_notifications ====================

export async function fetchRecentConciergeNudge(supabase: SupabaseClient, userId: string, cooldownCutoffIso: string) {
  return supabase
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .eq('type', 'orb_proactive_message')
    .contains('data', { automation_id: 'AP-0309' })
    .gte('created_at', cooldownCutoffIso)
    .limit(1);
}

export async function fetchRecentSeriesSuggestion(supabase: SupabaseClient, userId: string, cooldownCutoffIso: string) {
  return supabase
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .contains('data', { automation_id: 'AP-0306' })
    .gte('created_at', cooldownCutoffIso)
    .limit(1);
}

export async function fetchRecentLiveRoomSuggestion(
  supabase: SupabaseClient,
  userId: string,
  groupId: string,
  cooldownCutoffIso: string,
) {
  return supabase
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .contains('data', { automation_id: 'AP-0307', group_id: groupId })
    .gte('created_at', cooldownCutoffIso)
    .limit(1);
}

export async function countRecentReadNotifications(supabase: SupabaseClient, userId: string, sinceIso: string) {
  return supabase
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .not('read_at', 'is', null)
    .gte('read_at', sinceIso);
}

export async function fetchRecentStreakNudge(
  supabase: SupabaseClient,
  userId: string,
  pairKey: string,
  cooldownCutoffIso: string,
) {
  return supabase
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .contains('data', { automation_id: 'AP-0511', pair_key: pairKey })
    .gte('created_at', cooldownCutoffIso)
    .limit(1);
}

// ==================== user_tenants ====================

export async function fetchPrimaryTenantUsers(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('user_tenants').select('user_id').eq('tenant_id', tenantId).eq('is_primary', true);
}

export async function fetchPrimaryTenantUsersLimited(supabase: SupabaseClient, tenantId: string, limit: number) {
  return supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true)
    .limit(limit);
}

// ==================== daily_matches ====================

export async function countRecentDailyMatches(supabase: SupabaseClient, userId: string, sinceIso: string) {
  return supabase
    .from('daily_matches')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', sinceIso);
}

// ==================== chat_messages ====================

export async function fetchQuietConversations(
  supabase: SupabaseClient,
  tenantId: string,
  fromIso: string,
  toIso: string,
  limit: number,
) {
  return supabase
    .from('chat_messages')
    .select('sender_id, receiver_id')
    .eq('tenant_id', tenantId)
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .limit(limit);
}

export async function countRecentMessagesBetweenPair(
  supabase: SupabaseClient,
  tenantId: string,
  userA: string,
  userB: string,
  sinceIso: string,
) {
  return supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .or(`sender_id.eq.${userA},sender_id.eq.${userB}`)
    .or(`receiver_id.eq.${userA},receiver_id.eq.${userB}`)
    .gte('created_at', sinceIso);
}

// ==================== user_diary_streak ====================

export async function fetchUserStreak(supabase: SupabaseClient, userId: string) {
  return supabase.from('user_diary_streak').select('current_streak_days, last_day').eq('user_id', userId).maybeSingle();
}
