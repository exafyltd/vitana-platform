/**
 * routes/tenant-admin/community-admin.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/tenant-admin/community-admin.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== global_community_events ====================

export async function fetchUpcomingCommunityEvents(sb: SupabaseClient, limit: number) {
  return sb.from('global_community_events').select('*').order('start_time', { ascending: true }).limit(limit);
}

export async function deleteCommunityEvent(sb: SupabaseClient, eventId: string) {
  return sb.from('global_community_events').delete().eq('id', eventId);
}

export async function countCommunityEvents(sb: SupabaseClient) {
  return sb.from('global_community_events').select('id', { count: 'exact', head: true });
}

// ==================== app_users ====================

export async function fetchAppUserProfilesByIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('app_users').select('user_id, email, display_name, avatar_url:profile->>avatar_url').in('user_id', userIds);
}

// ==================== event_ticket_types ====================

export async function fetchTicketTypesByEventIds(sb: SupabaseClient, eventIds: string[]) {
  return sb
    .from('event_ticket_types')
    .select('event_id, name, price, currency, quantity_available, quantity_sold')
    .in('event_id', eventIds);
}

// ==================== global_community_groups ====================

export async function fetchRecentCommunityGroups(sb: SupabaseClient, limit: number) {
  return sb.from('global_community_groups').select('*').order('created_at', { ascending: false }).limit(limit);
}

export async function countCommunityGroups(sb: SupabaseClient) {
  return sb.from('global_community_groups').select('id', { count: 'exact', head: true });
}

// ==================== live_rooms ====================

export async function fetchRecentLiveRooms(sb: SupabaseClient, limit: number) {
  return sb.from('live_rooms').select('*').order('created_at', { ascending: false }).limit(limit);
}

export async function countLiveRooms(sb: SupabaseClient) {
  return sb.from('live_rooms').select('id', { count: 'exact', head: true });
}

// ==================== creator_profiles ====================

export async function fetchRecentCreatorProfiles(sb: SupabaseClient, limit: number) {
  return sb.from('creator_profiles').select('*').order('created_at', { ascending: false }).limit(limit);
}

// ==================== community_memberships ====================

export async function fetchRecentCommunityMemberships(sb: SupabaseClient, limit: number) {
  return sb.from('community_memberships').select('*').order('created_at', { ascending: false }).limit(limit);
}

// ==================== global_community_group_members ====================

export async function countCommunityGroupMembers(sb: SupabaseClient) {
  return sb.from('global_community_group_members').select('id', { count: 'exact', head: true });
}
