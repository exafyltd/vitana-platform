// impact-allow-no-test
// Genuinely tested via test/routes/scheduled-notifications-repository.test.ts,
// which drives a functional stub Supabase client (a from()-chain resolving to
// a configurable {data,error,count} response) — not a wholesale mock.
/**
 * routes/scheduled-notifications.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in scheduled-notifications.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param), same convention as every other *-repository.ts in this directory.
 *
 * This file is deliberately more heavily commented than most of its siblings
 * — several of these queries are load-bearing for real, documented production
 * incidents (see scheduled-notifications.ts's own section headers: VTID-03487
 * double-send, VTID-03656's 40-hour outage, the 33/181 silent-drop bug). Each
 * function below states which one it's part of where relevant, so a future
 * edit here doesn't accidentally reopen one of them.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// getActiveUsers() — pagination
// ---------------------------------------------------------------------------

export async function fetchActiveUsersPage(
  sb: any,
  args: { tenantId: string; offset: number; pageSize: number },
) {
  return sb
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', args.tenantId)
    .eq('is_primary', true)
    .order('user_id', { ascending: true })
    .range(args.offset, args.offset + args.pageSize - 1);
}

// ---------------------------------------------------------------------------
// findRecentlyNotified() — VTID-03487 idempotency guard
// ---------------------------------------------------------------------------

export async function fetchRecentlyNotifiedChunk(
  sb: any,
  args: { tenantId: string; type: string; since: string; userIdChunk: string[] },
) {
  return sb
    .from('user_notifications')
    .select('user_id')
    .eq('tenant_id', args.tenantId)
    .eq('type', args.type)
    .gte('created_at', args.since)
    .in('user_id', args.userIdChunk);
}

// ---------------------------------------------------------------------------
// gatherBriefingContext() — 7 parallel reads for the morning briefing
// ---------------------------------------------------------------------------

export function fetchBriefingFacts(sb: any, userId: string) {
  return sb
    .from('memory_facts')
    .select('fact_key, fact_value')
    .eq('user_id', userId)
    .in('fact_key', ['display_name', 'name', 'preferred_language']);
}

export function fetchBriefingHealthScores(sb: any, userId: string) {
  return sb
    .from('vitana_index_scores')
    .select('score_total')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(2);
}

export function fetchBriefingLatestDiaryEntry(sb: any, userId: string) {
  return sb
    .from('memory_items')
    .select('tags, metadata')
    .eq('user_id', userId)
    .eq('item_type', 'diary')
    .order('created_at', { ascending: false })
    .limit(1);
}

export function fetchBriefingPendingMatchCount(sb: any, args: { userId: string; tenantId: string }) {
  return sb
    .from('matches_daily')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', args.userId)
    .eq('tenant_id', args.tenantId)
    .is('feedback', null);
}

export function fetchBriefingNewRecCount(sb: any, userId: string) {
  return sb
    .from('autopilot_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'new')
    .or(`user_id.is.null,user_id.eq.${userId}`);
}

export function fetchBriefingConnectionCount(sb: any, args: { userId: string; tenantId: string }) {
  return sb
    .from('relationship_edges')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', args.userId)
    .eq('tenant_id', args.tenantId)
    .eq('target_type', 'person')
    .eq('relationship_type', 'connected');
}

export function fetchBriefingDiaryStreakEntries(sb: any, userId: string) {
  return sb
    .from('memory_items')
    .select('created_at')
    .eq('user_id', userId)
    .eq('item_type', 'diary')
    .order('created_at', { ascending: false })
    .limit(14);
}

// ---------------------------------------------------------------------------
// /daily-pace-notifications — VTID-03684-adjacent pre-insert dedup hint
// ---------------------------------------------------------------------------

export async function insertDailyPacePreNotification(sb: any, row: Record<string, unknown>) {
  return sb.from('user_notifications').insert(row);
}

// ---------------------------------------------------------------------------
// /daily-feature-tip — rotation state + tenant-wide announcement
// ---------------------------------------------------------------------------

export function fetchDidYouKnowState(sb: any, tenantId: string) {
  return sb.from('did_you_know_state').select('last_index').eq('tenant_id', tenantId).maybeSingle();
}

export function insertFeatureAnnouncement(sb: any, row: Record<string, unknown>) {
  return sb.from('feature_announcements').insert(row).select('id').single();
}

export function upsertDidYouKnowState(sb: any, args: { tenantId: string; lastIndex: number; updatedAt: string }) {
  return sb
    .from('did_you_know_state')
    .upsert({ tenant_id: args.tenantId, last_index: args.lastIndex, updated_at: args.updatedAt });
}

export function markFeatureAnnouncementNotified(sb: any, args: { announcementId: string; notifiedAt: string }) {
  return sb
    .from('feature_announcements')
    .update({ notified_at: args.notifiedAt })
    .eq('id', args.announcementId);
}

// ---------------------------------------------------------------------------
// /meetup-reminders — shared shape for both the 15min and 5min windows
// ---------------------------------------------------------------------------

export function fetchMeetupsStartingBetween(sb: any, args: { tenantId: string; from: string; to: string }) {
  return sb
    .from('community_meetups')
    .select('id, title, starts_at')
    .eq('tenant_id', args.tenantId)
    .gte('starts_at', args.from)
    .lte('starts_at', args.to);
}

export function fetchMeetupRsvps(sb: any, meetupId: string) {
  return sb
    .from('community_meetup_attendance')
    .select('user_id')
    .eq('meetup_id', meetupId)
    .eq('status', 'rsvp');
}

// ---------------------------------------------------------------------------
// /upcoming-events
// ---------------------------------------------------------------------------

export function fetchTodaysCalendarEvents(sb: any, args: { todayStart: string; todayEnd: string }) {
  return sb
    .from('calendar_events')
    .select('id, user_id, title, start_time, status')
    .neq('status', 'cancelled')
    .gte('start_time', args.todayStart)
    .lte('start_time', args.todayEnd)
    .order('start_time', { ascending: true });
}

// ---------------------------------------------------------------------------
// /recommendation-expiry
// ---------------------------------------------------------------------------

export function fetchExpiringRecommendations(sb: any, args: { tenantId: string; tomorrow: string; now: string }) {
  return sb
    .from('autopilot_recommendations')
    .select('id, user_id, title')
    .eq('tenant_id', args.tenantId)
    .eq('status', 'pending')
    .lte('expires_at', args.tomorrow)
    .gte('expires_at', args.now);
}

// ---------------------------------------------------------------------------
// /signal-cleanup
// ---------------------------------------------------------------------------

export function fetchActiveExpiredSignals(sb: any, args: { tenantId: string; now: string }) {
  return sb
    .from('d44_predictive_signals')
    .select('id, user_id')
    .eq('tenant_id', args.tenantId)
    .eq('status', 'active')
    .lte('expires_at', args.now);
}

export function markSignalExpired(sb: any, signalId: string) {
  return sb.from('d44_predictive_signals').update({ status: 'expired' }).eq('id', signalId);
}

// ---------------------------------------------------------------------------
// /push-dispatch — VTID-03656: the 40-hour outage this cron's own comment
// documents. The lookback bound and ordering here are load-bearing; keep
// them exactly as-is if this function is ever touched again.
// ---------------------------------------------------------------------------

export function fetchPendingPushNotifications(sb: any, lookbackCutoff: string) {
  return sb
    .from('user_notifications')
    .select('id, user_id, tenant_id, type, title, body, data, channel, priority, created_at')
    .is('push_sent_at', null)
    .in('channel', ['push', 'push_and_inapp'])
    .gte('created_at', lookbackCutoff)
    .order('created_at', { ascending: true })
    .limit(100);
}

export function fetchUserNotificationPreferences(sb: any, args: { userId: string; tenantId: string }) {
  return sb
    .from('user_notification_preferences')
    .select('*')
    .eq('user_id', args.userId)
    .eq('tenant_id', args.tenantId)
    .maybeSingle();
}

export function markNotificationPushSent(sb: any, notificationId: string, pushSentAt: string) {
  return sb.from('user_notifications').update({ push_sent_at: pushSentAt }).eq('id', notificationId);
}

// ---------------------------------------------------------------------------
// /recommendation-cleanup — VTID-01185
// ---------------------------------------------------------------------------

export function expireOverdueRecommendations(sb: any, now: string) {
  return sb
    .from('autopilot_recommendations')
    .update({ status: 'rejected', updated_at: now })
    .eq('status', 'new')
    .not('expires_at', 'is', null)
    .lt('expires_at', now);
}

export function unsnoozeOverdueRecommendations(sb: any, now: string) {
  return sb
    .from('autopilot_recommendations')
    .update({ status: 'new', snoozed_until: null, updated_at: now })
    .eq('status', 'snoozed')
    .lt('snoozed_until', now);
}

export function purgeStaleRecommendationSeeds(sb: any, args: { now: string; thirtyDaysAgo: string }) {
  return sb
    .from('autopilot_recommendations')
    .update({ status: 'rejected', updated_at: args.now })
    .eq('status', 'new')
    .is('fingerprint', null)
    .lt('created_at', args.thirtyDaysAgo);
}

export function rpcCleanupExpiredAutopilotRecommendations(sb: any) {
  return sb.rpc('cleanup_expired_autopilot_recommendations');
}

// ---------------------------------------------------------------------------
// /reminders-tick — VTID-02601
// ---------------------------------------------------------------------------

export function rpcClaimDueReminders(sb: any, args: { lookaheadSeconds: number; limit: number }) {
  return sb.rpc('reminders_claim_due', {
    p_lookahead_seconds: args.lookaheadSeconds,
    p_limit: args.limit,
  });
}

export function fallbackClaimDueReminders(sb: any, args: { lookahead: string; dispatchStartedAt: string; limit: number }) {
  return sb
    .from('reminders')
    .update({ status: 'dispatching', dispatch_started_at: args.dispatchStartedAt })
    .eq('status', 'pending')
    .lte('next_fire_at', args.lookahead)
    .select('*')
    .limit(args.limit);
}

export function markReminderFired(sb: any, args: { reminderId: string; firedAt: string }) {
  return sb
    .from('reminders')
    .update({ status: 'fired', fired_at: args.firedAt })
    .eq('id', args.reminderId);
}

// ---------------------------------------------------------------------------
// /reminders-sweeper — VTID-02601
// ---------------------------------------------------------------------------

export function fetchStuckDispatchingReminders(sb: any, args: { cutoff: string; limit: number }) {
  return sb
    .from('reminders')
    .select('id, dispatch_attempts')
    .eq('status', 'dispatching')
    .lt('dispatch_started_at', args.cutoff)
    .limit(args.limit);
}

export function updateReminderRecoveryStatus(
  sb: any,
  args: { reminderId: string; newStatus: 'pending' | 'failed'; attempts: number },
) {
  return sb
    .from('reminders')
    .update({
      status: args.newStatus,
      dispatch_attempts: args.attempts,
      dispatch_started_at: null,
    })
    .eq('id', args.reminderId);
}

// ---------------------------------------------------------------------------
// scheduleReminderFcmPush() — VTID-03481 Appilix/FCM coexistence
// ---------------------------------------------------------------------------

export function countAppilixNativeDeviceTokens(sb: any, args: { userId: string; tenantId: string }) {
  return sb
    .from('user_device_tokens')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', args.userId)
    .eq('tenant_id', args.tenantId)
    .is('revoked_at', null)
    .like('device_label', 'Appilix %');
}

export function markReminderDeliveredViaFcm(sb: any, reminderId: string) {
  return sb
    .from('reminders')
    .update({ delivery_via: 'fcm' })
    .eq('id', reminderId)
    .is('acked_at', null);
}

// ---------------------------------------------------------------------------
// /night-push — VTID-03604
// ---------------------------------------------------------------------------

export function fetchUserJourneyNightDates(sb: any, userId: string) {
  return sb
    .from('user_journey')
    .select('last_day_close_date, last_night_push_date')
    .eq('user_id', userId)
    .maybeSingle();
}

export function updateLastNightPushDate(sb: any, args: { userId: string; nightKey: string }) {
  return sb
    .from('user_journey')
    .update({ last_night_push_date: args.nightKey })
    .eq('user_id', args.userId);
}
