/**
 * VTID-02774 — Voice Tool Expansion P1l: Events / Live Rooms.
 *
 * Backs voice tools for community meetups + live rooms. Live-room ops
 * use service-role direct table writes since the user-token RPCs need
 * a real JWT; voice tool dispatcher uses service-role.
 */

import { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// 1. rsvp_event — wraps meetup_rsvp RPC
// ---------------------------------------------------------------------------

export async function rsvpEvent(
  sb: SupabaseClient,
  args: { meetup_id: string; status: 'rsvp' | 'attended' | 'no_show' },
): Promise<{ ok: true; meetup_id: string; status: string } | { ok: false; error: string }> {
  if (!args.meetup_id) return { ok: false, error: 'meetup_id_required' };
  if (!['rsvp', 'attended', 'no_show'].includes(args.status)) {
    return { ok: false, error: 'invalid_status' };
  }
  const { error } = await sb.rpc('meetup_rsvp', {
    p_meetup_id: args.meetup_id,
    p_status: args.status,
  });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: 'meetup_rsvp_rpc_unavailable' };
    }
    return { ok: false, error: `rsvp_failed: ${error.message}` };
  }
  return { ok: true, meetup_id: args.meetup_id, status: args.status };
}

// ---------------------------------------------------------------------------
// 2. join_live_room — direct insert into live_room_participants
// ---------------------------------------------------------------------------

export async function joinLiveRoom(
  sb: SupabaseClient,
  userId: string,
  args: { room_id: string },
): Promise<{ ok: true; room_id: string } | { ok: false; error: string }> {
  if (!args.room_id) return { ok: false, error: 'room_id_required' };
  // First verify room exists + is open.
  const { data: room, error: roomErr } = await sb
    .from('live_rooms')
    .select('id, status, access_level')
    .eq('id', args.room_id)
    .maybeSingle();
  if (roomErr) return { ok: false, error: `room_lookup_failed: ${roomErr.message}` };
  if (!room) return { ok: false, error: 'room_not_found' };
  if ((room as any).status === 'ended' || (room as any).status === 'cancelled') {
    return { ok: false, error: 'room_closed' };
  }

  // Upsert participant row.
  const { error } = await sb.from('live_room_participants').upsert(
    {
      live_room_id: args.room_id,
      user_id: userId,
      joined_at: new Date().toISOString(),
      status: 'joined',
    },
    { onConflict: 'live_room_id,user_id' },
  );
  if (error) return { ok: false, error: `join_failed: ${error.message}` };
  return { ok: true, room_id: args.room_id };
}

// ---------------------------------------------------------------------------
// 3. leave_live_room — update participant status
// ---------------------------------------------------------------------------

export async function leaveLiveRoom(
  sb: SupabaseClient,
  userId: string,
  args: { room_id: string },
): Promise<{ ok: true; room_id: string } | { ok: false; error: string }> {
  if (!args.room_id) return { ok: false, error: 'room_id_required' };
  const { error } = await sb
    .from('live_room_participants')
    .update({ left_at: new Date().toISOString(), status: 'left' })
    .eq('live_room_id', args.room_id)
    .eq('user_id', userId);
  if (error) return { ok: false, error: `leave_failed: ${error.message}` };
  return { ok: true, room_id: args.room_id };
}

// ---------------------------------------------------------------------------
// 4. list_my_live_rooms — rooms the user owns or has joined
// ---------------------------------------------------------------------------

export async function listMyLiveRooms(
  sb: SupabaseClient,
  userId: string,
  args: { limit?: number },
): Promise<
  | { ok: true; rooms: Array<{ id: string; title?: string; status: string; role: string }>; count: number }
  | { ok: false; error: string }
> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 20));

  // Owned rooms
  const ownedQ = await sb
    .from('live_rooms')
    .select('id, title, status, created_at')
    .eq('host_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  // Joined rooms (via participants)
  const joinedQ = await sb
    .from('live_room_participants')
    .select('live_room_id, status')
    .eq('user_id', userId)
    .eq('status', 'joined')
    .limit(limit);

  if (ownedQ.error) return { ok: false, error: `owned_query_failed: ${ownedQ.error.message}` };

  const rooms: Array<{ id: string; title?: string; status: string; role: string }> = [];
  for (const r of (ownedQ.data || []) as any[]) {
    rooms.push({ id: String(r.id), title: r.title ?? undefined, status: String(r.status), role: 'host' });
  }
  if (joinedQ.data && joinedQ.data.length > 0) {
    const joinedIds = (joinedQ.data as any[]).map(r => String(r.live_room_id));
    const { data: joined } = await sb
      .from('live_rooms')
      .select('id, title, status')
      .in('id', joinedIds);
    for (const r of (joined || []) as any[]) {
      if (rooms.find(x => x.id === String(r.id))) continue;
      rooms.push({ id: String(r.id), title: r.title ?? undefined, status: String(r.status), role: 'participant' });
    }
  }

  return { ok: true, rooms: rooms.slice(0, limit), count: rooms.length };
}

// ---------------------------------------------------------------------------
// 5. create_meetup — wrap community_create_meetup RPC
// ---------------------------------------------------------------------------

export async function createMeetup(
  sb: SupabaseClient,
  args: {
    group_id?: string;
    title: string;
    starts_at: string;
    location?: string;
    description?: string;
  },
): Promise<{ ok: true; meetup_id: string } | { ok: false; error: string }> {
  if (!args.title || !args.starts_at) {
    return { ok: false, error: 'title_and_starts_at_required' };
  }
  const { data, error } = await sb.rpc('community_create_meetup', {
    p_payload: {
      group_id: args.group_id ?? null,
      title: args.title,
      starts_at: args.starts_at,
      location: args.location ?? null,
      description: args.description ?? null,
    },
  });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: 'create_meetup_rpc_unavailable' };
    }
    return { ok: false, error: `create_meetup_failed: ${error.message}` };
  }
  return { ok: true, meetup_id: String((data as any)?.id ?? '') };
}
