/**
 * B5 realtime relay — polling loop for `user_notifications` (see
 * user-notifications-relay-repository.ts for the schema/authorization
 * rationale). Pure logic, no HTTP/SSE concerns, so it can be unit-tested
 * without a live Supabase connection or an open connection.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchNotificationsSinceCursor, type NotificationCursor } from './user-notifications-relay-repository';

export const DEFAULT_POLL_INTERVAL_MS = 3000;
export const DEFAULT_POLL_LIMIT = 50;

export interface NotificationPollResult {
  rows: Record<string, unknown>[];
  cursor: NotificationCursor;
  error: { message: string } | null;
}

/**
 * One poll cycle: fetch rows newer than `cursor`, return them plus the
 * cursor advanced to the last row seen (or unchanged on error / no new
 * rows, so the next poll retries the same window rather than skipping it).
 */
export async function pollNotificationsOnce(
  sb: SupabaseClient,
  userId: string,
  tenantId: string | null,
  cursor: NotificationCursor,
  limit: number = DEFAULT_POLL_LIMIT,
): Promise<NotificationPollResult> {
  const { data, error } = await fetchNotificationsSinceCursor(sb, userId, tenantId, cursor, limit);

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
 * Runs `pollNotificationsOnce` on a fixed interval, invoking `onRows` for
 * each non-empty poll and `onError` (if given) for a query error without
 * stopping the loop — a transient Supabase error should not permanently
 * kill a live connection, the same "log loudly, degrade, keep going"
 * posture the narration-audio-cache and other B-workstream additions in
 * this migration already use. Returns a stop function; the caller (the
 * SSE route) must call it when the client disconnects, or the interval
 * leaks for the lifetime of the process.
 */
export function startNotificationPolling(
  sb: SupabaseClient,
  userId: string,
  tenantId: string | null,
  initialCursor: NotificationCursor,
  onRows: (rows: Record<string, unknown>[]) => void,
  opts: { intervalMs?: number; limit?: number; onError?: (message: string) => void } = {},
): () => void {
  let cursor = initialCursor;
  let stopped = false;
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const tick = async () => {
    if (stopped) return;
    const result = await pollNotificationsOnce(sb, userId, tenantId, cursor, opts.limit);
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
