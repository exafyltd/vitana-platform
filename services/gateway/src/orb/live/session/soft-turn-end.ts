/**
 * VTID-04747: end Vitana's turn when her audio has stopped and Nova's
 * END_TURN never came.
 *
 * Nova's END_TURN for a reply can be swallowed by the turn latch
 * (nova-sonic-protocol.ts, VTID-03592) — after a filler line spoken around an
 * instant tool result, for example. Without it `isModelSpeaking` stays true:
 * the widget keeps showing "Vitana spricht" while she is silent, and 20 s
 * later the audio-stall watchdog kills and reconnects the session.
 * Production live-11ec418b (2026-09-29, 13:55:43 and 13:57:43) hit both.
 *
 * Nova streams a reply's audio faster than it plays, so a gap of seconds
 * between output chunks means the reply is over. This arms a short timer on
 * every output chunk; when it fires with the model still "speaking", the
 * session completes the turn itself. A real END_TURN arriving afterwards with
 * no audio in between is then ignored, so a turn never completes twice.
 * Nova sessions only.
 */

const DEFAULT_SOFT_TURN_END_MS = 2500;

export function softTurnEndMs(): number {
  const raw = Number(process.env.ORB_SOFT_TURN_END_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_SOFT_TURN_END_MS;
}

type SoftTurnSession = {
  active?: boolean;
  isModelSpeaking?: boolean;
  audioOutChunks?: number;
  _softTurnEndTimer?: ReturnType<typeof setTimeout>;
  _softTurnEndedAtChunk?: number;
};

export function clearSoftTurnEnd(session: SoftTurnSession): void {
  if (session._softTurnEndTimer) clearTimeout(session._softTurnEndTimer);
  session._softTurnEndTimer = undefined;
}

/** Re-arm on each output chunk; `complete` runs the normal turn_complete path. */
export function armSoftTurnEnd(session: SoftTurnSession, complete: () => void, ms = softTurnEndMs()): void {
  clearSoftTurnEnd(session);
  if (ms <= 0) return;
  const timer = setTimeout(() => {
    session._softTurnEndTimer = undefined;
    if (!session.active || !session.isModelSpeaking) return;
    session._softTurnEndedAtChunk = session.audioOutChunks ?? 0;
    complete();
  }, ms);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  session._softTurnEndTimer = timer;
}

/**
 * True for a real END_TURN that belongs to a turn the soft end already
 * completed (no model audio since). Consumes the marker either way.
 */
export function isEchoOfSoftTurnEnd(session: SoftTurnSession): boolean {
  const at = session._softTurnEndedAtChunk;
  if (at === undefined) return false;
  session._softTurnEndedAtChunk = undefined;
  return (session.audioOutChunks ?? 0) === at;
}
