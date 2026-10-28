/**
 * VTID-03646 follow-up — the Nova-aware `day_close` retry VTID-03629 left as
 * an open TODO ("rebuild the opener from reduced content instead of
 * resending identical content") when it disabled the rung by default.
 *
 * `shouldRetryDayCloseReduced` does not decide whether a retry happens at
 * all — `shouldRetryNovaOnPrematureClose` already covers that for any
 * zero-audio close, `day_close` included, since it is not gated on
 * `closeReason`. This predicate decides whether that retry's resend should
 * rebuild `day_close`'s directive REDUCED (short, no quoted exemplars,
 * `buildDayCloseOpenerLine`) instead of resending the ~4200-char
 * `buildDayCloseBlock` that just got `nova_validation`-rejected.
 */

import { shouldRetryDayCloseReduced } from '../../src/routes/orb-live';

const base = {
  closeReason: 'nova_validation',
  lastWakeOpener: 'day_close',
  sessionActive: true,
  initiatedLocally: false,
  rotationInFlight: false,
  alreadyReducedThisClose: false,
};

describe('VTID-03646 follow-up shouldRetryDayCloseReduced', () => {
  it('fires on the measured failure: day_close session, content-filter close', () => {
    expect(shouldRetryDayCloseReduced(base)).toBe(true);
  });

  it('does NOT fire for a close reason other than nova_validation', () => {
    // A day_close open that dies for an unrelated transport reason should
    // get the SAME directive back on retry — the content was never in
    // question, so shrinking it would misattribute an unrelated failure.
    expect(shouldRetryDayCloseReduced({ ...base, closeReason: 'nova_stream_error' })).toBe(false);
    expect(shouldRetryDayCloseReduced({ ...base, closeReason: null })).toBe(false);
  });

  it('does NOT fire when the last opener was not day_close', () => {
    expect(shouldRetryDayCloseReduced({ ...base, lastWakeOpener: 'override_v2' })).toBe(false);
    expect(shouldRetryDayCloseReduced({ ...base, lastWakeOpener: null })).toBe(false);
  });

  it('does NOT fire when we closed the stream ourselves', () => {
    expect(shouldRetryDayCloseReduced({ ...base, initiatedLocally: true })).toBe(false);
  });

  it('does NOT fire during a planned rotation', () => {
    expect(shouldRetryDayCloseReduced({ ...base, rotationInFlight: true })).toBe(false);
  });

  it('does NOT fire on an inactive session', () => {
    expect(shouldRetryDayCloseReduced({ ...base, sessionActive: false })).toBe(false);
  });

  it('does NOT re-arm on a second nova_validation close in the same session', () => {
    // Prevents a reduced retry that also gets blocked from looping forever;
    // shouldRetryNovaOnPrematureClose's own alreadyRetried gate is what
    // actually stops the second attempt from firing at all, but this guard
    // keeps the flag itself from staying stuck on.
    expect(shouldRetryDayCloseReduced({ ...base, alreadyReducedThisClose: true })).toBe(false);
  });

  it('requires EVERY guarding condition — no single flag can force it on', () => {
    const negations = [
      { closeReason: 'nova_stream_error' },
      { lastWakeOpener: 'override_v2' },
      { sessionActive: false },
      { initiatedLocally: true },
      { rotationInFlight: true },
      { alreadyReducedThisClose: true },
    ];
    for (const n of negations) {
      expect(shouldRetryDayCloseReduced({ ...base, ...n })).toBe(false);
    }
  });
});
