/**
 * VTID-05177 — the two native-push env switches, dependency-free so the token
 * route can read them without loading the FCM sender. Both default OFF; only
 * the exact string 'true' turns one on (a typo is off).
 *
 *   NATIVE_PUSH_DIRECT_ENABLED        native tokens get a direct FCM pass
 *                                     (services/push-routing.ts).
 *   NATIVE_PUSH_APPILIX_GUARD_ENABLED same-phone duplicate guard; effective
 *                                     only when the first is also on.
 */

export function isNativePushDirectEnabled(): boolean {
  return (process.env.NATIVE_PUSH_DIRECT_ENABLED ?? '') === 'true';
}

export function isNativePushAppilixGuardEnabled(): boolean {
  return (process.env.NATIVE_PUSH_APPILIX_GUARD_ENABLED ?? '') === 'true';
}
