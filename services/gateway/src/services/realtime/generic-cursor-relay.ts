/**
 * B5 realtime relay — generic cursor-based poller for tables whose
 * authorization model is a plain equality match on one or more columns
 * (e.g. `user_id`, or `user_id` + `tenant_id`). `chat_messages` does NOT
 * fit this shape (thread/group membership, not row ownership) and needs
 * its own implementation — do not force it through this module.
 *
 * `user_notifications` was the first table built against this shape
 * (originally with its own bespoke poller/repository pair); this module
 * is the generalization extracted once `user_activity_log` needed the
 * identical polling/cursor/error-handling logic, to avoid a second
 * hand-copy of it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RowCursor {
  /** ISO timestamp of the last row this caller has already seen. */
  sinceCreatedAt: string;
  /** Tie-breaker for rows sharing the same `created_at` millisecond. */
  sinceId: string | null;
}

export interface RelayTableConfig {
  table: string;
  /** Column equality filters that scope rows to the authorized caller, e.g. { user_id: 'u1', tenant_id: 't1' }. */
  filters: Record<string, string | null>;
  /** Column list for `.select()`; '*' if omitted. */
  columns?: string;
}

export const DEFAULT_POLL_INTERVAL_MS = 3000;
export const DEFAULT_POLL_LIMIT = 50;

/** Fetch rows matching `config.filters`, created strictly after `cursor`, oldest-first, capped at `limit`. */
export async function fetchRowsSinceCursor(sb: SupabaseClient, config: RelayTableConfig, cursor: RowCursor, limit: number) {
  // Cast to `any`: `config.columns` is a runtime string, not a literal, so
  // supabase-js's `.select()` overload resolution falls back to a
  // `GenericStringError` inference it can't reconcile with our own
  // `Record<string, unknown>[]` return shape. Correctness here is enforced
  // by generic-cursor-relay.test.ts's call-shape assertions, not by this
  // type — the same posture the table-specific repository tests already
  // take toward these query-builder chains.
  let query: any = sb.from(config.table).select(config.columns ?? '*');

  for (const [column, value] of Object.entries(config.filters)) {
    query = value === null ? query.is(column, null) : query.eq(column, value);
  }

  query = cursor.sinceId
    ? query.or(
        `created_at.gt.${cursor.sinceCreatedAt},and(created_at.eq.${cursor.sinceCreatedAt},id.gt.${cursor.sinceId})`,
      )
    : query.gt('created_at', cursor.sinceCreatedAt);

  return query.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
}

export interface RowPollResult {
  rows: Record<string, unknown>[];
  cursor: RowCursor;
  error: { message: string } | null;
}

/**
 * One poll cycle: fetch rows newer than `cursor`, return them plus the
 * cursor advanced to the last row seen (or unchanged on error / no new
 * rows, so the next poll retries the same window rather than skipping it).
 */
export async function pollRowsOnce(
  sb: SupabaseClient,
  config: RelayTableConfig,
  cursor: RowCursor,
  limit: number = DEFAULT_POLL_LIMIT,
): Promise<RowPollResult> {
  const { data, error } = await fetchRowsSinceCursor(sb, config, cursor, limit);

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
 * Runs `pollRowsOnce` on a fixed interval, invoking `onRows` for each
 * non-empty poll and `onError` (if given) for a query error without
 * stopping the loop — a transient Supabase error should not permanently
 * kill a live connection, the same "log loudly, degrade, keep going"
 * posture the narration-audio-cache and other B-workstream additions in
 * this migration already use. Returns a stop function; the caller (an
 * SSE route) must call it when the client disconnects, or the interval
 * leaks for the lifetime of the process.
 */
export function startRowPolling(
  sb: SupabaseClient,
  config: RelayTableConfig,
  initialCursor: RowCursor,
  onRows: (rows: Record<string, unknown>[]) => void,
  opts: { intervalMs?: number; limit?: number; onError?: (message: string) => void } = {},
): () => void {
  let cursor = initialCursor;
  let stopped = false;
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const tick = async () => {
    if (stopped) return;
    const result = await pollRowsOnce(sb, config, cursor, opts.limit);
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
