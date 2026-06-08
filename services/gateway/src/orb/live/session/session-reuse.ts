/**
 * BOOTSTRAP-ORB-SESSION-CHURN: pure reuse-decision logic for `/live/session/start`
 * idempotency, factored out of the controller so it is unit-testable without the
 * live-session registry or the (heavy) orb-live module graph.
 *
 * Why this exists: telemetry showed ~32% of session starts superseded a still-live
 * session for the same user, 89.5% of them with ZERO turns — the greeting torn
 * down before it spoke. The fix reuses the in-flight zero-turn session. The
 * decision below is STATE-driven (active + no turns), not clock-driven; the age
 * bound is only a backstop against a wedged session.
 */

/** Minimal shape the reuse decision needs from a live session. */
export interface ReusableSessionLike {
  sessionId: string;
  active: boolean;
  turn_count: number;
  createdAt: Date;
  identity?: { user_id: string } | null;
  /** Set only once the session has produced its first start response. */
  startResponseBody?: unknown;
}

/**
 * A session is reusable for a fresh start by the same user when it is active,
 * owned by that user, has taken NO turns (so it is in the identical greeting
 * state a fresh session would be), is already past first-response (so we never
 * hand back a half-built session), and has not exceeded the age backstop.
 *
 * State is the primary gate; `maxAgeMs` only fences off a wedged session.
 */
export function isReusableSession(
  session: ReusableSessionLike,
  userId: string,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (!session.active) return false;
  if (!session.identity || session.identity.user_id !== userId) return false;
  if (session.turn_count !== 0) return false;
  if (!session.startResponseBody) return false;
  const age = nowMs - session.createdAt.getTime();
  return age >= 0 && age <= maxAgeMs;
}

/**
 * Pick the most-recently-created reusable session for the user, or null when
 * none qualifies (the normal new-conversation path).
 */
export function pickReusableSession<T extends ReusableSessionLike>(
  sessions: Iterable<T>,
  userId: string,
  nowMs: number,
  maxAgeMs: number,
): T | null {
  let best: T | null = null;
  let bestAge = Infinity;
  for (const s of sessions) {
    if (!isReusableSession(s, userId, nowMs, maxAgeMs)) continue;
    const age = nowMs - s.createdAt.getTime();
    if (age < bestAge) {
      bestAge = age;
      best = s;
    }
  }
  return best;
}
