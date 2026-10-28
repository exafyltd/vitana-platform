/**
 * VTID-04542 — persona hand-off timing (Vitana ↔ Devon), measurement only.
 *
 * A hand-off has three legs the member hears as one silence:
 *   request  — the tool queued the swap (`pendingPersonaSwap` set)
 *   drain    — the current turn finished and the swap was applied
 *              (upstream closed for a reconnect, or the cascade swapped in
 *              process)
 *   connect  — the transparent reconnect opened the new upstream
 *              (reconnect mode only)
 *   first audio — the new persona's first audio chunk
 *
 * One `voice.latency.handoff` OASIS event per completed hand-off:
 *   { session_id, from_persona, to_persona, provider, mode,
 *     swap_to_first_audio_ms, drain_ms, connect_ms, reconnect_to_first_audio_ms }
 *
 * The state lives on the session (`_personaSwapLatency`). Every function is
 * fire-and-forget and swallows its own errors — nothing here is awaited on
 * the voice path or changes what the model receives.
 */

import { emitOasisEvent } from '../../services/oasis-event-service';

export interface PersonaSwapLatencyState {
  from_persona: string;
  to_persona: string;
  requested_at_ms: number;
  mode?: 'reconnect' | 'in_process';
  drained_at_ms?: number;
  connect_started_at_ms?: number;
  connected_at_ms?: number;
}

type SwapSession = {
  sessionId: string;
  activePersona?: string;
  identity?: { user_id?: string } | null;
  _personaSwapLatency?: PersonaSwapLatencyState | null;
};

function asSwap(session: unknown): SwapSession {
  return session as SwapSession;
}

/** The swap tool queued a persona change. Overwrites any unfinished record. */
export function notePersonaSwapRequested(session: unknown, toPersona: string, now: number = Date.now()): void {
  try {
    const s = asSwap(session);
    s._personaSwapLatency = {
      from_persona: s.activePersona || 'vitana',
      to_persona: toPersona,
      requested_at_ms: now,
    };
  } catch {
    /* telemetry only */
  }
}

/** The current turn drained and the swap was applied. */
export function notePersonaSwapDrained(
  session: unknown,
  mode: 'reconnect' | 'in_process',
  now: number = Date.now(),
): void {
  try {
    const st = asSwap(session)._personaSwapLatency;
    if (!st || st.drained_at_ms !== undefined) return;
    st.drained_at_ms = now;
    st.mode = mode;
  } catch {
    /* telemetry only */
  }
}

/** The transparent reconnect for a persona swap is about to connect. */
export function notePersonaSwapConnectStarted(session: unknown, now: number = Date.now()): void {
  try {
    const st = asSwap(session)._personaSwapLatency;
    if (!st || st.drained_at_ms === undefined) return;
    st.connect_started_at_ms = now;
  } catch {
    /* telemetry only */
  }
}

/** The transparent reconnect for a persona swap opened the new upstream. */
export function notePersonaSwapConnected(session: unknown, now: number = Date.now()): void {
  try {
    const st = asSwap(session)._personaSwapLatency;
    if (!st || st.drained_at_ms === undefined) return;
    st.connected_at_ms = now;
  } catch {
    /* telemetry only */
  }
}

/** Build the event payload for a completed hand-off (pure; exported for tests). */
export function buildHandoffLatencyPayload(
  sessionId: string,
  st: PersonaSwapLatencyState,
  provider: string,
  firstAudioAtMs: number,
): Record<string, unknown> {
  const drainedAt = st.drained_at_ms ?? null;
  const connectStart = st.connect_started_at_ms ?? drainedAt;
  return {
    session_id: sessionId,
    from_persona: st.from_persona,
    to_persona: st.to_persona,
    provider,
    mode: st.mode ?? null,
    swap_requested_at: new Date(st.requested_at_ms).toISOString(),
    swap_to_first_audio_ms: Math.max(0, firstAudioAtMs - st.requested_at_ms),
    drain_ms: drainedAt !== null ? Math.max(0, drainedAt - st.requested_at_ms) : null,
    connect_ms:
      st.mode === 'reconnect' && st.connected_at_ms !== undefined && connectStart !== null
        ? Math.max(0, st.connected_at_ms - connectStart)
        : null,
    reconnect_to_first_audio_ms:
      st.connected_at_ms !== undefined ? Math.max(0, firstAudioAtMs - st.connected_at_ms) : null,
  };
}

/**
 * The model started speaking. When a hand-off has drained (so this audio is
 * the NEW persona's — the old persona's bridge sentence plays before the
 * drain), emit `voice.latency.handoff` and clear the record.
 * Fire-and-forget; never throws.
 */
export function notePersonaSwapFirstAudio(
  session: unknown,
  provider: string,
  now: number = Date.now(),
): void {
  try {
    const s = asSwap(session);
    const st = s._personaSwapLatency;
    if (!st || st.drained_at_ms === undefined) return;
    // A reconnect-mode hand-off only counts once the new upstream is open.
    if (st.mode === 'reconnect' && st.connected_at_ms === undefined) return;
    s._personaSwapLatency = null;
    const payload = buildHandoffLatencyPayload(s.sessionId, st, provider, now);
    void emitOasisEvent({
      vtid: 'VTID-04542',
      type: 'voice.latency.handoff',
      source: 'gateway/persona-swap-latency',
      status: 'info',
      message: `handoff ${st.from_persona}→${st.to_persona} ${String(payload.swap_to_first_audio_ms)}ms`,
      actor_id: s.identity?.user_id,
      payload,
    }).catch(() => { /* telemetry only */ });
  } catch {
    /* telemetry only */
  }
}
