/**
 * VTID-04187 — the per-thread marker's 30-minute backstop actually expires.
 *
 * operator-execute-authz.ts keeps `threadAuthMap: Map<threadId, {auth, timer}>`
 * where `setThreadAuth()` arms `setTimeout(..., THREAD_AUTH_TTL_MS)` and the
 * timeout callback deletes the entry. That callback is the ONLY thing that
 * ever removes an entry other than a later set/clear for the same threadId —
 * the marker can never be seen to expire any other way.
 *
 * The pre-existing suite (vtid-03851-execute-task-requires-auth.test.ts) pins
 * the pure predicate and the set/clear/get semantics (including the
 * reused-threadId threat), but it never advances a clock: it only ever
 * observes a marker that was written moments earlier, so the whole
 * timed-deletion path was unpinned. A regression that dropped the timer
 * (e.g. `set` without arming it) would leave an exafy_admin marker alive
 * forever and every existing test would still pass.
 *
 * These tests therefore use jest fake timers and advance past the TTL, per
 * the module's own contract in its header comment: the TTL is a memory
 * backstop, and expiring it must not change any answer `isExecuteTaskAuthorized`
 * gives within a request (the route rewrites the marker on every request).
 */

import {
  setThreadAuth,
  clearThreadAuth,
  getThreadAuth,
  isExecuteTaskAuthorized,
} from '../src/services/operator-execute-authz';

/** Mirrors the (module-private) THREAD_AUTH_TTL_MS = 30 * 60 * 1000. */
const THREAD_AUTH_TTL_MS = 30 * 60 * 1000;
const TTL_PLUS_1_MS = THREAD_AUTH_TTL_MS + 1;
/** Deliberately just under the TTL — the marker must still be readable. */
const JUST_UNDER_TTL_MS = THREAD_AUTH_TTL_MS - 1;

describe('VTID-04187 — thread auth marker TTL expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    // The map is module-level (and shared only within this test file);
    // clear the threads this file touches so no state leaks between tests.
    clearThreadAuth('ttl-a');
    clearThreadAuth('ttl-b');
    clearThreadAuth('ttl-c');
  });

  it('AC-1: returns the marker immediately after set, and undefined once fake time passes the TTL', () => {
    setThreadAuth('ttl-a', { user_id: 'u-1', exafy_admin: true });

    // Immediately after set: readable, and authorizes.
    expect(getThreadAuth('ttl-a')).toEqual({ user_id: 'u-1', exafy_admin: true });
    expect(isExecuteTaskAuthorized(getThreadAuth('ttl-a'))).toEqual({ ok: true });

    // One millisecond before the TTL the backstop must NOT have fired.
    jest.advanceTimersByTime(JUST_UNDER_TTL_MS);
    expect(getThreadAuth('ttl-a')).toEqual({ user_id: 'u-1', exafy_admin: true });

    // Past the TTL the timer callback has deleted the entry, so an
    // unauthenticated request on the reused threadId is refused again.
    jest.advanceTimersByTime(2);
    expect(getThreadAuth('ttl-a')).toBeUndefined();
    expect(isExecuteTaskAuthorized(getThreadAuth('ttl-a'))).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
  });

  it('AC-1: a marker written after an earlier one expired is fresh, not inherited', () => {
    setThreadAuth('ttl-b', { user_id: 'u-admin', exafy_admin: true });
    jest.advanceTimersByTime(TTL_PLUS_1_MS);
    expect(getThreadAuth('ttl-b')).toBeUndefined();

    // New request, same client-supplied threadId, non-admin caller: the
    // marker is overwritten rather than resurrected from the first write.
    setThreadAuth('ttl-b', { user_id: 'u-9', exafy_admin: false });
    expect(isExecuteTaskAuthorized(getThreadAuth('ttl-b'))).toEqual({
      ok: false,
      reason: 'not_admin',
    });

    // ...and the second write gets its own full TTL window.
    jest.advanceTimersByTime(JUST_UNDER_TTL_MS);
    expect(getThreadAuth('ttl-b')).toEqual({ user_id: 'u-9', exafy_admin: false });
    jest.advanceTimersByTime(2);
    expect(getThreadAuth('ttl-b')).toBeUndefined();
  });

  it('AC-2 (distinct case): clearThreadAuth cancels the pending timer so it cannot fire later', () => {
    // Same TTL/Timer machinery as AC-1, but the assertion is about the
    // OTHER path out of the map: clearThreadAuth() calls clearTimeout() on
    // the armed timer. If that cancellation were missing, the timer armed
    // by this set would survive the clear and — because setTimeout holds
    // the threadId in its closure — fire after the TTL anyway. That would
    // be invisible on the same threadId (the entry is already gone), so the
    // regression would only be caught by re-arming after the clear and
    // watching the ORIGINAL timer delete the NEW marker. That is what this
    // test does:
    setThreadAuth('ttl-c', { user_id: 'u-1', exafy_admin: true });
    clearThreadAuth('ttl-c');
    expect(getThreadAuth('ttl-c')).toBeUndefined();

    // Fresh admin marker on the same threadId, written later.
    jest.advanceTimersByTime(JUST_UNDER_TTL_MS);
    setThreadAuth('ttl-c', { user_id: 'u-2', exafy_admin: true });
    expect(isExecuteTaskAuthorized(getThreadAuth('ttl-c'))).toEqual({ ok: true });

    // Advance past the FIRST timer's deadline. The new marker is only a
    // millisecond old at this point, so if the old timer still existed it
    // would now delete the new marker; the fresh marker's own timer is
    // still ~TTL away, so the marker must survive.
    jest.advanceTimersByTime(2);
    expect(getThreadAuth('ttl-c')).toEqual({ user_id: 'u-2', exafy_admin: true });
    expect(isExecuteTaskAuthorized(getThreadAuth('ttl-c'))).toEqual({ ok: true });

    // And the new marker still expires on its own TTL.
    jest.advanceTimersByTime(JUST_UNDER_TTL_MS);
    expect(getThreadAuth('ttl-c')).toBeUndefined();
  });

  it('AC-2 (distinct case): re-setting a threadId leaves exactly one live timer', () => {
    // setThreadAuth() clears before arming, so overwriting must not stack
    // timers. Two stacked timers would be indistinguishable by reading the
    // map (the first fire is a harmless delete), so the observable contract
    // is that the LAST write's TTL governs: the marker written at t=0 must
    // not be able to shorten the effective window of the marker written at
    // t = TTL - 1.
    setThreadAuth('ttl-a', { user_id: 'u-1', exafy_admin: true });
    jest.advanceTimersByTime(JUST_UNDER_TTL_MS);
    setThreadAuth('ttl-a', { user_id: 'u-2', exafy_admin: true });

    // Cross the first timer's deadline.
    jest.advanceTimersByTime(2);
    expect(getThreadAuth('ttl-a')).toEqual({ user_id: 'u-2', exafy_admin: true });

    jest.advanceTimersByTime(JUST_UNDER_TTL_MS);
    expect(getThreadAuth('ttl-a')).toBeUndefined();
  });
});
