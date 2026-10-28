/**
 * orb-tools/groups-events-tools.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in orb-tools/
 * groups-events-tools.ts now goes through here instead of being written
 * inline. PURE MOVE, not a rewrite: same queries, same columns, same
 * conditional-filter logic, same return shapes — no behavior change
 * today. Client-agnostic (takes `sb` as a param) — tools receive their
 * client per-call, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const GROUP_COLS = 'id, name, description, member_count, is_public';
const EVENT_COLS = 'id, title, start_time, location, participant_count, max_participants';

// ==================== app_users ====================

export async function fetchUserTenantId(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('tenant_id').eq('user_id', userId).maybeSingle();
}

// ==================== global_community_groups ====================

export async function fetchGroupById(sb: SupabaseClient, groupId: string) {
  return sb.from('global_community_groups').select(GROUP_COLS).eq('id', groupId).eq('status', 'approved').maybeSingle();
}

export async function searchGroupsByName(sb: SupabaseClient, query: string) {
  return sb
    .from('global_community_groups')
    .select(GROUP_COLS)
    .eq('status', 'approved')
    .ilike('name', `%${query}%`)
    .order('member_count', { ascending: false })
    .limit(5);
}

export async function fetchGroupsByIds(sb: SupabaseClient, ids: string[]) {
  return sb.from('global_community_groups').select(GROUP_COLS).in('id', ids);
}

export async function fetchGroupNamesByIds(sb: SupabaseClient, ids: string[]) {
  return sb.from('global_community_groups').select('id, name').in('id', ids);
}

export async function fetchGroupsCreatedBy(sb: SupabaseClient, userId: string) {
  return sb.from('global_community_groups').select(GROUP_COLS).eq('created_by', userId).eq('status', 'approved');
}

export async function insertGroup(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('global_community_groups').insert(row).select('id, name').single();
}

export async function updateEventParticipantCount(sb: SupabaseClient, eventId: string, count: number) {
  return sb.from('global_community_events').update({ participant_count: count }).eq('id', eventId);
}

// ==================== global_community_group_members ====================

export async function fetchMembership(sb: SupabaseClient, groupId: string, userId: string) {
  return sb.from('global_community_group_members').select('id').eq('group_id', groupId).eq('user_id', userId).maybeSingle();
}

export async function insertMembership(sb: SupabaseClient, groupId: string, userId: string, role: string) {
  return sb.from('global_community_group_members').insert({ group_id: groupId, user_id: userId, role });
}

export async function fetchUserGroupMemberships(sb: SupabaseClient, userId: string) {
  return sb
    .from('global_community_group_members')
    .select('group_id, role, joined_at')
    .eq('user_id', userId)
    .order('joined_at', { ascending: false })
    .limit(25);
}

// ==================== community_group_invitations ====================

export async function insertGroupInvitation(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('community_group_invitations').insert(row);
}

export async function fetchPendingInvitationsForUser(sb: SupabaseClient, userId: string) {
  return sb
    .from('community_group_invitations')
    .select('id, group_id, invited_by, message, created_at')
    .eq('invited_user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);
}

export async function updateInvitationStatus(
  sb: SupabaseClient,
  invitationId: string,
  userId: string,
  fields: Record<string, unknown>
) {
  return sb.from('community_group_invitations').update(fields).eq('id', invitationId).eq('invited_user_id', userId);
}

// ==================== resolve_recipient_candidates (RPC) ====================

export async function resolveRecipientCandidates(
  sb: SupabaseClient,
  params: { p_actor: string; p_token: string; p_limit: number; p_global: boolean }
) {
  return sb.rpc('resolve_recipient_candidates', params);
}

// ==================== global_community_events ====================

export async function fetchEventById(sb: SupabaseClient, eventId: string) {
  return sb.from('global_community_events').select(EVENT_COLS).eq('id', eventId).maybeSingle();
}

export async function searchUpcomingEventsByTitle(sb: SupabaseClient, query: string) {
  return sb
    .from('global_community_events')
    .select(EVENT_COLS)
    .gte('start_time', new Date().toISOString())
    .ilike('title', `%${query}%`)
    .order('start_time', { ascending: true })
    .limit(5);
}

export async function fetchEventsByIdsUpcoming(sb: SupabaseClient, ids: string[]) {
  return sb
    .from('global_community_events')
    .select(EVENT_COLS)
    .in('id', ids)
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true });
}

export async function fetchUpcomingEvents(sb: SupabaseClient, limit: number) {
  return sb
    .from('global_community_events')
    .select(EVENT_COLS)
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true })
    .limit(limit);
}

// ==================== global_event_participants ====================

export async function fetchEventParticipation(sb: SupabaseClient, eventId: string, userId: string) {
  return sb.from('global_event_participants').select('id, status').eq('event_id', eventId).eq('user_id', userId).maybeSingle();
}

export async function upsertEventParticipation(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('global_event_participants').upsert(row, { onConflict: 'event_id,user_id' });
}

export async function fetchUserAttendingEventIds(sb: SupabaseClient, userId: string) {
  return sb.from('global_event_participants').select('event_id').eq('user_id', userId).eq('status', 'attending');
}

export async function deleteEventParticipation(sb: SupabaseClient, eventId: string, userId: string) {
  return sb.from('global_event_participants').delete().eq('event_id', eventId).eq('user_id', userId);
}

export async function fetchUserAttendingAmong(sb: SupabaseClient, userId: string, eventIds: string[]) {
  return sb
    .from('global_event_participants')
    .select('event_id')
    .eq('user_id', userId)
    .eq('status', 'attending')
    .in('event_id', eventIds);
}

// ==================== location_preferences ====================

export async function fetchUserHomeCity(sb: SupabaseClient, userId: string) {
  return sb.from('location_preferences').select('home_city').eq('user_id', userId).maybeSingle();
}

// ==================== live_rooms ====================

export async function fetchLiveRoomById(sb: SupabaseClient, tenantId: string, roomId: string) {
  return sb
    .from('live_rooms')
    .select('id, title, starts_at, status')
    .eq('tenant_id', tenantId)
    .eq('id', roomId)
    .in('status', ['scheduled', 'live'])
    .maybeSingle();
}

export async function searchLiveRoomsQuery(sb: SupabaseClient, tenantId: string, query: string) {
  let q = sb
    .from('live_rooms')
    .select('id, title, starts_at, status')
    .eq('tenant_id', tenantId)
    .in('status', ['scheduled', 'live'])
    .order('starts_at', { ascending: true })
    .limit(5);
  if (query) q = q.ilike('title', `%${query}%`);
  return q;
}
