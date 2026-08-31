// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/notifications.ts — zero coverage today.
/**
 * routes/notifications.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** POST /token — revoke every OTHER account's claim on this device (VTID-03481). */
export async function revokeOtherAccountsDeviceToken(sb: SupabaseClient, fcmToken: string, userId: string) {
  return sb
    .from('user_device_tokens')
    .update({ revoked_at: new Date().toISOString(), revoked_reason: 'taken_over' })
    .eq('fcm_token', fcmToken)
    .neq('user_id', userId)
    .is('revoked_at', null);
}

/** POST /token — claim/re-claim this device token for the registering user. */
export async function upsertDeviceToken(
  sb: SupabaseClient,
  row: { user_id: string; tenant_id: string | null; fcm_token: string; device_label: string | null; updated_at: string },
) {
  return sb.from('user_device_tokens').upsert(
    {
      ...row,
      revoked_at: null,
      revoked_reason: null,
    },
    { onConflict: 'user_id,fcm_token' },
  );
}

/** POST /token — prune this user's own stale (rotated) tokens (VTID-03487). */
export async function pruneStaleDeviceTokens(sb: SupabaseClient, userId: string, currentFcmToken: string, staleCutoff: string) {
  return sb
    .from('user_device_tokens')
    .update({ revoked_at: new Date().toISOString(), revoked_reason: 'stale' })
    .eq('user_id', userId)
    .neq('fcm_token', currentFcmToken)
    .lt('updated_at', staleCutoff)
    .is('revoked_at', null);
}

/** DELETE /token — soft-revoke on sign-out (VTID-03481). */
export async function revokeOwnDeviceTokenOnSignOut(sb: SupabaseClient, userId: string, fcmToken: string) {
  return sb
    .from('user_device_tokens')
    .update({ revoked_at: new Date().toISOString(), revoked_reason: 'signed_out' })
    .eq('user_id', userId)
    .eq('fcm_token', fcmToken)
    .is('revoked_at', null);
}

/** GET / — paginated notification history. */
export async function fetchNotificationHistory(sb: SupabaseClient, userId: string, tenantId: string | null, offset: number, limit: number) {
  return sb
    .from('user_notifications')
    .select('*')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
}

/** GET /unread-count — badge count. */
export async function countUnreadNotifications(sb: SupabaseClient, userId: string, tenantId: string | null) {
  return sb
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .is('read_at', null);
}

/** POST /:id/read — mark a single notification as read. */
export async function markNotificationRead(sb: SupabaseClient, id: string, userId: string, readAt: string) {
  return sb.from('user_notifications').update({ read_at: readAt }).eq('id', id).eq('user_id', userId);
}

/** POST /mark-all-read — mark every unread notification as read. */
export async function markAllNotificationsRead(sb: SupabaseClient, userId: string, tenantId: string | null, readAt: string) {
  return sb
    .from('user_notifications')
    .update({ read_at: readAt })
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .is('read_at', null);
}

/** DELETE /:id — delete a single notification. */
export async function deleteNotification(sb: SupabaseClient, id: string, userId: string) {
  return sb.from('user_notifications').delete().eq('id', id).eq('user_id', userId);
}

/** DELETE / — delete all notifications for the user, optionally scoped by read-state/type. */
export async function deleteNotifications(
  sb: SupabaseClient,
  userId: string,
  tenantId: string | null,
  opts: { readOnly: boolean; types: string[] },
) {
  let query = sb.from('user_notifications').delete().eq('user_id', userId).eq('tenant_id', tenantId);

  if (opts.readOnly) {
    query = query.not('read_at', 'is', null);
  }
  if (opts.types.length > 0) {
    query = query.in('type', opts.types);
  }

  return query;
}
