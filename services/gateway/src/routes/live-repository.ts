// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/live.ts — zero coverage today.
/**
 * routes/live.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchLiveStreamTitleTenant(sb: SupabaseClient, roomId: string) {
  return sb.from('community_live_streams').select('title, tenant_id').eq('id', roomId).single();
}

export async function fetchLiveStreamSubscribersExcluding(sb: SupabaseClient, streamId: string, excludeUserId: string) {
  return sb.from('live_stream_subscribers').select('user_id').eq('stream_id', streamId).neq('user_id', excludeUserId);
}

/** Reused by the room-ended, joined, and highlight-added notification dispatches. */
export async function fetchLiveRoomTitleTenantUser(sb: SupabaseClient, roomId: string) {
  return sb.from('live_rooms').select('title, tenant_id, user_id').eq('id', roomId).single();
}

/** Distinct from fetchLiveRoomTitleTenantUser — the going-live dispatch doesn't need user_id. */
export async function fetchLiveRoomTitleTenant(sb: SupabaseClient, roomId: string) {
  return sb.from('live_rooms').select('title, tenant_id').eq('id', roomId).single();
}

/** Reused by the room-ended and going-live-to-followers notification dispatches. */
export async function fetchLiveRoomAttendeesExcluding(sb: SupabaseClient, roomId: string, excludeUserId: string) {
  return sb.from('live_room_attendees').select('user_id').eq('room_id', roomId).neq('user_id', excludeUserId);
}

export async function fetchMeetupTitleTenantCreator(sb: SupabaseClient, meetupId: string) {
  return sb.from('community_meetups').select('title, tenant_id, created_by').eq('id', meetupId).single();
}

export async function fetchMeetupTenantId(sb: SupabaseClient, meetupId: string) {
  return sb.from('community_meetups').select('tenant_id').eq('id', meetupId).maybeSingle();
}
