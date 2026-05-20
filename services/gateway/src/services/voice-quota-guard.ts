/**
 * VTID-03107 · Voice quota guard service.
 *
 * Helper that orb-live.ts will call (in a follow-up surgical PR) to enforce
 * the Live AI voice (`voice_live_minutes`) quota during a session.
 *
 * Shipped in this PR as a typed, side-effect-free helper. Integration into
 * the orb-live.ts hot path (the WebSocket session handler that runs Gemini
 * Live, per A8.3a.2 upstream-message-handler) is intentionally deferred — the
 * memory rules around orb-live.ts call out the renderApp / voice teardown
 * order / "no degraded flag in voice tool responses" patterns, and any
 * touch there needs explicit review.
 *
 * Three operations the eventual integration will use:
 *
 *   reserveVoiceQuotaAtSessionStart(userId, tenantId, authToken?)
 *     Called from /orb/live/session/start route. Returns the entitlement
 *     snapshot so the session state can stash quota + decide whether to
 *     start on the Live tier vs. immediately route to Standard.
 *
 *   recordVoiceMinute(userId, tenantId)
 *     Called once per minute of Live audio from the per-turn handler.
 *     Atomically increments feature_usage; returns the new `used` value so
 *     the caller can compare against the entitlement's `quota`.
 *
 *   triggerDowngrade(userId, tenantId, sseWriter, reason)
 *     Called when remaining hits 0. Writes a paywall_events row and emits
 *     the dedicated `orb.tier.downgraded` SSE event over the existing
 *     client stream (NOT inside any tool-response payload — Gemini reads
 *     `degraded:true` as failure; see memory rule from 2026-05-04).
 *
 * D36 deferral
 *   reserveVoiceQuotaAtSessionStart goes through checkEntitlement, which
 *   already calls D36 before any 'paywall' / 'hard_block' outcome. If the
 *   user is vulnerable, the outcome is 'deferred' and the caller treats
 *   that as "allow normally, do not increment usage."
 */

import {
  checkEntitlement,
  recordUsage,
  recordPaywallEvent,
  type CheckResult,
} from './entitlement-service';

const VTID = 'VTID-03107';
const LOG_PREFIX = '[voice-quota-guard]';

const FEATURE_VOICE_LIVE_MINUTES = 'voice_live_minutes';

export interface VoiceQuotaReservation {
  feature: typeof FEATURE_VOICE_LIVE_MINUTES;
  paywall_action: CheckResult['paywall_action'];
  quota: number;
  used: number;
  remaining: number;
  reset_at: string | null;
  start_on_standard_tier: boolean;
  deferred_for_vulnerability: boolean;
}

/**
 * Called at the start of a Live voice session. Returns whether the user has
 * any Live minutes left, and what tier the session should START on.
 *
 *   - allow: start on Live (the usual path)
 *   - degrade: start on Standard (Cartesia + Flash); quota already exhausted
 *   - deferred (D36): start on Live but don't burn the meter — user is
 *                     in a vulnerable state and we extend silently
 *   - paywall / hard_block: caller should 402 the session-start request
 */
export async function reserveVoiceQuotaAtSessionStart(
  userId: string,
  tenantId: string,
  opts: { sessionId?: string; authToken?: string } = {}
): Promise<VoiceQuotaReservation> {
  const result = await checkEntitlement(userId, tenantId, FEATURE_VOICE_LIVE_MINUTES, {
    amount: 1,
    sessionId: opts.sessionId,
    authToken: opts.authToken,
  });

  return {
    feature: FEATURE_VOICE_LIVE_MINUTES,
    paywall_action: result.paywall_action,
    quota: result.quota,
    used: result.used,
    remaining: result.remaining,
    reset_at: result.reset_at,
    start_on_standard_tier:
      result.paywall_action === 'degrade' ||
      result.paywall_action === 'paywall' ||
      result.paywall_action === 'hard_block',
    deferred_for_vulnerability: result.deferred_for_vulnerability,
  };
}

/**
 * Atomic per-minute meter increment. Call once per minute of Live audio.
 * Returns the new `used` value so caller can decide whether to flip the
 * session to Standard mode mid-call.
 *
 * No-op (returns null) for sessions in deferred mode — D36 protection means
 * we never advance the meter for a vulnerable user.
 */
export async function recordVoiceMinute(
  userId: string,
  tenantId: string,
  isDeferred: boolean = false
): Promise<number | null> {
  if (isDeferred) return null;
  return recordUsage(userId, tenantId, FEATURE_VOICE_LIVE_MINUTES, 1, 2592000);
}

/**
 * Wire-format for the dedicated SSE event the frontend listens for.
 * This is a DEDICATED event channel — never inside a tool-response payload.
 * See memory rule (2026-05-04 / "No degraded/partial flags in voice-tool
 * responses"): Gemini Live reads `degraded:true` inside its tool envelope
 * as a tool-call failure and apologizes to the user even when ok:true.
 */
export interface OrbTierDowngradedEvent {
  type: 'orb.tier.downgraded';
  new_tier: 'standard';
  reason: 'daily_quota' | 'session_quota' | 'plan_exhausted';
  feature: typeof FEATURE_VOICE_LIVE_MINUTES;
}

/**
 * SSE writer signature this guard accepts. The caller (orb-live.ts) passes a
 * thin wrapper around its existing `writeSseEvent` (A9.2 SSE transport
 * boundary). We don't import that directly to avoid an import cycle.
 */
export type SseWriter = (eventName: string, dataJson: string) => void;

/**
 * Mark a session as degraded. Writes the audit row (paywall_events.action=
 * 'degraded') and emits the SSE event the frontend's OrbVoiceClient listens
 * for (`vitana:orb-tier-downgraded` window event).
 */
export async function triggerDowngrade(
  userId: string,
  tenantId: string,
  writeSse: SseWriter,
  reason: OrbTierDowngradedEvent['reason'] = 'daily_quota'
): Promise<void> {
  const event: OrbTierDowngradedEvent = {
    type: 'orb.tier.downgraded',
    new_tier: 'standard',
    reason,
    feature: FEATURE_VOICE_LIVE_MINUTES,
  };
  try {
    writeSse('message', JSON.stringify(event));
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to write SSE downgrade event: ${err instanceof Error ? err.message : String(err)}`);
  }
  await recordPaywallEvent(userId, tenantId, FEATURE_VOICE_LIVE_MINUTES, 'degraded', {
    reason,
    vtid: VTID,
  });
}

export const _VTID = VTID;
