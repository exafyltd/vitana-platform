/**
 * Notification Service — Firebase Cloud Messaging (server-side)
 *
 * Unified notification dispatch with:
 *  - Channel routing (push / inapp / push_and_inapp / silent)
 *  - Priority tiers (p0–p3)
 *  - User preference gating (checks user_notification_preferences)
 *  - Quiet-hours / DND enforcement
 *  - Stale-token auto-cleanup
 *  - Appilix Native Push (Android Maxina app via appilix.com API)
 *
 * Uses firebase-admin with Application Default Credentials (ADC)
 * which works automatically on Cloud Run.
 */

import * as admin from 'firebase-admin';
import { SupabaseClient } from '@supabase/supabase-js';

// Initialize Firebase Admin (once)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: 'lovable-vitana-vers1',
  });
}

const fcm = admin.messaging();

// ── Types ────────────────────────────────────────────────────

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>; // FCM data payload (all values must be strings)
}

type Channel = 'push' | 'inapp' | 'push_and_inapp' | 'silent';
type Priority = 'p0' | 'p1' | 'p2' | 'p3';
type Category =
  | 'match' | 'community' | 'meetup' | 'live_room' | 'chat'
  | 'calendar' | 'recommendation' | 'health' | 'signal'
  | 'opportunity' | 'diary' | 'social' | 'offer' | 'growth' | 'system';

interface TypeMeta { channel: Channel; priority: Priority; category: Category }

// ── Server-side notification type metadata ────────────────────
// Mirrors the frontend registry but only the fields needed for routing.

export const TYPE_META: Record<string, TypeMeta> = {
  // Matchmaking
  new_daily_matches:         { channel: 'push_and_inapp', priority: 'p1', category: 'match' },
  person_match_suggested:    { channel: 'push_and_inapp', priority: 'p1', category: 'match' },
  group_match_suggested:     { channel: 'inapp',          priority: 'p2', category: 'match' },
  event_match_suggested:     { channel: 'push_and_inapp', priority: 'p1', category: 'match' },
  live_room_match_suggested: { channel: 'push_and_inapp', priority: 'p1', category: 'match' },
  match_accepted_by_other:   { channel: 'push_and_inapp', priority: 'p1', category: 'match' },
  your_match_accepted:       { channel: 'push_and_inapp', priority: 'p1', category: 'match' },
  // Community
  someone_joined_your_group:  { channel: 'inapp',          priority: 'p2', category: 'community' },
  group_recommended:          { channel: 'push_and_inapp', priority: 'p2', category: 'community' },
  group_activity_update:      { channel: 'inapp',          priority: 'p2', category: 'community' },
  new_member_in_group:        { channel: 'inapp',          priority: 'p3', category: 'community' },
  group_milestone_reached:    { channel: 'inapp',          priority: 'p2', category: 'community' },
  group_invitation_received:  { channel: 'push_and_inapp', priority: 'p1', category: 'community' },
  post_like:                  { channel: 'push_and_inapp', priority: 'p1', category: 'community' },
  post_comment:               { channel: 'push_and_inapp', priority: 'p1', category: 'community' },
  // Meetups
  meetup_recommended:        { channel: 'push_and_inapp', priority: 'p2', category: 'meetup' },
  meetup_starting_soon:      { channel: 'push_and_inapp', priority: 'p0', category: 'meetup' },
  meetup_starting_now:       { channel: 'push',           priority: 'p0', category: 'meetup' },
  meetup_rsvp_confirmed:     { channel: 'inapp',          priority: 'p2', category: 'meetup' },
  someone_rsvpd_your_meetup: { channel: 'inapp',          priority: 'p2', category: 'meetup' },
  meetup_cancelled:          { channel: 'push_and_inapp', priority: 'p1', category: 'meetup' },
  new_meetup_in_group:       { channel: 'push_and_inapp', priority: 'p1', category: 'meetup' },
  // Live Rooms
  live_room_starting:        { channel: 'push_and_inapp', priority: 'p0', category: 'live_room' },
  someone_joined_live_room:  { channel: 'inapp',          priority: 'p2', category: 'live_room' },
  live_room_ended_summary:   { channel: 'push_and_inapp', priority: 'p2', category: 'live_room' },
  live_room_highlight_added: { channel: 'inapp',          priority: 'p3', category: 'live_room' },
  live_room_invite:          { channel: 'push_and_inapp', priority: 'p1', category: 'live_room' },
  live_room_recording_ready: { channel: 'inapp',          priority: 'p3', category: 'live_room' },
  // Chat
  new_chat_message:                { channel: 'push_and_inapp', priority: 'p1', category: 'chat' },
  orb_proactive_message:           { channel: 'push_and_inapp', priority: 'p1', category: 'chat' },
  conversation_followup_reminder:  { channel: 'inapp',          priority: 'p2', category: 'chat' },
  orb_suggestion:                  { channel: 'push_and_inapp', priority: 'p1', category: 'chat' },
  // Emitted by the notify_on_reaction() Postgres trigger on message_reactions
  // inserts (not via notifyUser()), so this entry is documentation/parity
  // only — the trigger hardcodes the same channel/priority in its INSERT.
  message_reaction:                { channel: 'push_and_inapp', priority: 'p2', category: 'chat' },
  // Calendar
  daily_recompute_complete:  { channel: 'silent',          priority: 'p3', category: 'calendar' },
  morning_briefing_ready:    { channel: 'push_and_inapp', priority: 'p1', category: 'calendar' },
  daily_pace_check:          { channel: 'push_and_inapp', priority: 'p2', category: 'calendar' },
  // My Journey celebrations — fired by /api/v1/celebrations/dispatch from
  // the frontend when a milestone is detected client-side. Channel is
  // push_and_inapp because the user explicitly opted into "always push,
  // even if app is open" so the celebration also lands on lock screen.
  daily_goal_celebration:        { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
  phase_milestone_celebration:   { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
  progress_milestone_celebration:{ channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
  upcoming_event_today:      { channel: 'push',           priority: 'p1', category: 'calendar' },
  weekly_community_digest:   { channel: 'push_and_inapp', priority: 'p2', category: 'calendar' },
  // Recommendations
  new_recommendation:             { channel: 'push_and_inapp', priority: 'p1', category: 'recommendation' },
  recommendation_expires_soon:    { channel: 'inapp',          priority: 'p2', category: 'recommendation' },
  high_impact_recommendation:     { channel: 'push_and_inapp', priority: 'p0', category: 'recommendation' },
  recommendation_activated:       { channel: 'inapp',          priority: 'p2', category: 'recommendation' },
  // Health
  daily_vitana_index_ready: { channel: 'inapp',          priority: 'p2', category: 'health' },
  health_score_improvement: { channel: 'push_and_inapp', priority: 'p1', category: 'health' },
  health_score_decline:     { channel: 'push_and_inapp', priority: 'p0', category: 'health' },
  longevity_signal_alert:   { channel: 'push_and_inapp', priority: 'p0', category: 'health' },
  lab_report_processed:     { channel: 'inapp',          priority: 'p2', category: 'health' },
  wearable_data_synced:     { channel: 'silent',          priority: 'p3', category: 'health' },
  // Signals
  predictive_signal_detected:  { channel: 'push_and_inapp', priority: 'p0', category: 'signal' },
  positive_momentum_detected:  { channel: 'inapp',          priority: 'p2', category: 'signal' },
  social_withdrawal_signal:    { channel: 'push_and_inapp', priority: 'p0', category: 'signal' },
  risk_mitigation_suggestion:  { channel: 'push_and_inapp', priority: 'p1', category: 'signal' },
  signal_expired:              { channel: 'silent',          priority: 'p3', category: 'signal' },
  // Opportunities
  opportunity_surfaced:          { channel: 'push_and_inapp', priority: 'p1', category: 'opportunity' },
  opportunity_expiring:          { channel: 'inapp',          priority: 'p2', category: 'opportunity' },
  health_priority_opportunity:   { channel: 'push_and_inapp', priority: 'p0', category: 'opportunity' },
  // Diary
  daily_diary_reminder:    { channel: 'push',           priority: 'p2', category: 'diary' },
  diary_streak_milestone:  { channel: 'push_and_inapp', priority: 'p2', category: 'diary' },
  memory_garden_grew:      { channel: 'silent',          priority: 'p3', category: 'diary' },
  weekly_reflection_prompt: { channel: 'push_and_inapp', priority: 'p2', category: 'diary' },
  // Social
  new_connection_formed:              { channel: 'push_and_inapp', priority: 'p1', category: 'social' },
  relationship_strength_increased:    { channel: 'inapp',          priority: 'p3', category: 'social' },
  comfort_boundary_respected:         { channel: 'silent',          priority: 'p3', category: 'social' },
  // Offers
  service_recommendation:   { channel: 'inapp', priority: 'p2', category: 'offer' },
  product_recommendation:   { channel: 'inapp', priority: 'p2', category: 'offer' },
  usage_outcome_checkin:    { channel: 'inapp', priority: 'p3', category: 'offer' },
  // Growth
  invite_friends_prompt:      { channel: 'inapp',          priority: 'p2', category: 'growth' },
  friend_joined_vitana:       { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
  friend_joined_your_group:   { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
  people_near_you:            { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
  weekly_community_growth:    { channel: 'inapp',          priority: 'p3', category: 'growth' },
  someone_wants_to_connect:   { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
  // System
  welcome_to_vitana:           { channel: 'push_and_inapp', priority: 'p1', category: 'system' },
  complete_your_profile:       { channel: 'inapp',          priority: 'p2', category: 'system' },
  onboarding_step_completed:   { channel: 'inapp',          priority: 'p3', category: 'system' },
  weekly_activity_summary:     { channel: 'push_and_inapp', priority: 'p2', category: 'system' },
  feature_announcement:        { channel: 'push_and_inapp', priority: 'p2', category: 'system' },
  // BOOTSTRAP-COMMUNITY-MARKETPLACE: seller-facing moderation outcomes
  marketplace_listing_approved: { channel: 'push_and_inapp', priority: 'p2', category: 'system' },
  marketplace_listing_rejected: { channel: 'push_and_inapp', priority: 'p1', category: 'system' },
  marketplace_listing_removed:  { channel: 'push_and_inapp', priority: 'p1', category: 'system' },
  // BOOTSTRAP-COMMUNITY-MARKETPLACE (Chunk 5): buyer's first contact message
  // on a listing — category 'chat' (not 'system') so it respects the same
  // chat notification preference as new_chat_message, since it IS a chat
  // message, just with listing-specific copy instead of the generic sender-name title.
  listing_interest:            { channel: 'push_and_inapp', priority: 'p1', category: 'chat' },
  // Admin Companion (BOOTSTRAP-ADMIN-EE)
  admin_insight_urgent:        { channel: 'push_and_inapp', priority: 'p0', category: 'system' },
  admin_insight_action_needed: { channel: 'inapp',          priority: 'p1', category: 'system' },
  // Billing lifecycle (VTID-03107) — Duolingo-style trial / cancel / win-back
  trial_welcome:               { channel: 'push_and_inapp', priority: 'p1', category: 'system' },
  trial_midpoint:              { channel: 'inapp',          priority: 'p2', category: 'system' },
  trial_ending_2d:             { channel: 'push_and_inapp', priority: 'p1', category: 'system' },
  trial_ending_1d:             { channel: 'push_and_inapp', priority: 'p1', category: 'system' },
  trial_cancelled_winback:     { channel: 'inapp',          priority: 'p2', category: 'system' },
  trial_winback_one_shot:      { channel: 'inapp',          priority: 'p3', category: 'system' },
  founding_midpoint:           { channel: 'inapp',          priority: 'p2', category: 'system' },
  founding_ending_2d:          { channel: 'push_and_inapp', priority: 'p1', category: 'system' },
  founding_ending_1d:          { channel: 'push_and_inapp', priority: 'p1', category: 'system' },
  // Wallet & Business (VTID-01250)
  wallet_credits_earned:       { channel: 'push_and_inapp', priority: 'p1', category: 'offer' },
  wallet_payout_received:      { channel: 'push_and_inapp', priority: 'p1', category: 'offer' },
  wallet_payout_failed:        { channel: 'push_and_inapp', priority: 'p0', category: 'offer' },
  creator_earnings_report:     { channel: 'inapp',          priority: 'p2', category: 'offer' },
  creator_setup_reminder:      { channel: 'push_and_inapp', priority: 'p1', category: 'offer' },
  // Sharing & Referrals (VTID-01250)
  referral_signup:             { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
  referral_reward_earned:      { channel: 'push_and_inapp', priority: 'p1', category: 'growth' },
  share_countdown_prompt:      { channel: 'inapp',          priority: 'p2', category: 'growth' },
  // VTID-01975: Vitana Intent Engine (P2-B). Category 'opportunity' so users
  // can silence the whole bucket via existing notification preferences.
  // p0 reserved for partner_seek reciprocal-reveal — high stakes + rare.
  intent_match_found_for_dictator:    { channel: 'push_and_inapp', priority: 'p1', category: 'opportunity' },
  intent_lead_for_counterparty:       { channel: 'push_and_inapp', priority: 'p1', category: 'opportunity' },
  intent_mutual_interest:             { channel: 'push_and_inapp', priority: 'p1', category: 'opportunity' },
  intent_partner_reciprocal_revealed: { channel: 'push_and_inapp', priority: 'p0', category: 'opportunity' },
  intent_compass_change_resurface:    { channel: 'inapp',          priority: 'p2', category: 'opportunity' },
  intent_throttled:                   { channel: 'inapp',          priority: 'p2', category: 'opportunity' },
  intent_proactive_prompt_summary:    { channel: 'inapp',          priority: 'p3', category: 'system' },
};

// Category → preference column in user_notification_preferences
const CATEGORY_PREF: Record<Category, string> = {
  match:          'match_notifications',
  community:      'community_notifications',
  meetup:         'community_notifications',
  live_room:      'live_room_notifications',
  chat:           'push_enabled',           // chat inherits global toggle
  calendar:       'push_enabled',
  recommendation: 'recommendation_notifications',
  health:         'health_notifications',
  signal:         'health_notifications',
  opportunity:    'recommendation_notifications',
  diary:          'memory_notifications',
  social:         'social_notifications',
  offer:          'recommendation_notifications',
  growth:         'social_notifications',
  system:         'system_notifications',
};

// ── Low-level FCM Send ───────────────────────────────────────

/**
 * Send push notification to a single FCM token.
 * Returns false if the token is stale (should be removed).
 */
export async function sendPushNotification(
  deviceToken: string,
  payload: NotificationPayload
): Promise<boolean> {
  try {
    await fcm.send({
      token: deviceToken,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data,
      webpush: {
        fcmOptions: {
          link: payload.data?.url || '/',
        },
      },
    });
    return true;
  } catch (err: any) {
    const code = err.code || err.errorInfo?.code || '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      console.warn('[Notifications] Stale FCM token, will remove:', deviceToken.slice(0, 20) + '...');
      return false;
    }
    console.error('[Notifications] FCM send error:', err.message || err);
    return true; // Don't remove token on transient errors
  }
}

/**
 * Fan-out push to all devices of a user. Cleans stale tokens.
 */
export async function sendPushToUser(
  userId: string,
  tenantId: string,
  payload: NotificationPayload,
  supabase: SupabaseClient<any, any, any>,
  opts?: { excludeAppilixTagged?: boolean }
): Promise<number> {
  const { data: tokens } = await supabase
    .from('user_device_tokens')
    .select('fcm_token, device_label')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    // Only devices this user still OWNS (VTID-03481). A revoked row means the
    // device was taken over by another account, or the user signed out on it —
    // pushing there would buzz a phone that now belongs to someone else, which
    // is how one device ended up receiving the same post notification once per
    // account that had ever signed in on it.
    .is('revoked_at', null);

  if (!tokens?.length) return 0;

  // Tokens registered from inside the Appilix WebView (tagged "Appilix " by
  // registerAppilixDevice()) can only be tapped safely via an Appilix-native
  // push — a raw FCM push to that same device is what crashes the WebView
  // (see the comment in notifyUser()). Callers that already tried Appilix
  // and got no device pass excludeAppilixTagged so we don't repeat the
  // crash-causing delivery on the very token Appilix just told us it can't
  // reach.
  const targets = opts?.excludeAppilixTagged
    ? tokens.filter((t) => !t.device_label?.startsWith('Appilix '))
    : tokens;

  if (!targets.length) return 0;

  let sent = 0;
  for (const { fcm_token } of targets) {
    const ok = await sendPushNotification(fcm_token, payload);
    if (ok) {
      sent++;
    } else {
      // FCM rejected the token as unregistered/invalid — it is dead for every
      // owner, so revoke it outright rather than scoping to this user.
      await supabase
        .from('user_device_tokens')
        .update({ revoked_at: new Date().toISOString(), revoked_reason: 'fcm_invalid' })
        .eq('fcm_token', fcm_token)
        .is('revoked_at', null);
    }
  }
  return sent;
}

/**
 * True when this user has device tokens on record but every one of them has
 * been revoked — i.e. they are signed out on every device we know about.
 *
 * VTID-03481. Appilix push targets by user_identity, NOT by device token, and
 * Appilix's own identity→device registry keeps stale mappings that we have no
 * API to purge. So after two accounts have been used on one phone, an Appilix
 * push addressed to the account that is no longer signed in STILL lands on that
 * phone — in that account's language. Fixing the token table alone therefore
 * would not have stopped the duplicate lock-screen notifications; this gate is
 * what actually suppresses the second copy.
 *
 * Deliberately returns false when the user has NO rows at all: that is the
 * legitimate legacy case (an iOS Appilix shell whose bridge never captured an
 * FCM token) which depends on the user_identity fallback and must keep working.
 */
export async function isSignedOutOnAllKnownDevices(
  userId: string,
  supabase: SupabaseClient<any, any, any>
): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_device_tokens')
    .select('revoked_at')
    .eq('user_id', userId);

  // On a query error, fail OPEN (deliver). A missed notification is worse than
  // a duplicate one, and the token takeover already removes most duplicates.
  if (error || !data?.length) return false;
  return data.every((row: { revoked_at: string | null }) => row.revoked_at !== null);
}

/**
 * A phone this user no longer owns must stop buzzing, even while the user is
 * still signed in somewhere else. (VTID-03507)
 *
 * `isSignedOutOnAllKnownDevices` above only suppresses Appilix for a user who
 * is signed out on EVERY device. That misses the common real case and left the
 * duplicate in place: someone hands the phone over (or signs a second account
 * into it) but stays signed in on their laptop. Their phone claim is revoked,
 * their desktop claim is live, so "signed out everywhere" is false — and
 * Appilix, which addresses devices by `user_identity` and keeps stale
 * identity→device mappings we cannot purge, keeps delivering that account's
 * copy to the phone. Two accounts, two languages, one lock screen.
 *
 * Observed exactly this way: one Android token held live by the current owner
 * (de) and revoked for the previous owner (en), who still had a live Windows
 * desktop claim — and whose English copy still arrived on the phone.
 *
 * Suppress when BOTH hold:
 *   1. the user has no live claim on any NATIVE (app-shell) device — a live
 *      desktop/web claim is irrelevant here, Appilix cannot reach a browser; and
 *   2. one of their revoked native claims is now held live by a DIFFERENT
 *      account — i.e. that phone demonstrably belongs to someone else now.
 *
 * Both conditions together keep this narrow: a user who still has the app on
 * their own phone is never suppressed, and neither is one whose claim lapsed
 * without anyone else taking the device over. Fails OPEN on any query error.
 */
export async function hasLostDeviceToAnotherAccount(
  userId: string,
  supabase: SupabaseClient<any, any, any>
): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_device_tokens')
    .select('fcm_token, device_label, revoked_at')
    .eq('user_id', userId);
  if (error || !data?.length) return false;

  type Row = { fcm_token: string; device_label: string | null; revoked_at: string | null };
  const rows = data as Row[];

  // Native app-shell devices are the only ones Appilix can reach. The frontend's
  // registerAppilixDevice() prefixes the label with "Appilix "; the wrapper's own
  // WebView UA also carries an "App<NN>" build token (App9/App10/App95/App96…).
  // Plain browser UAs match neither — note "AppleWebKit" has no digits after
  // "App", so it cannot false-positive here.
  const isNative = (label: string | null) => /appilix|\bApp\d+\b/i.test(label || '');

  if (rows.some((r) => r.revoked_at === null && isNative(r.device_label))) return false;

  const lostNativeTokens = rows
    .filter((r) => r.revoked_at !== null && isNative(r.device_label))
    .map((r) => r.fcm_token);
  if (!lostNativeTokens.length) return false;

  const { data: heldByOthers, error: othersErr } = await supabase
    .from('user_device_tokens')
    .select('fcm_token')
    .in('fcm_token', lostNativeTokens)
    .neq('user_id', userId)
    .is('revoked_at', null)
    .limit(1);
  if (othersErr) return false;
  return !!heldByOthers?.length;
}

// ── Appilix Native Push (Maxina iOS + Android apps) ──────────

/**
 * MAXINA is registered as TWO SEPARATE Appilix apps (confirmed on the
 * Appilix dashboard: one card tagged "iOS", one tagged "Android" — same
 * https://vitanaland.com source, but each has its OWN app_key/api_key and
 * its own pool of registered devices/user_identity mappings). A push call
 * with one platform's credentials only reaches devices registered under
 * THAT app — sending only Android credentials silently no-ops for every
 * iOS user (this is exactly what happened: Android delivery worked after
 * APPILIX_APP_KEY/APPILIX_API_KEY were wired up, iOS stayed silent).
 * sendAppilixPush() therefore fans out across every configured platform's
 * credentials and succeeds if ANY of them delivers. Appilix returns HTTP
 * 200 with status:false ("No devices...") for the platform a given user
 * isn't on — that's an expected, harmless outcome of trying the other
 * platform, not a real failure.
 */
function getAppilixCredentialSets(): Array<{ platform: string; appKey: string; apiKey: string }> {
  const sets: Array<{ platform: string; appKey: string; apiKey: string }> = [];
  if (process.env.APPILIX_APP_KEY && process.env.APPILIX_API_KEY) {
    sets.push({ platform: 'android', appKey: process.env.APPILIX_APP_KEY, apiKey: process.env.APPILIX_API_KEY });
  }
  if (process.env.APPILIX_IOS_APP_KEY && process.env.APPILIX_IOS_API_KEY) {
    sets.push({ platform: 'ios', appKey: process.env.APPILIX_IOS_APP_KEY, apiKey: process.env.APPILIX_IOS_API_KEY });
  }
  return sets;
}

/**
 * Send push notification via the Appilix Push Notification API for ONE
 * platform's credentials. This delivers a native notification branded as
 * "Maxina" (not a Chrome browser notification).
 *
 * User identity is mapped via window.appilix_push_notification_user_identity
 * in the Appilix Custom JS (set to the Supabase user ID).
 */
async function sendAppilixPushWithCredentials(
  userId: string,
  payload: NotificationPayload,
  platform: string,
  appKey: string,
  apiKey: string
): Promise<boolean> {
  try {
    // Appilix API does NOT decode open_link_url (confirmed by their support),
    // so that field must be sent raw. However, notification_title and
    // notification_body CAN contain user input with &, =, + etc. which would
    // corrupt the form body. Encode those fields to keep the body well-formed;
    // Appilix decodes standard display fields normally for the push text.
    const safeTitle = encodeURIComponent(payload.title);
    const safeBody = encodeURIComponent(payload.body);
    const bodyParts = [
      `app_key=${appKey}`,
      `api_key=${apiKey}`,
      `notification_title=${safeTitle}`,
      `notification_body=${safeBody}`,
      `user_identity=${userId}`,
    ];
    const url = payload.data?.url;
    let resolvedOpenLink: string | undefined;
    if (url) {
      const baseUrl = process.env.APPILIX_APP_URL || 'https://vitanaland.com';
      resolvedOpenLink = url.startsWith('http') ? url : `${baseUrl}${url}`;
      bodyParts.push(`open_link_url=${resolvedOpenLink}`);
    }

    console.log(
      `[Appilix] push(${platform}) user=${userId.slice(0, 8)}… ` +
      `title=${JSON.stringify(payload.title)} ` +
      `body_len=${payload.body.length} ` +
      `open_link_url=${JSON.stringify(resolvedOpenLink ?? null)}`
    );

    const res = await fetch('https://appilix.com/api/push-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParts.join('&'),
    });

    const text = await res.text().catch(() => '');

    if (!res.ok) {
      console.warn(`[Notifications] Appilix(${platform}) push failed (${res.status}):`, text);
      return false;
    }

    // Appilix returns HTTP 200 with { status: false, message: "No devices..." }
    // when delivery fails (e.g. no device registered for that user_identity —
    // expected/harmless when this user isn't on this platform's app).
    // Parse the JSON body and treat status:false as failure so the log
    // accurately reflects what Appilix did.
    let parsed: { status?: boolean | string; message?: string } | null = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const ok = parsed?.status === true || parsed?.status === 'true';
    if (!ok) {
      console.warn(
        `[Notifications] Appilix(${platform}) push DROPPED for user=${userId.slice(0, 8)}…: ` +
        `${parsed?.message || text}`
      );
      return false;
    }
    console.log(`[Notifications] Appilix(${platform}) push sent for user=${userId.slice(0, 8)}…`);
    return true;
  } catch (err: any) {
    console.error(`[Notifications] Appilix(${platform}) push error:`, err.message || err);
    return false;
  }
}

/**
 * Public entry point — fans out across every configured Appilix platform
 * (Android, iOS). Returns true if ANY platform's push actually delivered.
 * A platform with no configured credentials is skipped, not attempted.
 */
export async function sendAppilixPush(
  userId: string,
  payload: NotificationPayload
): Promise<boolean> {
  const credentialSets = getAppilixCredentialSets();
  if (credentialSets.length === 0) return false;

  const results = await Promise.all(
    credentialSets.map((c) => sendAppilixPushWithCredentials(userId, payload, c.platform, c.appKey, c.apiKey))
  );
  return results.some((sent) => sent === true);
}

// ── Dynamic Category Preference Check ────────────────────────
// In-memory cache for notification_categories (avoids DB hit per notification)

interface CategoryCacheEntry {
  categoryId: string;
  defaultEnabled: boolean;
  isActive: boolean;
}

let categoryCache: Map<string, CategoryCacheEntry> | null = null;
let categoryCacheExpiry = 0;
const CATEGORY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getCategoryCache(
  supabase: SupabaseClient<any, any, any>
): Promise<Map<string, CategoryCacheEntry>> {
  if (categoryCache && Date.now() < categoryCacheExpiry) {
    return categoryCache;
  }

  const { data, error } = await supabase
    .from('notification_categories')
    .select('id, mapped_types, default_enabled, is_active')
    .eq('is_active', true);

  const cache = new Map<string, CategoryCacheEntry>();
  if (!error && data) {
    for (const cat of data) {
      const mappedTypes = (cat.mapped_types as string[]) || [];
      for (const typeKey of mappedTypes) {
        cache.set(typeKey, {
          categoryId: cat.id,
          defaultEnabled: cat.default_enabled,
          isActive: cat.is_active,
        });
      }
    }
  }

  categoryCache = cache;
  categoryCacheExpiry = Date.now() + CATEGORY_CACHE_TTL_MS;
  return cache;
}

/**
 * Check dynamic category preference for a notification type.
 * Returns { suppressed: false } if no category mapping exists or user has not disabled it.
 * Returns { suppressed: true, reason: string } if user has disabled this category.
 */
async function checkDynamicCategoryPreference(
  userId: string,
  tenantId: string,
  type: string,
  supabase: SupabaseClient<any, any, any>
): Promise<{ suppressed: boolean; reason?: string }> {
  try {
    const cache = await getCategoryCache(supabase);
    const entry = cache.get(type);

    // No mapping → pass through (unmapped types are never suppressed by the new system)
    if (!entry) return { suppressed: false };

    // Check user's preference for this category
    const { data: userPref } = await supabase
      .from('user_category_preferences')
      .select('enabled')
      .eq('user_id', userId)
      .eq('category_id', entry.categoryId)
      .maybeSingle();

    const enabled = userPref ? userPref.enabled : entry.defaultEnabled;

    if (!enabled) {
      return { suppressed: true, reason: `category_${type}_disabled` };
    }

    return { suppressed: false };
  } catch (err: any) {
    // On error, don't suppress — fail open to avoid blocking notifications
    console.error('[Notifications] Dynamic category check error:', err.message);
    return { suppressed: false };
  }
}

// ── Preference & DND Check ───────────────────────────────────

interface UserPrefs {
  push_enabled: boolean;
  dnd_enabled: boolean;
  dnd_start_time: string | null;
  dnd_end_time: string | null;
  [key: string]: any;
}

async function getUserPrefs(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient<any, any, any>
): Promise<UserPrefs | null> {
  const { data } = await supabase
    .from('user_notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .single();
  return data as UserPrefs | null;
}

function isInDndWindow(prefs: UserPrefs): boolean {
  if (!prefs.dnd_enabled || !prefs.dnd_start_time || !prefs.dnd_end_time) return false;

  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const start = prefs.dnd_start_time; // e.g. "22:00"
  const end = prefs.dnd_end_time;     // e.g. "07:00"

  // Handle overnight spans (e.g. 22:00–07:00)
  if (start > end) {
    return hhmm >= start || hhmm < end;
  }
  return hhmm >= start && hhmm < end;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Primary dispatch — writes in-app record + optionally sends push,
 * respecting channel, priority, user preferences, and DND.
 *
 * Returns { pushed: number; inapp: boolean; suppressed?: string }
 */
export async function notifyUser(
  userId: string,
  tenantId: string,
  type: string,
  payload: NotificationPayload,
  supabase: SupabaseClient<any, any, any>
): Promise<{ pushed: number; inapp: boolean; suppressed?: string }> {
  const meta = TYPE_META[type] || { channel: 'push_and_inapp' as Channel, priority: 'p2' as Priority, category: 'system' as Category };

  // ── 1. Check user preferences ────────────────────────────
  const prefs = await getUserPrefs(userId, tenantId, supabase);

  // If the user has prefs, check the category toggle
  if (prefs) {
    // Global push gate
    if (!prefs.push_enabled && meta.channel !== 'silent') {
      // Push is off globally — downgrade channel to inapp-only
      if (meta.channel === 'push') {
        // push-only notification with push disabled → suppress entirely
        return { pushed: 0, inapp: false, suppressed: 'push_disabled' };
      }
      // push_and_inapp → inapp only (handled below by not sending push)
    }

    // Category-specific gate (legacy boolean columns)
    const prefCol = CATEGORY_PREF[meta.category];
    if (prefCol && prefCol !== 'push_enabled' && prefs[prefCol] === false) {
      return { pushed: 0, inapp: false, suppressed: `pref_${prefCol}_off` };
    }
  }

  // ── 1b. Check dynamic category preferences (new system) ──
  const categoryCheckResult = await checkDynamicCategoryPreference(
    userId, tenantId, type, supabase
  );
  if (categoryCheckResult.suppressed) {
    return { pushed: 0, inapp: false, suppressed: categoryCheckResult.reason };
  }

  // ── 2. DND check (only blocks push, not inapp) ──────────
  const isDnd = prefs ? isInDndWindow(prefs) : false;
  // P0 (critical) notifications bypass DND
  const pushBlockedByDnd = isDnd && meta.priority !== 'p0';

  // ── 3. Determine effective actions ───────────────────────
  const shouldWriteInapp = meta.channel !== 'push'; // inapp, push_and_inapp, silent all write
  const shouldSendPush =
    (meta.channel === 'push' || meta.channel === 'push_and_inapp') &&
    !pushBlockedByDnd &&
    (prefs ? prefs.push_enabled !== false : true);

  // ── 4. Write in-app notification record ──────────────────
  // When shouldSendPush is true, set push_sent_at at INSERT time to prevent
  // the 30-second push-dispatch cron from picking it up and sending a duplicate.
  let inappWritten = false;
  let notificationId: string | null = null;
  if (shouldWriteInapp) {
    // VTID-01969: denormalize recipient_vitana_id at insert time so support
    // tooling can quote @<id> without joining profiles. Cached lookup is
    // null-tolerant (Release B middleware contract).
    const { resolveVitanaId } = await import('../middleware/auth-supabase-jwt');
    const recipientVitanaId = await resolveVitanaId(userId);

    const insertData: Record<string, any> = {
      user_id: userId,
      tenant_id: tenantId,
      type,
      channel: meta.channel,
      priority: meta.priority,
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      ...(recipientVitanaId && { recipient_vitana_id: recipientVitanaId }),
    };
    if (shouldSendPush) {
      insertData.push_sent_at = new Date().toISOString();
    }
    const { data: inserted, error } = await supabase.from('user_notifications')
      .insert(insertData)
      .select('id').single();
    if (error) {
      console.error(`[Notifications] inapp write failed for ${type}:`, error.message);
    } else {
      inappWritten = true;
      notificationId = inserted?.id || null;
    }
  }

  // ── 5. Send push — FCM first, Appilix as fallback ──────
  // Dispatch policy:
  //   1. Always try FCM first via user_device_tokens (covers Android native
  //      app, iOS native app once bridge captures token, web push).
  //   2. If the notification has a deep-link URL AND we have no
  //      Appilix-wrapped (native mobile) token registered for the user,
  //      ALSO fire Appilix legacy user_identity push so the installed app
  //      receives it. Web-push FCM tokens open the browser, not the app,
  //      so without this branch users whose iOS/Android bridge hasn't
  //      captured the native token yet would silently miss chat pushes.
  //      Frontend registerAppilixDevice() tags native tokens with a
  //      "Appilix " prefix on device_label — that's our detection signal.
  //   3. If FCM delivered to zero tokens overall, also try Appilix as a
  //      last-resort fallback (original behavior).
  let pushed = 0;
  let appilixSent = false;
  if (shouldSendPush) {
    // VTID-03481: skip Appilix entirely for a user who is signed out on every
    // device we know about. Appilix targets by user_identity and retains stale
    // identity→device mappings we can't purge, so without this the account that
    // LEFT a shared phone keeps pushing to it — the second, wrong-language copy
    // of every notification.
    // VTID-03507 widens this: signed out EVERYWHERE, or still signed in
    // elsewhere but no longer the owner of the phone Appilix would reach.
    const appilixSuppressed =
      (await isSignedOutOnAllKnownDevices(userId, supabase)) ||
      (await hasLostDeviceToAnotherAccount(userId, supabase));

    if (payload.data?.url) {
      // Notifications with deep-link URLs must go through Appilix first.
      // Appilix honors open_link_url on tap; FCM-delivered notifications
      // crash the Appilix WebView ("Something went wrong") because FCM
      // doesn't pass the URL to Appilix's native tap handler.
      appilixSent = appilixSuppressed ? false : await sendAppilixPush(userId, payload);
      if (!appilixSent) {
        // Appilix reported no device for this user (e.g. its client-side
        // identity registration never took) — do NOT retry via raw FCM on
        // an Appilix-tagged token, since that's the exact delivery path
        // that crashes the WebView on tap. Only non-Appilix tokens (real
        // browser web-push) are safe to fall back to here.
        pushed = await sendPushToUser(userId, tenantId, payload, supabase, {
          excludeAppilixTagged: true,
        });
      }
    } else {
      pushed = await sendPushToUser(userId, tenantId, payload, supabase);
      if (pushed === 0 && !appilixSuppressed) {
        appilixSent = await sendAppilixPush(userId, payload);
      }
    }
  }

  console.log(
    `[Notifications] ${type} → user=${userId.slice(0, 8)}… ` +
    `inapp=${inappWritten} push=${pushed} appilix=${appilixSent} ch=${meta.channel} pri=${meta.priority}` +
    (pushBlockedByDnd ? ' (DND)' : '') +
    (meta.channel === 'silent' ? ' (silent)' : '')
  );

  return { pushed, inapp: inappWritten };
}

/**
 * Fire-and-forget wrapper — logs errors but never throws.
 * Use this from route handlers so notifications never block the response.
 */
export function notifyUserAsync(
  userId: string,
  tenantId: string,
  type: string,
  payload: NotificationPayload,
  supabase: SupabaseClient<any, any, any>
): void {
  notifyUser(userId, tenantId, type, payload, supabase).catch((err) => {
    console.error(`[Notifications] Async dispatch failed for ${type}:`, err.message || err);
  });
}

/**
 * Notify multiple users (e.g. all followers of a live room).
 * Fire-and-forget, non-blocking.
 */
export function notifyUsersAsync(
  userIds: string[],
  tenantId: string,
  type: string,
  payload: NotificationPayload,
  supabase: SupabaseClient<any, any, any>
): void {
  for (const uid of userIds) {
    notifyUserAsync(uid, tenantId, type, payload, supabase);
  }
}
