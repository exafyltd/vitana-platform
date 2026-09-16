/**
 * B5 realtime relay — polling loop for `chat_messages` (see
 * chat-messages-relay-repository.ts for the schema/authorization
 * rationale). Pure logic, no HTTP/SSE concerns, so it can be
 * unit-tested without a live Supabase connection or an open connection.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchChatMessagesSinceCursor, fetchUserGroupIds, type RowCursor } from './chat-messages-relay-repository';

export const DEFAULT_POLL_INTERVAL_MS = 3000;
export const DEFAULT_POLL_LIMIT = 50;

export interface ChatPollResult {
  rows: Record<string, unknown>[];
  cursor: RowCursor;
  error: { message: string } | null;
}

/**
 * One poll cycle: re-fetches the caller's CURRENT group membership (so a
 * mid-session join/leave takes effect on the very next tick, not just on
 * reconnect), then fetches messages visible under that membership newer
 * than `cursor`. A group-membership lookup failure is reported the same
 * way a message-query failure is — the cursor is left unchanged so the
 * same window is retried next tick.
 */
export async function pollChatMessagesOnce(
  sb: SupabaseClient,
  tenantId: string | null,
  userId: string,
  cursor: RowCursor,
  limit: number = DEFAULT_POLL_LIMIT,
): Promise<ChatPollResult> {
  const { groupIds, error: groupError } = await fetchUserGroupIds(sb, userId);
  if (groupError) {
    return { rows: [], cursor, error: groupError };
  }

  const { data, error } = await fetchChatMessagesSinceCursor(sb, tenantId, userId, groupIds, cursor, limit);
  if (error) {
    return { rows: [], cursor, error: { message: error.message } };
  }

  const rows = data ?? [];
  if (rows.length === 0) {
    return { rows: [], cursor, error: null };
  }

  const last = rows[rows.length - 1] as { created_at: string; id: string };
  return {
    rows,
    cursor: { sinceCreatedAt: last.created_at, sinceId: last.id },
    error: null,
  };
}

/**
 * Runs `pollChatMessagesOnce` on a fixed interval. Same "log loudly,
 * degrade, keep going" posture as generic-cursor-relay.ts's
 * startRowPolling — a transient error (message query or group-membership
 * lookup) does not stop the loop. Returns a stop function; the caller (an
 * SSE route) must call it on disconnect, or the interval leaks for the
 * lifetime of the process.
 */
export function startChatMessagesPolling(
  sb: SupabaseClient,
  tenantId: string | null,
  userId: string,
  initialCursor: RowCursor,
  onRows: (rows: Record<string, unknown>[]) => void,
  opts: { intervalMs?: number; limit?: number; onError?: (message: string) => void } = {},
): () => void {
  let cursor = initialCursor;
  let stopped = false;
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const tick = async () => {
    if (stopped) return;
    const result = await pollChatMessagesOnce(sb, tenantId, userId, cursor, opts.limit);
    if (stopped) return;
    if (result.error) {
      opts.onError?.(result.error.message);
    } else if (result.rows.length > 0) {
      cursor = result.cursor;
      onRows(result.rows);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
