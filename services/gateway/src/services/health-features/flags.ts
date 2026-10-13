/**
 * VTID-05162 (Health Hub Phase 1 / B2) — the two dual-write flags (Change 7).
 *
 * Device and self-logged writers start separately:
 *   - HEALTH_STORE_DUAL_WRITE_DEVICE       webhook daily metrics / workouts and
 *                                          the wearable_log_workout action
 *                                          (activation date D0);
 *   - HEALTH_STORE_DUAL_WRITE_SELF_LOGGED  diary, voice, ORB health tools and the
 *                                          manual-log route — activated only once
 *                                          C1's `self_logged_health` consent key
 *                                          is live in production (S7; date D0s).
 *
 * Each must be exactly 'true' AND the process must not be staging (staging
 * shares the production database — the D6a flag pattern,
 * wearable-features-bridge.ts). No task definition sets either flag in this
 * package; each activation is its own Gate 2 (plan Rollout 4).
 */

import type { HealthWriterClass } from './feature-spec';

export function isHealthStoreDualWriteDeviceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEALTH_STORE_DUAL_WRITE_DEVICE === 'true' && env.VITANA_ENV !== 'staging';
}

export function isHealthStoreDualWriteSelfLoggedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEALTH_STORE_DUAL_WRITE_SELF_LOGGED === 'true' && env.VITANA_ENV !== 'staging';
}

export function isDualWriteEnabledFor(flag: HealthWriterClass, env: NodeJS.ProcessEnv = process.env): boolean {
  return flag === 'device' ? isHealthStoreDualWriteDeviceEnabled(env) : isHealthStoreDualWriteSelfLoggedEnabled(env);
}

/** The nightly derivation and catch-up run when either dual-write is on (never on staging). */
export function isFeatureDerivationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isHealthStoreDualWriteDeviceEnabled(env) || isHealthStoreDualWriteSelfLoggedEnabled(env);
}
