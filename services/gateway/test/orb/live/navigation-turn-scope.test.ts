/**
 * VTID-03583 — regression tests for the per-turn navigation marker.
 *
 * The bug these lock down: VTID-03446 used `session.navigationDispatched`
 * (a session-lifetime latch that is never reset) as a "already navigated this
 * turn" guard, so every navigation after the first one in a session was
 * refused. The user-visible symptom was an assistant that offers to open a
 * screen, is told yes, and offers it again indefinitely.
 *
 * The first test below is the one that matters: it fails against the old
 * latch-based implementation and passes against the turn-scoped one.
 */

import {
  navigationDispatchedThisTurn,
  markNavigationDispatchedThisTurn,
  type NavigationTurnScopedSession,
} from '../../../src/orb/live/session/navigation-turn-scope';

/** Mirrors what upstream-message-handler.ts does at turn_complete. */
function completeTurn(session: NavigationTurnScopedSession): void {
  session.turn_count = (session.turn_count ?? 0) + 1;
}

describe('VTID-03583 navigation turn scope', () => {
  it('allows a SECOND navigation in a later turn (the actual regression)', () => {
    const session: NavigationTurnScopedSession = { turn_count: 0 };

    // Turn 0: the user asks for a screen, we navigate.
    expect(navigationDispatchedThisTurn(session)).toBe(false);
    markNavigationDispatchedThisTurn(session);
    expect(navigationDispatchedThisTurn(session)).toBe(true);

    completeTurn(session);

    // Turn 1: the user asks for another screen. Under the old latch this
    // returned true forever and the navigation was refused.
    expect(navigationDispatchedThisTurn(session)).toBe(false);
  });

  it('still blocks a second navigation WITHIN the same turn (what VTID-03446 fixed)', () => {
    const session: NavigationTurnScopedSession = { turn_count: 3 };

    markNavigationDispatchedThisTurn(session);

    // Nova Sonic can chain a second tool call before emitting END_TURN — that
    // is the case the guard exists for and it must still be caught.
    expect(navigationDispatchedThisTurn(session)).toBe(true);
  });

  it('stays clear across many turns, so navigation never degrades over a long session', () => {
    const session: NavigationTurnScopedSession = { turn_count: 0 };

    for (let i = 0; i < 25; i++) {
      expect(navigationDispatchedThisTurn(session)).toBe(false);
      markNavigationDispatchedThisTurn(session);
      expect(navigationDispatchedThisTurn(session)).toBe(true);
      completeTurn(session);
    }
  });

  it('reads as "not dispatched" on a fresh session with no marker', () => {
    expect(navigationDispatchedThisTurn({})).toBe(false);
    expect(navigationDispatchedThisTurn({ turn_count: 7 })).toBe(false);
  });

  it('treats a missing turn_count as turn 0 rather than matching everything', () => {
    const session: NavigationTurnScopedSession = {};
    markNavigationDispatchedThisTurn(session);
    expect(session.navigationDispatchedTurn).toBe(0);
    expect(navigationDispatchedThisTurn(session)).toBe(true);

    // A session that later reports a real turn must not still match turn 0.
    session.turn_count = 1;
    expect(navigationDispatchedThisTurn(session)).toBe(false);
  });

  it('does not treat turn 0 as "unset" (guards against a falsy-check regression)', () => {
    // A `if (session.navigationDispatchedTurn)` style check would read 0 as
    // falsy and let a same-turn double navigation through on the very first
    // turn — which is exactly when the greeting-adjacent navigation happens.
    const session: NavigationTurnScopedSession = { turn_count: 0 };
    markNavigationDispatchedThisTurn(session);
    expect(navigationDispatchedThisTurn(session)).toBe(true);
  });
});
