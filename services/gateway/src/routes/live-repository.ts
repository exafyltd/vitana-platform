// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Covered through the
// live routes by test/vtid-04905-live-enter-exit.test.ts (VTID-04905).
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

/**
 * VTID-04905 (B9): `community_live_streams` has no tenant_id column, so the
 * tenant comes from the live room the listing mirrors (`id` = live_rooms.id).
 * Same `{ data: { title, tenant_id }, error }` shape callers already read.
 * Known residual (follow-up VTID, needs a migration): the listing table
 * itself has no tenant_id and its SELECT policy is not tenant-scoped.
 */
export async function fetchLiveStreamTitleTenant(sb: SupabaseClient, roomId: string) {
  const [stream, room] = await Promise.all([
    sb.from('community_live_streams').select('title').eq('id', roomId).maybeSingle(),
    sb.from('live_rooms').select('title, tenant_id').eq('id', roomId).maybeSingle(),
  ]);
  const error = room.error || stream.error || null;
  if (!room.data) return { data: null, error };
  return {
    data: {
      title: (stream.data as any)?.title || (room.data as any).title || null,
      tenant_id: (room.data as any).tenant_id as string | null,
    },
    error,
  };
}

export async function fetchLiveStreamSubscribersExcluding(sb: SupabaseClient, streamId: string, excludeUserId: string) {
  return sb.from('live_stream_subscribers').select('user_id').eq('stream_id', streamId).neq('user_id', excludeUserId);
}

/**
 * Reused by the room-ended, joined, and highlight-added notification dispatches.
 * VTID-04905 (B9): the host column is `host_user_id` (there is no `user_id`).
 */
export async function fetchLiveRoomTitleTenantHost(sb: SupabaseClient, roomId: string) {
  return sb.from('live_rooms').select('title, tenant_id, host_user_id').eq('id', roomId).single();
}

/** Distinct from fetchLiveRoomTitleTenantHost — the going-live dispatch doesn't need the host. */
export async function fetchLiveRoomTitleTenant(sb: SupabaseClient, roomId: string) {
  return sb.from('live_rooms').select('title, tenant_id').eq('id', roomId).single();
}

/**
 * Reused by the room-ended and going-live-to-followers notification dispatches.
 * VTID-04905 (B9): the table is `live_room_attendance` (keyed by
 * `live_room_id`); `live_room_attendees` never existed. Pass `sessionId` to
 * limit to one session (room ended → that session's attendees). Rows repeat
 * per session, so callers dedupe user ids.
 */
export async function fetchLiveRoomAttendeesExcluding(
  sb: SupabaseClient,
  roomId: string,
  excludeUserId: string,
  sessionId?: string | null,
) {
  let q = sb.from('live_room_attendance').select('user_id').eq('live_room_id', roomId);
  if (sessionId) q = q.eq('session_id', sessionId);
  if (excludeUserId) q = q.neq('user_id', excludeUserId);
  return q;
}

export async function fetchMeetupTitleTenantCreator(sb: SupabaseClient, meetupId: string) {
  return sb.from('community_meetups').select('title, tenant_id, created_by').eq('id', meetupId).single();
}

export async function fetchMeetupTenantId(sb: SupabaseClient, meetupId: string) {
  return sb.from('community_meetups').select('tenant_id').eq('id', meetupId).maybeSingle();
}
