// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/community.ts — zero coverage
// today.
/**
 * services/admin-scanners/community.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/community.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes, same call
 * order — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countUpcomingCommunityEvents(sb: SupabaseClient, tenantId: string, fromIso: string, untilIso: string) {
  return sb
    .from('global_community_events')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('start_time', fromIso)
    .lt('start_time', untilIso);
}

export async function fetchCommunityGroupsCreatedBefore(sb: SupabaseClient, tenantId: string, beforeIso: string) {
  return sb.from('global_community_groups').select('id, name, created_at').eq('tenant_id', tenantId).lt('created_at', beforeIso);
}

export async function fetchRecentCommunityMemberships(sb: SupabaseClient, groupIds: string[], sinceIso: string) {
  return sb.from('community_memberships').select('group_id').in('group_id', groupIds).gte('created_at', sinceIso);
}

export async function fetchUpcomingLiveRooms(sb: SupabaseClient, tenantId: string, fromIso: string, untilIso: string) {
  return sb
    .from('live_rooms')
    .select('id, title, starts_at')
    .eq('tenant_id', tenantId)
    .gte('starts_at', fromIso)
    .lt('starts_at', untilIso)
    .limit(20);
}

export async function fetchLiveRoomAccessGrants(sb: SupabaseClient, roomIds: string[]) {
  return sb.from('live_room_access_grants').select('live_room_id').in('live_room_id', roomIds);
}
