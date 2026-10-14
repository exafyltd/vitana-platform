/**
 * Native push routing — VTID-05177 (native app Wave 1, N4-GW).
 *
 * dispatchPush() is the one push routing helper the three dispatch sites call:
 *   (a) notifyUser                 — services/notification-service.ts
 *   (b) POST /push-dispatch        — routes/scheduled-notifications.ts
 *   (c) scheduleReminderFcmPush    — services/reminders-dispatch.ts
 *
 * The store app that replaces the Appilix shell registers its FCM token with
 * device_type ios_native / android_native (POST /notifications/token). Two env
 * switches decide what that changes, both default OFF:
 *
 *   NATIVE_PUSH_DIRECT_ENABLED=true        native tokens get a direct FCM pass
 *                                          first; each site's existing
 *                                          Appilix/web logic then runs over
 *                                          legacy tokens only.
 *   NATIVE_PUSH_APPILIX_GUARD_ENABLED=true the same-phone duplicate guard;
 *                                          effective only with the first.
 *
 * With both unset every site makes exactly the calls it made before this VTID
 * — pinned by test/services/native-push-golden.vtid-05177.test.ts (recorded
 * from the unmodified code) and by the sites' existing suites, which mock
 * notification-service and still see the same sendPushToUser / sendAppilixPush
 * calls through this module.
 *
 * Why a separate module rather than inside notification-service.ts: those
 * existing suites mock notification-service wholesale; keeping the router
 * outside it lets them exercise the real routing unchanged.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  sendPushToUser,
  sendAppilixPush,
  isSignedOutOnAllKnownDevices,
  hasLostDeviceToAnotherAccount,
  isNativeDeviceType,
  type NotificationPayload,
  type PushFanoutOutcome,
  type PushTokenClass,
} from './notification-service';
import { fetchLiveDeviceTypesForUser } from './notification-service-repository';
import { countUnreadNotifications } from '../routes/notifications-repository';
import { isNativePushDirectEnabled, isNativePushAppilixGuardEnabled } from './native-push-flags';

type Sb = SupabaseClient<any, any, any>;

export { isNativePushDirectEnabled, isNativePushAppilixGuardEnabled };

/**
 * Same-phone duplicate guard (plan Change 6). True when the user has at least
 * one live native-app token and NO live "Appilix %" token: Appilix's stale
 * user_identity mapping could otherwise still reach a phone that moved from
 * the Appilix shell to the native app and show every push twice.
 *
 * Short-circuits to false unless NATIVE_PUSH_DIRECT_ENABLED is on (sparring
 * R2-F9): with routing off, native tokens get no direct pass, so suppressing
 * Appilix could lose a push. "No Appilix % row" is not "no Appilix device"
 * (the WebView bridge often stores no row at all), which is why the guard
 * ships off behind its own switch. Fails OPEN on a query error.
 */
export async function hasOnlyNativeAppDevices(userId: string, supabase: Sb): Promise<boolean> {
  if (!isNativePushDirectEnabled()) return false;
  const { data, error } = await fetchLiveDeviceTypesForUser(supabase, userId);
  if (error || !data?.length) return false;
  const rows = data as Array<{ device_type: string | null; device_label: string | null }>;
  const hasNative = rows.some((r) => isNativeDeviceType(r.device_type));
  const hasAppilixRow = rows.some((r) => (r.device_label || '').startsWith('Appilix '));
  return hasNative && !hasAppilixRow;
}

/** Which of today's Appilix suppressions a dispatch site applies (plan F4). */
export type AppilixSuppressionRule = 'signed_out_or_lost_device' | 'signed_out_only';

/**
 * Each site's own, pre-existing legacy dispatch behaviour. dispatchPush()
 * reproduces it call for call; the differences between the sites (plan F4b)
 * are kept on purpose, not "fixed".
 */
export type LegacyPushPolicy =
  | {
      /** notifyUser and POST /push-dispatch: Appilix-first for deep links, FCM-first otherwise. */
      kind: 'deep_link_split';
      hasDeepLink: boolean;
      suppression: AppilixSuppressionRule;
      /** notifyUser true; push-dispatch false (the F4b asymmetry). */
      excludeAppilixTaggedOnFallback: boolean;
    }
  | {
      /** scheduleReminderFcmPush: FCM first, then Appilix unless an "Appilix %" token exists. */
      kind: 'fcm_then_appilix_unless_tagged';
      countAppilixTaggedTokens: () => Promise<number | null | undefined>;
    };

export interface DispatchPushArgs {
  userId: string;
  tenantId: string;
  payload: NotificationPayload;
  supabase: Sb;
  policy: LegacyPushPolicy;
  /** FCM tally shared by both passes (classifyPushOutcome input). */
  outcome?: PushFanoutOutcome;
  /** notifyUser only: set an APNs badge on ios_native sends (plan Change 7). */
  iosBadge?: boolean;
}

export interface DispatchPushResult {
  /** All accepted FCM sends (native + legacy). */
  sent: number;
  nativeSent: number;
  legacySent: number;
  appilixSent: boolean;
  /** fcm_then_appilix_unless_tagged only: the "Appilix %" token count read. */
  appilixTaggedCount?: number;
}

async function isAppilixSuppressed(rule: AppilixSuppressionRule, userId: string, supabase: Sb): Promise<boolean> {
  const existing =
    rule === 'signed_out_only'
      ? await isSignedOutOnAllKnownDevices(userId, supabase)
      : (await isSignedOutOnAllKnownDevices(userId, supabase)) ||
        (await hasLostDeviceToAnotherAccount(userId, supabase));
  if (existing) return true;
  return isNativePushAppilixGuardEnabled() && (await hasOnlyNativeAppDevices(userId, supabase));
}

async function readUnreadBadge(supabase: Sb, userId: string, tenantId: string): Promise<number | null> {
  try {
    const { count, error } = await countUnreadNotifications(supabase, userId, tenantId);
    if (error || typeof count !== 'number') return null;
    return count;
  } catch {
    return null;
  }
}

/**
 * Legacy-pass fan-out. With routing off and no option set it calls
 * sendPushToUser with exactly the arguments the site used before.
 */
function sendLegacy(
  args: DispatchPushArgs,
  tokenClass: PushTokenClass | undefined,
  excludeAppilixTagged: boolean,
): Promise<number> {
  const opts = {
    ...(tokenClass ? { tokenClass } : {}),
    ...(excludeAppilixTagged ? { excludeAppilixTagged: true } : {}),
    ...(args.outcome ? { outcome: args.outcome } : {}),
  };
  return Object.keys(opts).length
    ? sendPushToUser(args.userId, args.tenantId, args.payload, args.supabase, opts)
    : sendPushToUser(args.userId, args.tenantId, args.payload, args.supabase);
}

/**
 * Switch off: exactly the site's legacy behaviour.
 * Switch on: a native pass first (native tokens, straight to FCM, URL or not),
 * then the legacy behaviour over legacy tokens only. Every "FCM delivered
 * zero" fallback counts legacy sends only, so a native send never hides a
 * missing Appilix delivery to another device during the transition.
 */
export async function dispatchPush(args: DispatchPushArgs): Promise<DispatchPushResult> {
  const { userId, tenantId, payload, supabase, policy } = args;
  const direct = isNativePushDirectEnabled();

  // deep_link_split decides Appilix suppression before any FCM send, as the
  // two sites always did — so a stale native token revoked by the native pass
  // below cannot flip the legacy decision for this push.
  const deepLinkSuppressed =
    policy.kind === 'deep_link_split'
      ? await isAppilixSuppressed(policy.suppression, userId, supabase)
      : false;

  let nativeSent = 0;
  if (direct) {
    nativeSent = await sendPushToUser(userId, tenantId, payload, supabase, {
      tokenClass: 'native',
      ...(args.outcome ? { outcome: args.outcome } : {}),
      ...(args.iosBadge ? { iosBadge: () => readUnreadBadge(supabase, userId, tenantId) } : {}),
    });
  }
  const legacyClass: PushTokenClass | undefined = direct ? 'legacy' : undefined;

  let legacySent = 0;
  let appilixSent = false;

  if (policy.kind === 'deep_link_split') {
    const appilixSuppressed = deepLinkSuppressed;
    if (policy.hasDeepLink) {
      // Deep-link pushes go Appilix-first: an FCM push tapped inside the
      // Appilix WebView crashes it (see notifyUser).
      appilixSent = appilixSuppressed ? false : await sendAppilixPush(userId, payload);
      if (!appilixSent) {
        legacySent = await sendLegacy(args, legacyClass, policy.excludeAppilixTaggedOnFallback);
      }
    } else {
      legacySent = await sendLegacy(args, legacyClass, false);
      if (legacySent === 0 && !appilixSuppressed) {
        appilixSent = await sendAppilixPush(userId, payload);
      }
    }
    return { sent: nativeSent + legacySent, nativeSent, legacySent, appilixSent };
  }

  // fcm_then_appilix_unless_tagged (reminders): suppression is read after the
  // FCM sends, as this site always did. Each site keeps its read point
  // relative to the FCM sends; here the native pass counts as an FCM send, so
  // a stale native token it revoked is visible to the check.
  legacySent = await sendLegacy(args, legacyClass, false);
  const appilixSuppressed = await isAppilixSuppressed('signed_out_only', userId, supabase);
  const taggedCount = await policy.countAppilixTaggedTokens();
  if (!taggedCount && !appilixSuppressed) {
    appilixSent = await sendAppilixPush(userId, payload);
  }
  if (legacySent === 0 && !appilixSent && !appilixSuppressed) {
    appilixSent = await sendAppilixPush(userId, payload);
  }
  return {
    sent: nativeSent + legacySent,
    nativeSent,
    legacySent,
    appilixSent,
    appilixTaggedCount: taggedCount || 0,
  };
}
