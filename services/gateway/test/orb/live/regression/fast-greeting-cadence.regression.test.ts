/**
 * BOOTSTRAP-ORB-FAST-GREETING-CADENCE — regression lock.
 *
 * Root cause (confirmed from dragan3's production sessions, 2026-06-23): the
 * SAFE-FAST greeting ladder in sendGreetingPromptToLiveAPI emitted a greeting
 * on EVERY session — it never consulted the greet-once / recent-turn cadence
 * cap that decideGreetingPolicy enforces. A quick orb reopen therefore
 * re-greeted ("Guten Morgen, <Name>.") seconds apart. The diag stream showed
 * `wake_opener=safe_fast_*` on ~25 of the last 30 greetings, never silenced.
 *
 * The fix wires the fast greeting-facts prefetch through the SAME
 * decideGreetingPolicy authority and silences the fast path when it returns
 * 'skip'. This test locks BOTH directions of that contract so a future change
 * cannot regress it:
 *
 *   1. A second press inside the greet-once window MUST resolve to 'skip'
 *      (no re-greet).
 *   2. A genuine first / new-day open MUST NOT be silenced (we still greet
 *      returning + new users — the fix must not over-suppress).
 *
 * It asserts on decideGreetingPolicy — the single authority the fast path now
 * consults (live-session-controller greeting-facts prefetch → session
 * .greetingCadenceSkip → orb-live.ts SAFE-FAST ladder).
 */

import {
  decideGreetingPolicy,
} from '../../../../src/orb/live/instruction/greeting-policy';

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const FIVE_MIN_S = 5 * 60;

describe('fast-greeting cadence regression (greet-once + recent-turn)', () => {
  describe('MUST suppress — a quick reopen does not re-greet', () => {
    it('greeted 2 minutes ago today → skip', () => {
      expect(
        decideGreetingPolicy({
          bucket: 'today',
          time_since_last_greeting_today_ms: 2 * 60 * 1000,
        }),
      ).toBe('skip');
    });

    it('greeted 10 seconds ago (the exact user-reported reopen) → skip', () => {
      expect(
        decideGreetingPolicy({
          bucket: 'reconnect',
          time_since_last_greeting_today_ms: 10 * 1000,
        }),
      ).toBe('skip');
    });

    it('just under the 15-min greet-once window → skip', () => {
      expect(
        decideGreetingPolicy({
          bucket: 'today',
          time_since_last_greeting_today_ms: FIFTEEN_MIN_MS - 1000,
        }),
      ).toBe('skip');
    });

    it('a turn happened 30s ago (mid-thread continuation) → skip', () => {
      expect(
        decideGreetingPolicy({
          bucket: 'today',
          seconds_since_last_turn_anywhere: 30,
        }),
      ).toBe('skip');
    });

    it('transparent/server reconnect → skip', () => {
      expect(decideGreetingPolicy({ bucket: 'today', isReconnect: true })).toBe('skip');
    });
  });

  describe('MUST NOT suppress — legitimate openers still greet', () => {
    it('first-ever session, no cadence signals → fresh_intro (greets)', () => {
      expect(decideGreetingPolicy({ bucket: 'first' })).toBe('fresh_intro');
    });

    it('new-day return after a long gap, no recent greeting → not skip', () => {
      const policy = decideGreetingPolicy({ bucket: 'long' });
      expect(policy).not.toBe('skip');
    });

    it('greeted earlier today but OUTSIDE the 15-min window → not skip', () => {
      const policy = decideGreetingPolicy({
        bucket: 'today',
        time_since_last_greeting_today_ms: FIFTEEN_MIN_MS + 60 * 1000,
      });
      expect(policy).not.toBe('skip');
    });

    it('last turn was 6 minutes ago (outside recent-turn window) → not skip', () => {
      const policy = decideGreetingPolicy({
        bucket: 'today',
        seconds_since_last_turn_anywhere: (FIVE_MIN_S + 60),
      });
      expect(policy).not.toBe('skip');
    });
  });
});
