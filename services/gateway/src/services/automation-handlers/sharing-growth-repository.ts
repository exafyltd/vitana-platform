/**
 * automation-handlers/sharing-growth.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * automation-handlers/sharing-growth.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `supabase` as a param) —
 * handlers receive their client via `AutomationContext`, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== sharing_links (shared insert across every handler) ====================

export async function insertSharingLink(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('sharing_links').insert(row);
}

export async function fetchExistingSocialCard(supabase: SupabaseClient, eventId: string) {
  return supabase
    .from('sharing_links')
    .select('id')
    .eq('target_type', 'event')
    .eq('target_id', eventId)
    .eq('utm_campaign', 'event_social_card')
    .limit(1);
}

// ==================== global_community_events / global_event_participants ====================

export async function fetchEventForShare(supabase: SupabaseClient, eventId: string) {
  return supabase.from('global_community_events').select('title, start_time').eq('id', eventId).maybeSingle();
}

export async function fetchEventRsvpCount(supabase: SupabaseClient, eventId: string) {
  return supabase
    .from('global_event_participants')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .eq('status', 'attending');
}

export async function fetchUpcomingEventsInWindow(supabase: SupabaseClient, fromIso: string, toIso: string) {
  return supabase.from('global_community_events').select('id, title').gte('start_time', fromIso).lte('start_time', toIso);
}

export async function fetchEventAttendees(supabase: SupabaseClient, eventId: string) {
  return supabase
    .from('global_event_participants')
    .select('user_id', { count: 'exact' })
    .eq('event_id', eventId)
    .eq('status', 'attending');
}

export async function fetchRecentEventsWithCreator(supabase: SupabaseClient, sinceIso: string) {
  return supabase
    .from('global_community_events')
    .select('id, title, start_time, created_by, participant_count, slug')
    .not('created_by', 'is', null)
    .gte('created_at', sinceIso)
    .limit(200);
}

export async function fetchTopUpcomingEvent(supabase: SupabaseClient, fromIso: string, toIso: string) {
  return supabase
    .from('global_community_events')
    .select('id, title, participant_count')
    .gte('start_time', fromIso)
    .lte('start_time', toIso)
    .order('participant_count', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function upsertEventParticipant(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('global_event_participants').upsert(row, { onConflict: 'event_id,user_id' });
}

export async function countUserEventsJoined(supabase: SupabaseClient, userId: string, sinceIso: string) {
  return supabase
    .from('global_event_participants')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('registered_at', sinceIso);
}

// ==================== global_community_groups / global_community_group_members ====================

export async function fetchGroupForShare(supabase: SupabaseClient, groupId: string) {
  return supabase.from('global_community_groups').select('name, category').eq('id', groupId).maybeSingle();
}

export async function fetchGroupMemberCount(supabase: SupabaseClient, groupId: string) {
  return supabase.from('global_community_group_members').select('id', { count: 'exact', head: true }).eq('group_id', groupId);
}

export async function fetchGroupName(supabase: SupabaseClient, groupId: string) {
  return supabase.from('global_community_groups').select('name').eq('id', groupId).maybeSingle();
}

export async function fetchNewGroupMemberships(supabase: SupabaseClient, sinceIso: string) {
  return supabase.from('global_community_group_members').select('group_id').gte('joined_at', sinceIso).limit(5000);
}

export async function countUserGroupsJoined(supabase: SupabaseClient, userId: string, sinceIso: string) {
  return supabase
    .from('global_community_group_members')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('joined_at', sinceIso);
}

// ==================== referrals ====================

export async function updateReferralToSignedUp(supabase: SupabaseClient, tenantId: string, referrerId: string, referredId: string) {
  return supabase
    .from('referrals')
    .update({ referred_id: referredId, status: 'signed_up' })
    .eq('tenant_id', tenantId)
    .eq('referrer_id', referrerId)
    .eq('status', 'created')
    .order('created_at', { ascending: false })
    .limit(1)
    .select('id');
}

export async function insertReferral(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('referrals').insert(row);
}

// ==================== app_users ====================

export async function fetchUserDisplayName(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('display_name').eq('user_id', userId).maybeSingle();
}

// ==================== wallet ====================

export async function incrementWalletBalance(supabase: SupabaseClient, params: { p_user_id: string; p_currency_type: string; p_amount: number }) {
  return supabase.rpc('increment_wallet_balance', params);
}

// ==================== relationship_edges ====================

export async function upsertRelationshipEdge(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('relationship_edges').upsert(row, {
    onConflict: 'tenant_id,source_type,source_id,target_type,target_id,edge_type',
  });
}

export async function countUserConnections(supabase: SupabaseClient, tenantId: string, userId: string) {
  return supabase
    .from('relationship_edges')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userId)
    .eq('target_type', 'person');
}

// ==================== user_interests ====================

export async function countUserInterests(supabase: SupabaseClient, userId: string) {
  return supabase.from('user_interests').select('id', { count: 'exact', head: true }).eq('user_id', userId);
}

// ==================== daily_matches ====================

export async function fetchMatchUser(supabase: SupabaseClient, matchId: string) {
  return supabase.from('daily_matches').select('user_id').eq('id', matchId).maybeSingle();
}

export async function countUserMatchesViewed(supabase: SupabaseClient, userId: string, sinceIso: string) {
  return supabase
    .from('daily_matches')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .not('viewed_at', 'is', null);
}

// ==================== chat_messages ====================

export async function countUserMessagesSent(supabase: SupabaseClient, tenantId: string, userId: string, sinceIso: string) {
  return supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('sender_id', userId)
    .gte('created_at', sinceIso);
}

// ==================== user_notifications ====================

export async function fetchRecentInviteWave(supabase: SupabaseClient, userId: string, cutoffIso: string) {
  return supabase
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .contains('data', { automation_id: 'AP-0411' })
    .gte('created_at', cutoffIso)
    .limit(1);
}
