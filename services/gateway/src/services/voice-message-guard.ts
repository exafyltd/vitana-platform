/**
 * VTID-01967: Voice-message rate limiter + audit hook for ORB voice tools.
 *
 * Per-session 5-send cap. In-memory Map keyed by ORB session id, sweeps
 * automatically on read. Safe in single-instance deploys (current state);
 * Release C migrates to Redis when ORB scales horizontally.
 *
 * Every send / rate-limit emits an OASIS event so support and Voice Lab
 * dashboards can audit voice-initiated outreach without DB joins.
 */

import { emitOasisEvent } from './oasis-event-service';

const SEND_CAP_PER_SESSION = 5;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min — matches typical ORB session

interface SessionCounter {
  count: number;
  expires_at: number;
}

const sendCounters = new Map<string, SessionCounter>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, counter] of sendCounters.entries()) {
    if (counter.expires_at <= now) {
      sendCounters.delete(key);
    }
  }
}

/**
 * Increment the per-session counter for a voice-initiated send. Returns
 * { allowed: true } when the cap hasn't been hit, { allowed: false, reason }
 * when it has. Emits OASIS audit events on every call.
 */
export type VoiceQuotaKeyType = 'real_session' | 'missing_session_fallback';

export async function checkVoiceSendQuota(args: {
  session_id: string;
  actor_id: string;
  vitana_id: string | null | undefined;
  recipient_user_id: string;
  recipient_vitana_id: string | null | undefined;
  kind: 'message' | 'share_link';
  body_length?: number;
  target_url?: string;
  /**
   * VTID-02963: provenance of the rate-limit key. Lets the cockpit see
   * whether voice sends are being scoped to a real Gemini Live session
   * (per-conversation isolation, the intended behavior) or to the
   * synthetic per-user fallback (degraded mode — every send across every
   * orb open shares one counter until TTL expires).
   */
  key_type?: VoiceQuotaKeyType;
}): Promise<{ allowed: boolean; reason?: string; remaining: number }> {
  sweepExpired();

  const existing = sendCounters.get(args.session_id);
  const count = existing?.count ?? 0;
  const keyType: VoiceQuotaKeyType = args.key_type ?? 'real_session';

  if (count >= SEND_CAP_PER_SESSION) {
    await emitOasisEvent({
      vtid: 'VTID-01967',
      type: 'voice.message.rate_limited',
      source: 'voice-message-guard',
      status: 'warning',
      message: `Voice send quota exceeded for session ${args.session_id} (${count}/${SEND_CAP_PER_SESSION})`,
      payload: {
        session_id: args.session_id,
        key_type: keyType,
        recipient_user_id: args.recipient_user_id,
        recipient_vitana_id: args.recipient_vitana_id,
        kind: args.kind,
        cap: SEND_CAP_PER_SESSION,
      },
      actor_id: args.actor_id,
      actor_role: 'user',
      surface: 'orb',
      vitana_id: args.vitana_id ?? undefined,
    });
    return {
      allowed: false,
      reason: 'rate_limited',
      remaining: 0,
    };
  }

  sendCounters.set(args.session_id, {
    count: count + 1,
    expires_at: Date.now() + SESSION_TTL_MS,
  });

  await emitOasisEvent({
    vtid: 'VTID-01967',
    type: args.kind === 'share_link' ? 'voice.message.share_link_sent' : 'voice.message.sent',
    source: 'voice-message-guard',
    status: 'success',
    message: `Voice ${args.kind === 'share_link' ? 'link share' : 'message'} sent to @${args.recipient_vitana_id ?? args.recipient_user_id}`,
    payload: {
      session_id: args.session_id,
      key_type: keyType,
      recipient_user_id: args.recipient_user_id,
      recipient_vitana_id: args.recipient_vitana_id,
      kind: args.kind,
      ...(args.body_length !== undefined && { body_length: args.body_length }),
      ...(args.target_url && { target_url: args.target_url }),
      send_index: count + 1,
      cap: SEND_CAP_PER_SESSION,
    },
    actor_id: args.actor_id,
    actor_role: 'user',
    surface: 'orb',
    vitana_id: args.vitana_id ?? undefined,
  });

  return {
    allowed: true,
    remaining: SEND_CAP_PER_SESSION - (count + 1),
  };
}

/**
 * VTID-02963: Test-only reset helper. Lets tests verify per-key isolation
 * without leaking counter state between cases. Not exported through any
 * index file; production callers must not use this.
 */
export function _resetSendCountersForTests(): void {
  sendCounters.clear();
}

/**
 * Emit a misroute event when the user signals "you sent it to the wrong
 * person" after a voice send. Used for ASR-confidence threshold tuning.
 */
export async function reportVoiceMisroute(args: {
  session_id: string;
  actor_id: string;
  vitana_id: string | null | undefined;
  intended_token: string;
  resolved_user_id: string;
  resolved_vitana_id: string | null | undefined;
}): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01967',
    type: 'voice.message.misroute',
    source: 'voice-message-guard',
    status: 'warning',
    message: `Voice misroute reported by @${args.vitana_id ?? args.actor_id}: said "${args.intended_token}", resolved to @${args.resolved_vitana_id ?? args.resolved_user_id}`,
    payload: {
      session_id: args.session_id,
      intended_token: args.intended_token,
      resolved_user_id: args.resolved_user_id,
      resolved_vitana_id: args.resolved_vitana_id,
    },
    actor_id: args.actor_id,
    actor_role: 'user',
    surface: 'orb',
    vitana_id: args.vitana_id ?? undefined,
  });
}

/**
 * Reset the counter for a session — useful when an ORB session ends so
 * the next session for the same user starts fresh. Otherwise sweeps occur
 * on every check via TTL.
 */
export function resetSessionQuota(sessionId: string): void {
  sendCounters.delete(sessionId);
}
