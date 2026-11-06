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
