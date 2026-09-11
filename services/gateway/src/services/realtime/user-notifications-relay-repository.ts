/**
 * B5 realtime relay — cursor-based query for `user_notifications`
 * (Supabase→Aurora migration workstream, see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B5,
 * docs/AURORA-B5-REALTIME-INVENTORY.md's 2026-08-29 addendum).
 *
 * `user_notifications` is one of the 3 tables that inventory identified as
 * genuinely live-critical for Realtime (the other two are
 * `user_activity_log` and `chat_messages` — not built yet, deliberately
 * starting with the simplest authorization model of the three: a row's
 * owner is always exactly `user_id` + `tenant_id`, the same scoping
 * `notifications-repository.ts`'s `fetchNotificationHistory()` already
 * uses for the non-realtime history endpoint).
 *
 * This is a plain polling query, not a WAL subscription — the inventory's
 * own addendum recommends starting here specifically because it needs no
 * `rds.logical_replication` reboot and is buildable/shippable today.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface NotificationCursor {
  /** ISO timestamp of the last row this caller has already seen. */
  sinceCreatedAt: string;
  /** Tie-breaker for rows sharing the same `created_at` millisecond. */
  sinceId: string | null;
}

/**
 * Fetch notifications for (userId, tenantId) created strictly after the
 * cursor, oldest-first, capped at `limit`. Ties on `created_at` are broken
 * by `id` so a row is never skipped or duplicated across polls even when
 * multiple rows share a timestamp.
 */
export async function fetchNotificationsSinceCursor(
  sb: SupabaseClient,
  userId: string,
  tenantId: string | null,
  cursor: NotificationCursor,
  limit: number,
) {
  let query = sb
    .from('user_notifications')
    .select('*')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId);

  query = cursor.sinceId
    ? query.or(
        `created_at.gt.${cursor.sinceCreatedAt},and(created_at.eq.${cursor.sinceCreatedAt},id.gt.${cursor.sinceId})`,
      )
    : query.gt('created_at', cursor.sinceCreatedAt);

  return query.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
}
