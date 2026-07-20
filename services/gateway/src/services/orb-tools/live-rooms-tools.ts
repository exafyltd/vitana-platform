/**
 * Community voice tools — Live Rooms / Go Live (A7), Wave 4 of
 * docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Thin dispatch layer over routes/live.ts. purchase_room_access only
 * creates a Stripe PaymentIntent and hands the client_secret to the
 * screen — voice never confirms the charge (actual access grant happens
 * via the Stripe webhook on payment_intent.succeeded). extend_live_session
 * and play_room_recording are NOT implemented — no backend route/column
 * exists for extending a session's end time or listing/playing back Daily
 * cloud recordings, so those two stay `status: planned`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, relAge } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function authHeaders(id: OrbToolIdentity): Record<string, string> {
  return id.user_jwt ? { Authorization: `Bearer ${id.user_jwt}` } : {};
}

const NO_SESSION: OrbToolResult = {
  ok: true,
  result: { reason: 'no_session' },
  text: "I need your signed-in session to do that — I don't have one for this voice session.",
};

// ---------------------------------------------------------------------------
// 1. list_live_rooms_now — direct Supabase read (no dedicated list route)
// ---------------------------------------------------------------------------

export const list_live_rooms_now: Handler = async (args, id, sb) => {
  if (!id.user_id || !id.tenant_id) return { ok: false, error: 'list_live_rooms_now requires an authenticated user with a tenant.' };
  const { data, error } = await sb
    .from('live_rooms')
    .select('id, title, starts_at, status')
    .eq('tenant_id', id.tenant_id)
    .in('status', ['scheduled', 'live'])
    .order('starts_at', { ascending: true })
    .limit(20);
  if (error) return { ok: false, error: `list_live_rooms_now failed: ${error.message}` };
  const rooms = (data ?? []) as Array<{ id: string; title: string; status: string; starts_at: string }>;
  const live = rooms.filter((r) => r.status === 'live');
  if (rooms.length === 0) return { ok: true, result: { rooms: [] }, text: 'No live rooms scheduled or live right now.' };
  const lines = rooms.slice(0, 8).map((r) => `${r.title} — ${r.status === 'live' ? 'LIVE NOW' : `starts ${relAge(r.starts_at)}`}`);
  return { ok: true, result: { rooms, live_count: live.length }, text: `${live.length} live now, ${rooms.length} total: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 2. get_live_room_details — GET /api/v1/live/rooms/:id/state
// ---------------------------------------------------------------------------

export const get_live_room_details: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'get_live_room_details requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const roomId = String(args.room_id ?? '').trim();
  if (!roomId) return { ok: false, error: 'get_live_room_details requires room_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/live/rooms/${encodeURIComponent(roomId)}/state`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `get_live_room_details failed (${status}): ${String(body.error ?? 'unknown')}` };
  const room = (body.room ?? {}) as Record<string, unknown>;
  const session = (body.session ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    result: body,
    text: `${String(room.status ?? 'unknown')} room, access ${String(session.access_level ?? 'unknown')}.`,
  };
};

// ---------------------------------------------------------------------------
// 3/5. go_live / schedule_live_session — both POST /api/v1/live/rooms/:id/sessions
// ---------------------------------------------------------------------------

async function createSession(args: OrbToolArgs, id: OrbToolIdentity, startsNow: boolean): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'This requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const roomId = String(args.room_id ?? '').trim();
  if (!roomId) return { ok: false, error: 'room_id is required.' };
  const startsAt = startsNow ? new Date().toISOString() : String(args.starts_at ?? '').trim();
  if (!startsNow && !startsAt) return { ok: false, error: 'schedule_live_session requires starts_at (ISO timestamp).' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/live/rooms/${encodeURIComponent(roomId)}/sessions`, {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      starts_at: startsAt,
      session_title: typeof args.session_title === 'string' ? args.session_title : undefined,
      access_level: typeof args.access_level === 'string' ? args.access_level : undefined,
      idempotency_key: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
    },
  });
  if (!ok) return { ok: true, result: { started: false, status, detail: body }, text: `Could not ${startsNow ? 'go live' : 'schedule the session'}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return {
    ok: true,
    result: { started: true, detail: body },
    text: startsNow ? `You're live now.` : `Session scheduled for ${startsAt}.`,
  };
}

export const go_live: Handler = async (args, id) => createSession(args, id, true);
export const schedule_live_session: Handler = async (args, id) => createSession(args, id, false);

// ---------------------------------------------------------------------------
// 4. create_live_room — POST /api/v1/live/rooms
// ---------------------------------------------------------------------------

export const create_live_room: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'create_live_room requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const title = String(args.title ?? '').trim();
  if (!title) return { ok: false, error: 'create_live_room requires a title.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, title },
      text: `About to create a live room "${title}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/live/rooms', {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      title,
      topic_keys: Array.isArray(args.topic_keys) ? args.topic_keys : undefined,
      starts_at: typeof args.starts_at === 'string' ? args.starts_at : undefined,
      access_level: typeof args.access_level === 'string' ? args.access_level : 'public',
      metadata: typeof args.price === 'number' ? { price: args.price } : undefined,
    },
  });
  if (!ok) {
    const err = String(body.error ?? '');
    if (err.includes('CREATOR_NOT_ONBOARDED')) {
      return { ok: true, result: { created: false, reason: 'creator_not_onboarded' }, text: `You need to finish Stripe creator onboarding before hosting a paid room. Free rooms don't need this.` };
    }
    return { ok: true, result: { created: false, status, detail: body }, text: `Could not create the room: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { created: true, detail: body }, text: `Room "${title}" created.` };
};

// ---------------------------------------------------------------------------
// 6. purchase_room_access — POST /api/v1/live/rooms/:id/purchase (PaymentIntent only)
// ---------------------------------------------------------------------------

export const purchase_room_access: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'purchase_room_access requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const roomId = String(args.room_id ?? '').trim();
  if (!roomId) return { ok: false, error: 'purchase_room_access requires room_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/live/rooms/${encodeURIComponent(roomId)}/purchase`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { prepared: false, status, detail: body }, text: `Could not prepare payment: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return {
    ok: true,
    result: { prepared: true, client_secret: body.client_secret, amount: body.amount, currency: body.currency, directive: { type: 'orb_directive', directive: 'confirm_payment', client_secret: body.client_secret } },
    text: `Payment ready — confirm ${Number(body.amount ?? 0) / 100} ${String(body.currency ?? '').toUpperCase()} on screen to get access.`,
  };
};

// ---------------------------------------------------------------------------
// 8. end_live_session — POST /api/v1/live/rooms/:id/end
// ---------------------------------------------------------------------------

export const end_live_session: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'end_live_session requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const roomId = String(args.room_id ?? '').trim();
  if (!roomId) return { ok: false, error: 'end_live_session requires room_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, room_id: roomId },
      text: `About to end your live session. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/live/rooms/${encodeURIComponent(roomId)}/end`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { ended: false, status, detail: body }, text: `Could not end the session: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { ended: true, detail: body }, text: `Session ended.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const LIVE_ROOMS_TOOL_HANDLERS: Record<string, Handler> = {
  list_live_rooms_now,
  get_live_room_details,
  go_live,
  create_live_room,
  schedule_live_session,
  purchase_room_access,
  end_live_session,
};

export const LIVE_ROOMS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'list_live_rooms_now', description: 'What live rooms are live or scheduled right now.', parameters: { type: 'object', properties: {} } },
  { name: 'get_live_room_details', description: 'Room info, host, access level for one live room.', parameters: { type: 'object', properties: { room_id: { type: 'string', description: 'Required.' } }, required: ['room_id'] } },
  {
    name: 'go_live',
    description: 'Start hosting now (creates a live session on your room).',
    parameters: { type: 'object', properties: { room_id: { type: 'string', description: 'Required.' }, session_title: { type: 'string' }, access_level: { type: 'string' } }, required: ['room_id'] },
  },
  {
    name: 'create_live_room',
    description: 'Create a new live room. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Required.' },
        topic_keys: { type: 'array', items: { type: 'string' } },
        starts_at: { type: 'string' }, access_level: { type: 'string', description: 'public or group.' },
        price: { type: 'number' }, confirm: { type: 'boolean' },
      },
      required: ['title'],
    },
  },
  {
    name: 'schedule_live_session',
    description: 'Schedule a future live session on your room.',
    parameters: { type: 'object', properties: { room_id: { type: 'string', description: 'Required.' }, starts_at: { type: 'string', description: 'ISO timestamp. Required.' }, session_title: { type: 'string' } }, required: ['room_id', 'starts_at'] },
  },
  {
    name: 'purchase_room_access',
    description: 'Prepare payment for a paid room — hands off to the screen to confirm the charge.',
    parameters: { type: 'object', properties: { room_id: { type: 'string', description: 'Required.' } }, required: ['room_id'] },
  },
  {
    name: 'end_live_session',
    description: 'End your current live session. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { room_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['room_id'] },
  },
];
