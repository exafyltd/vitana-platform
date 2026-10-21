/**
 * VTID-03597 — the apology opener must fire only on a real failure.
 *
 * The cases below are the ACTUAL close-reason distribution measured on
 * production over 14 days (2026-08-11):
 *
 *   expired_ttl                62 stops   62 previously flagged as failure
 *   idle_no_engagement         46 stops   46 previously flagged
 *   superseded_by_new_session  45 stops   45 previously flagged
 *   (no reason recorded)       23 stops   15 previously flagged
 *   nova_stream_error           0 stops    — the only real failure, absent
 *
 * 153 of 176 (87%) classified as failures; zero were.
 */
import {
  wasPreviousSessionFailure,
  failureCloseReasons,
} from '../../src/orb/live/session/session-failure-classifier';

// Every benign reason carries turn_count=0 / audio_out=0 — that is exactly why
// the old metric-only predicate could not tell them from a real failure.
const BENIGN_ZERO_METRICS = { turnCount: 0, audioOutChunks: 0 };

describe('VTID-03597 — wasPreviousSessionFailure', () => {
  describe('the three commonest production closes are NOT failures', () => {
    for (const reason of ['idle_no_engagement', 'expired_ttl', 'superseded_by_new_session']) {
      test(`${reason} → not a failure (was 100% flagged before)`, () => {
        expect(wasPreviousSessionFailure({ reason, ...BENIGN_ZERO_METRICS })).toBe(false);
      });
    }
  });

  describe('transport-level closes are not failures either', () => {
    for (const reason of ['client_disconnect', 'ws_session_expired', 'client_error', 'idle_timeout']) {
      test(`${reason} → not a failure`, () => {
        expect(wasPreviousSessionFailure({ reason, ...BENIGN_ZERO_METRICS })).toBe(false);
      });
    }
  });

  describe('a genuine Nova failure still is one', () => {
    test('nova_stream_error with zero audio out → failure', () => {
      expect(
        wasPreviousSessionFailure({ reason: 'nova_stream_error', turnCount: 0, audioOutChunks: 0 }),
      ).toBe(true);
    });

    test('nova_stream_timeout with zero audio out → failure', () => {
      expect(
        wasPreviousSessionFailure({ reason: 'nova_stream_timeout', turnCount: 0, audioOutChunks: 0 }),
      ).toBe(true);
    });

    test('a nova_stream_error that DID deliver audio is not the silent-open failure', () => {
      // §2e: audio_out=0 is perfectly correlated with the premature-close
      // failure the apology is written for. A stream error after the user
      // heard something is a mid-conversation drop, not a dead open.
      expect(
        wasPreviousSessionFailure({ reason: 'nova_stream_error', turnCount: 1, audioOutChunks: 40 }),
      ).toBe(false);
    });
  });

  describe('unknown and missing reasons default to NOT a failure', () => {
    test('no reason recorded → not a failure', () => {
      expect(wasPreviousSessionFailure({ reason: null, ...BENIGN_ZERO_METRICS })).toBe(false);
      expect(wasPreviousSessionFailure({ reason: '', ...BENIGN_ZERO_METRICS })).toBe(false);
      expect(wasPreviousSessionFailure({ ...BENIGN_ZERO_METRICS })).toBe(false);
    });

    test('no previous session at all → not a failure', () => {
      expect(wasPreviousSessionFailure(null)).toBe(false);
      expect(wasPreviousSessionFailure(undefined)).toBe(false);
    });

    test('a close reason invented AFTER this file → not a failure', () => {
      // The whole point of the allowlist: a reason nobody has written yet must
      // not start apologising on its own. A denylist would have flagged this.
      expect(
        wasPreviousSessionFailure({ reason: 'some_future_reason_2027', ...BENIGN_ZERO_METRICS }),
      ).toBe(false);
    });
  });

  test('the failure allowlist stays small and explicit', () => {
    const reasons = failureCloseReasons();
    expect(reasons).toEqual(expect.arrayContaining(['nova_stream_error', 'nova_stream_timeout']));
    expect(reasons.length).toBeLessThan(6);
  });

  test('REGRESSION: replaying the measured prod distribution yields 0 false apologies', () => {
    // 176 stops, in the exact proportions measured on production.
    const prod: Array<[string | null, number]> = [
      ['expired_ttl', 62],
      ['idle_no_engagement', 46],
      ['superseded_by_new_session', 45],
      [null, 23],
    ];
    let flagged = 0;
    let total = 0;
    for (const [reason, n] of prod) {
      for (let i = 0; i < n; i++) {
        total++;
        if (wasPreviousSessionFailure({ reason, ...BENIGN_ZERO_METRICS })) flagged++;
      }
    }
    expect(total).toBe(176);
    // Was 153. Must now be 0 — none of these is a failure.
    expect(flagged).toBe(0);
  });
});
