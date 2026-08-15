/**
 * VTID-03502 — Nova premature-close-at-open fallback to Vertex.
 *
 * Companion to VTID-03501's global promotion flag. Nova fails 10.2% of
 * sessions (6/59, 2026-07-29 → 08-05) with diagnostic "Premature close": the
 * bidirectional stream dies at open with zero audio in either direction, and
 * the user is left in silence with no indication anything broke.
 *
 * These tests pin the DISCRIMINATOR. Getting it too broad would send healthy
 * mid-conversation drops to Vertex (losing Nova for no reason, and masking
 * real Nova behaviour); getting it too narrow leaves the 10% silent.
 */

import { shouldFallbackToVertexOnNovaClose } from '../../src/routes/orb-live';

const base = {
  sessionActive: true,
  initiatedLocally: false,
  rotationInFlight: false,
  hasProducedAudio: false,
  alreadyFellBack: false,
};

describe('VTID-03502 shouldFallbackToVertexOnNovaClose', () => {
  it('fires on the measured failure: active session, remote close, zero audio out', () => {
    expect(shouldFallbackToVertexOnNovaClose(base)).toBe(true);
  });

  it('does NOT fire once any audio has been produced', () => {
    // hasProducedAudio means the stream worked at least briefly — that is a
    // mid-conversation drop, not the premature-close-at-open failure, and
    // every non-nova_stream_error close reason has real audio out.
    //
    // VTID-03557 review fix: this is backed by session.transportHasShownLife,
    // never the synthetic activation chime, precisely so a chime sent between
    // connect and a premature close can't be mistaken for a live stream.
    expect(shouldFallbackToVertexOnNovaClose({ ...base, hasProducedAudio: true })).toBe(false);
  });

  it('does NOT fire when we closed the stream ourselves', () => {
    // Shutdown / persona swap / deliberate close are not failures.
    expect(shouldFallbackToVertexOnNovaClose({ ...base, initiatedLocally: true })).toBe(false);
  });

  it('does NOT fire during a planned rotation, which owns its own reconnect', () => {
    // Racing the rotation path would produce two concurrent reconnects.
    expect(shouldFallbackToVertexOnNovaClose({ ...base, rotationInFlight: true })).toBe(false);
  });

  it('does NOT fire on an inactive session', () => {
    expect(shouldFallbackToVertexOnNovaClose({ ...base, sessionActive: false })).toBe(false);
  });

  it('does NOT fire twice — a Vertex-side failure cannot bounce back and loop', () => {
    // Without this guard, a Vertex reconnect that also closes with zero audio
    // would re-enter the fallback indefinitely.
    expect(shouldFallbackToVertexOnNovaClose({ ...base, alreadyFellBack: true })).toBe(false);
  });

  it('requires EVERY condition — no single flag can force it on', () => {
    const negations = [
      { sessionActive: false },
      { initiatedLocally: true },
      { rotationInFlight: true },
      { hasProducedAudio: true },
      { alreadyFellBack: true },
    ];
    for (const n of negations) {
      expect(shouldFallbackToVertexOnNovaClose({ ...base, ...n })).toBe(false);
    }
  });

  // VTID-03641: a session whose language has no native voice on Vertex
  // either (pt/pl today) must never fall back to Vertex — that would
  // silently speak fluent English. `pollyOnlyVoice` defaults to false/
  // undefined so every case above (pre-existing behaviour) is unaffected.
  describe('VTID-03641 pollyOnlyVoice', () => {
    it('does NOT fire for a polly-only-voice session even when every other condition matches', () => {
      expect(shouldFallbackToVertexOnNovaClose({ ...base, pollyOnlyVoice: true })).toBe(false);
    });

    it('still fires normally when pollyOnlyVoice is explicitly false', () => {
      expect(shouldFallbackToVertexOnNovaClose({ ...base, pollyOnlyVoice: false })).toBe(true);
    });

    it('still fires normally when pollyOnlyVoice is omitted (default)', () => {
      expect(shouldFallbackToVertexOnNovaClose(base)).toBe(true);
    });
  });
});
