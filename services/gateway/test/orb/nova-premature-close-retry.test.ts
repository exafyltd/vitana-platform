/**
 * VTID-03557 — one fresh Nova retry before VTID-03502's Vertex fallback.
 *
 * Companion to nova-premature-close-fallback.test.ts. Nova's "Premature
 * close" failures are Node's own stream-teardown error (ERR_STREAM_PREMATURE_
 * CLOSE), not our timeout code, and every Nova connect already opens a
 * genuinely fresh HTTP/2 session (event-stream commands skip the SDK's
 * pooled-session fast path) — so a retry is a materially independent
 * connection attempt, not a replay of whatever the first one hit. This
 * predicate decides whether that retry should fire, on the identical
 * discriminator as the Vertex fallback but gated on its own flag so the two
 * compose as "retry once, then fall back."
 */

import { shouldRetryNovaOnPrematureClose } from '../../src/routes/orb-live';

const base = {
  sessionActive: true,
  initiatedLocally: false,
  rotationInFlight: false,
  hasProducedAudio: false,
  alreadyRetried: false,
};

describe('VTID-03557 shouldRetryNovaOnPrematureClose', () => {
  it('fires on the measured failure: active session, remote close, zero audio out', () => {
    expect(shouldRetryNovaOnPrematureClose(base)).toBe(true);
  });

  it('does NOT fire once any audio has been produced', () => {
    // Review fix: backed by transportHasShownLife, never the synthetic
    // activation chime — see the sibling fallback test for the full
    // rationale (both predicates share the same discriminator shape).
    expect(shouldRetryNovaOnPrematureClose({ ...base, hasProducedAudio: true })).toBe(false);
  });

  it('does NOT fire when we closed the stream ourselves', () => {
    expect(shouldRetryNovaOnPrematureClose({ ...base, initiatedLocally: true })).toBe(false);
  });

  it('does NOT fire during a planned rotation, which owns its own reconnect', () => {
    expect(shouldRetryNovaOnPrematureClose({ ...base, rotationInFlight: true })).toBe(false);
  });

  it('does NOT fire on an inactive session', () => {
    expect(shouldRetryNovaOnPrematureClose({ ...base, sessionActive: false })).toBe(false);
  });

  it('does NOT fire twice — one retry per session, then the Vertex fallback takes over', () => {
    expect(shouldRetryNovaOnPrematureClose({ ...base, alreadyRetried: true })).toBe(false);
  });

  it('requires EVERY condition — no single flag can force it on', () => {
    const negations = [
      { sessionActive: false },
      { initiatedLocally: true },
      { rotationInFlight: true },
      { hasProducedAudio: true },
      { alreadyRetried: true },
    ];
    for (const n of negations) {
      expect(shouldRetryNovaOnPrematureClose({ ...base, ...n })).toBe(false);
    }
  });

  it('composes with the Vertex fallback as a two-strike policy: retry flag and fallback flag are independent', () => {
    // First strike: not yet retried, not yet fallen back → retry fires.
    expect(shouldRetryNovaOnPrematureClose({ ...base, alreadyRetried: false })).toBe(true);
    // Second strike (retry already happened, fallback has not yet) → retry
    // does not fire again; the caller falls through to
    // shouldFallbackToVertexOnNovaClose, which is exercised in the sibling
    // test file and fires exactly when alreadyFellBack is still false.
    expect(shouldRetryNovaOnPrematureClose({ ...base, alreadyRetried: true })).toBe(false);
  });
});
