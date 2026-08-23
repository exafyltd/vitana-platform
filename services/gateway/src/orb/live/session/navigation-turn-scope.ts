/**
 * VTID-03583 — per-TURN navigation marker.
 *
 * WHY THIS EXISTS
 * ---------------
 * VTID-03446 needed to stop a model (observed on Nova Sonic, which can chain a
 * second tool call before ever emitting END_TURN) from calling
 * navigate/navigate_to_screen twice inside one turn and stacking a second,
 * deeper disambiguation question on top of the first.
 *
 * It implemented that by reading `session.navigationDispatched`. That flag is a
 * SESSION-LIFETIME latch with a different contract — "a navigation is queued,
 * the ORB overlay is closing, shut the session down". It is assigned `true` in
 * nine places and set back to `false` in none, because for its original purpose
 * a one-way latch is correct: a closing session never un-closes.
 *
 * Reusing it as a per-turn guard therefore refused EVERY navigation after the
 * first successful one for the remainder of the session, and handed the model a
 * literal instruction to stop calling the tool and just talk. The user-visible
 * result: the assistant offers a screen, is told "yes", and offers it again —
 * indefinitely.
 *
 * THE FIX
 * -------
 * Scope the marker to the turn. `session.turn_count` increments at
 * turn_complete (see upstream-message-handler.ts), so a marker holding the
 * dispatching turn's count STOPS MATCHING BY ITSELF on the next turn. The reset
 * is structural rather than an explicit clear-call, which matters: an explicit
 * clear is exactly what the original latch never got, and what an error path or
 * an early return can silently skip.
 *
 * Do NOT change `navigationDispatched` to use this. Its audio/transcript gating
 * uses (`orb-live.ts` mic-in gate, upstream-message-handler.ts audio-out and
 * transcript drops) genuinely want the one-way latch — turn-scoping those would
 * let the model talk over its own goodbye while the widget tears down.
 */

/** Minimal structural type so both the route file and the handler can pass their own session shapes. */
export interface NavigationTurnScopedSession {
  navigationDispatchedTurn?: number;
  turn_count?: number;
}

/** True when a navigation was already dispatched during the CURRENT turn. */
export function navigationDispatchedThisTurn(
  session: NavigationTurnScopedSession,
): boolean {
  return (
    typeof session.navigationDispatchedTurn === 'number' &&
    session.navigationDispatchedTurn === (session.turn_count ?? 0)
  );
}

/** Record that a navigation was dispatched during the current turn. */
export function markNavigationDispatchedThisTurn(
  session: NavigationTurnScopedSession,
): void {
  session.navigationDispatchedTurn = session.turn_count ?? 0;
}
