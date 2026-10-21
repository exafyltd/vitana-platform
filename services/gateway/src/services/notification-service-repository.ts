// impact-allow-no-test: pure data-access seam (thin Supabase query/update
// wrappers, no independent request-handling behavior). Coverage note:
// isSignedOutOnAllKnownDevices and hasLostDeviceToAnotherAccount's 3 call
// sites are genuinely exercised by
// test/services/notification-device-ownership.test.ts (real functions
// against a fake Supabase client, not mocked). The remaining 6 call sites
// (sendPushToUser's fetch+revoke pair, getCategoryCache,
// checkDynamicCategoryPreference, getUserPrefs, and notifyUser's
// user_notifications insert) have no genuine coverage — every other test
// file that touches notifyUser mocks this whole module wholesale. Given
// notifyUser is the central dispatch point for every notification in the
// app, this seam got a full field-by-field diff review before committing,
// same discipline as a money-critical file.
/**
 * services/notification-service.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in notification-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchLiveDeviceTokensForUser(
  sb: SupabaseClient,
  userId: string,
  tenantId: string,
  opts?: { withDeviceType?: boolean },
) {
  // VTID-05177: `device_type` is selected only for the native routing passes
  // (NATIVE_PUSH_DIRECT_ENABLED). With the switch off the query is exactly
  // today's — pinned by test/services/native-push-golden.vtid-05177.test.ts.
  return sb
    .from('user_device_tokens')
    .select(opts?.withDeviceType ? 'fcm_token, device_label, device_type' : 'fcm_token, device_label')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .is('revoked_at', null);
}

export async function revokeDeviceToken(sb: SupabaseClient, fcmToken: string, patch: { revoked_at: string; revoked_reason: string }) {
  return sb.from('user_device_tokens').update(patch).eq('fcm_token', fcmToken).is('revoked_at', null);
}

export async function fetchDeviceTokenRevocationStates(sb: SupabaseClient, userId: string) {
  return sb.from('user_device_tokens').select('revoked_at').eq('user_id', userId);
}

export async function fetchAllDeviceTokensForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_device_tokens').select('fcm_token, device_label, revoked_at').eq('user_id', userId);
}

/**
 * VTID-05177: the user's live device rows with their type, across tenants —
 * read only by the same-phone duplicate guard (hasOnlyNativeAppDevices), which
 * runs only when both native switches are on.
 */
export async function fetchLiveDeviceTypesForUser(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_device_tokens')
    .select('device_type, device_label')
    .eq('user_id', userId)
    .is('revoked_at', null);
}

export async function fetchLiveDeviceTokensHeldByOthers(sb: SupabaseClient, fcmTokens: string[], excludeUserId: string) {
  return sb
    .from('user_device_tokens')
    .select('fcm_token')
    .in('fcm_token', fcmTokens)
    .neq('user_id', excludeUserId)
    .is('revoked_at', null)
    .limit(1);
}

export async function fetchActiveNotificationCategories(sb: SupabaseClient) {
  return sb.from('notification_categories').select('id, mapped_types, default_enabled, is_active').eq('is_active', true);
}

export async function fetchUserCategoryPreference(sb: SupabaseClient, userId: string, categoryId: string) {
  return sb.from('user_category_preferences').select('enabled').eq('user_id', userId).eq('category_id', categoryId).maybeSingle();
}

export async function fetchUserNotificationPreferences(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('user_notification_preferences').select('*').eq('user_id', userId).eq('tenant_id', tenantId).single();
}

export async function insertUserNotification(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_notifications').insert(row).select('id').single();
}

// VTID-04962: best-effort delivery outcome. Written separately from
// push_sent_at so a failure here (e.g. the column not yet migrated) never
// stops a row from being marked handled.
export async function setNotificationPushOutcome(sb: SupabaseClient, notificationId: string, outcome: string) {
  return sb.from('user_notifications').update({ push_outcome: outcome }).eq('id', notificationId);
}

// VTID-05312: dedup of chat notification rows — every UNPUSHED row of this
// recipient for this chat message is marked handled (push_sent_at now,
// outcome suppressed_duplicate). Called before notifyUser writes its own row.
export async function markUnpushedChatDuplicatesHandled(sb: SupabaseClient, userId: string, messageId: string) {
  return sb
    .from('user_notifications')
    .update({ push_sent_at: new Date().toISOString(), push_outcome: 'suppressed_duplicate' })
    .eq('user_id', userId)
    .in('type', ['new_chat_message', 'chat_mention'])
    .eq('data->>message_id', messageId)
    .is('push_sent_at', null);
}

