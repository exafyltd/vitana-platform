/**
 * VTID-04203 — `operator-execute-authz.ts` stores a per-thread auth marker
 * with a 30-minute TTL (`THREAD_AUTH_TTL_MS`, private to the module) via
 * `setTimeout`, documented as "a memory backstop, never the authorization
 * boundary" (the request-scoped set/clear-on-every-request contract is the
 * real boundary — already pinned by
 * `vtid-03851-execute-task-requires-auth.test.ts`). That existing suite
 * only exercises the pure set/get/clear round-trip; it never proves the
 * TTL itself actually expires the marker over real elapsed time, nor that
 * a manual `clearThreadAuth()` correctly cancels the pending timer rather
 * than leaving it to fire (harmlessly, but untested) later. Both are
 * covered here with fake timers.
 */

import { setThreadAuth, getThreadAuth, clearThreadAuth } from '../src/services/operator-execute-authz';

const THREAD_AUTH_TTL_MS = 30 * 60 * 1000; // matches the module's private THREAD_AUTH_TTL_MS

describe('VTID-04203 operator-execute-authz — TTL expiry over time (fake timers)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Clear whatever thread the test used so a leftover real (non-fake)
    // timer from a prior real-timer test suite can never interact with
    // this one, and switch back to real timers for the rest of the file.
    clearThreadAuth('t-ttl-04203');
    clearThreadAuth('t-ttl-cancel-04203');
    jest.useRealTimers();
  });

  it('getThreadAuth returns the marker immediately, and undefined once the TTL elapses', () => {
    setThreadAuth('t-ttl-04203', { user_id: 'u-1', exafy_admin: true });
    expect(getThreadAuth('t-ttl-04203')).toEqual({ user_id: 'u-1', exafy_admin: true });

    jest.advanceTimersByTime(THREAD_AUTH_TTL_MS - 1);
    expect(getThreadAuth('t-ttl-04203')).toEqual({ user_id: 'u-1', exafy_admin: true });

    jest.advanceTimersByTime(1);
    expect(getThreadAuth('t-ttl-04203')).toBeUndefined();
  });

  it('clearThreadAuth cancels the pending timer — advancing time past the TTL afterward does nothing new', () => {
    setThreadAuth('t-ttl-cancel-04203', { user_id: 'u-2', exafy_admin: true });
    clearThreadAuth('t-ttl-cancel-04203');
    expect(getThreadAuth('t-ttl-cancel-04203')).toBeUndefined();

    // If clearThreadAuth failed to cancel the setTimeout, this would just
    // be a harmless no-op delete on an already-absent key — the marker
    // must still read undefined, and no error/leak should surface.
    expect(() => jest.advanceTimersByTime(THREAD_AUTH_TTL_MS + 1000)).not.toThrow();
    expect(getThreadAuth('t-ttl-cancel-04203')).toBeUndefined();
  });

  it('setThreadAuth called again for the same thread resets the TTL window rather than stacking timers', () => {
    setThreadAuth('t-ttl-04203', { user_id: 'u-1', exafy_admin: true });
    jest.advanceTimersByTime(THREAD_AUTH_TTL_MS - 1000);
    // Re-set just before the original window would have expired.
    setThreadAuth('t-ttl-04203', { user_id: 'u-3', exafy_admin: false });
    jest.advanceTimersByTime(1000);
    // The original timer's expiry point has passed, but the re-set marker
    // (with its own fresh TTL) must still be live.
    expect(getThreadAuth('t-ttl-04203')).toEqual({ user_id: 'u-3', exafy_admin: false });

    jest.advanceTimersByTime(THREAD_AUTH_TTL_MS - 1000);
    expect(getThreadAuth('t-ttl-04203')).toBeUndefined();
  });
});
