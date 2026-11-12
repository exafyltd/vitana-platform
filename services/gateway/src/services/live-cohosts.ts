/**
 * VTID-05559 (live-room-edit-cohost / gateway-cohost) — co-host helpers.
 *
 * isRoomHost: the creator is host with no RPC call. A listed co-host is host
 * through live_room_is_host (service role). Any RPC error means "not host",
 * so the creator path is never affected by a failing check.
 *
 * filterCoHosts: validates requested co-host ids with
 * live_room_filter_co_hosts. Dropped ids are reported, never removed silently.
 * A missing validation function raises CoHostValidationUnavailableError
 * (the route answers 503), so unvalidated ids are never accepted.
 */

import { getSupabase } from '../lib/supabase';

export class CoHostValidationUnavailableError extends Error {
  readonly code = 'CO_HOST_VALIDATION_UNAVAILABLE';

  constructor(message = 'co-host validation is unavailable') {
    super(message);
    this.name = 'CoHostValidationUnavailableError';
  }
}

export interface RpcError {
  code?: string;
  message?: string;
}

export interface RpcClient {
  rpc(fn: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export type FilterCoHostsResult =
  | { ok: true; ids: string[] }
  | { ok: false; code: 'INVALID_CO_HOSTS'; dropped: string[] };

// PostgreSQL "undefined_function" and PostgREST "function not found in schema cache".
const MISSING_FUNCTION_CODES = new Set(['42883', 'PGRST202']);

export async function isRoomHost(
  supa: RpcClient,
  roomId: string,
  userId: string,
  hostUserId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  if (hostUserId && hostUserId === userId) return true;
  try {
    const { data, error } = await supa.rpc('live_room_is_host', { p_room_id: roomId, p_user_id: userId });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

export async function filterCoHosts(
  supa: RpcClient,
  _roomId: string,
  creatorId: string,
  ids: string[],
): Promise<FilterCoHostsResult> {
  if (ids.length === 0) return { ok: true, ids: [] };

  const { data, error } = await supa.rpc('live_room_filter_co_hosts', { p_creator: creatorId, p_ids: ids });
  if (error) {
    if (error.code && MISSING_FUNCTION_CODES.has(error.code)) {
      throw new CoHostValidationUnavailableError();
    }
    throw new Error(`co-host validation failed: ${error.message ?? 'unknown error'}`);
  }

  const kept = Array.isArray(data) ? (data as string[]) : [];
  const dropped = ids.filter((id) => !kept.includes(id));
  if (dropped.length > 0) return { ok: false, code: 'INVALID_CO_HOSTS', dropped };
  return { ok: true, ids: kept };
}

/**
 * Host check for routes and the room state machine: the creator is host with
 * no database call; otherwise the service-role client answers. No client
 * (not configured) means only the creator is host.
 */
export async function isRoomHostNow(
  roomId: string,
  userId: string,
  hostUserId: string | null | undefined,
): Promise<boolean> {
  if (hostUserId && hostUserId === userId) return true;
  const supa = getSupabase();
  if (!supa) return false;
  return isRoomHost(supa as unknown as RpcClient, roomId, userId, hostUserId);
}

// --- Session edit rules (VTID-05559): locked fields and the session/listing payloads ---


export const LOCKED_WHILE_OPEN = ['starts_at', 'duration_minutes', 'stream_type', 'access_level'] as const;

export interface SessionEditBody {
  session_title?: string;
  topic_keys?: string[];
  starts_at?: string;
  duration_minutes?: number;
  co_hosts?: string[];
  description?: string | null;
  cover_image_url?: string | null;
  stream_type?: 'audio' | 'video';
  access_level?: 'public' | 'group';
  enable_chat?: boolean;
  enable_polls?: boolean;
  enable_recording?: boolean;
}

export interface CurrentSessionTimes {
  starts_at: string;
  ends_at?: string | null;
}

/** Fields the body wants to change that are locked for this session status. */
export function lockedFieldsRequested(body: SessionEditBody, sessionStatus: string): string[] {
  if (sessionStatus !== 'live' && sessionStatus !== 'lobby') return [];
  return LOCKED_WHILE_OPEN.filter((k) => body[k] !== undefined);
}

export interface SessionEditPatch {
  session: Record<string, unknown>;
  listing: Record<string, unknown>;
}

/**
 * Maps an accepted edit to the session row and the listing row. Only keys the
 * body sends are written. ends_at follows starts_at + duration when either changes.
 */
export function buildSessionEditPatch(body: SessionEditBody, current: CurrentSessionTimes): SessionEditPatch {
  const session: Record<string, unknown> = {};
  const listing: Record<string, unknown> = {};

  if (body.session_title !== undefined) {
    session.session_title = body.session_title;
    listing.title = body.session_title;
  }
  if (body.topic_keys !== undefined) {
    session.topic_keys = body.topic_keys;
    listing.tags = body.topic_keys;
  }
  if (body.starts_at !== undefined || body.duration_minutes !== undefined) {
    const startsAt = body.starts_at ?? current.starts_at;
    const startMs = Date.parse(startsAt);
    const minutes = body.duration_minutes ?? durationMinutes(current);
    session.starts_at = startsAt;
    session.ends_at = new Date(startMs + minutes * 60_000).toISOString();
    listing.scheduled_for = startsAt;
    listing.duration_minutes = minutes;
  }
  if (body.co_hosts !== undefined) {
    listing.co_hosts = body.co_hosts;
  }
  if (body.description !== undefined) listing.description = body.description;
  if (body.cover_image_url !== undefined) listing.cover_image_url = body.cover_image_url;
  if (body.stream_type !== undefined) listing.stream_type = body.stream_type;
  if (body.access_level !== undefined) {
    session.access_level = body.access_level;
    listing.access_level = body.access_level;
  }
  if (body.enable_chat !== undefined) listing.enable_chat = body.enable_chat;
  if (body.enable_polls !== undefined) listing.enable_polls = body.enable_polls;
  if (body.enable_recording !== undefined) listing.enable_recording = body.enable_recording;
  return { session, listing };
}

function durationMinutes(current: CurrentSessionTimes): number {
  if (!current.ends_at) return 60;
  const ms = Date.parse(current.ends_at) - Date.parse(current.starts_at);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 60;
}
