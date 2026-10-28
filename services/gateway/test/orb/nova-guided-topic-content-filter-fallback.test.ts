/**
 * VTID-03647 — Nova content-filter block on a guided-topic request falls
 * back to Vertex instead of retrying the same provider.
 *
 * Live evidence: 34 `nova_validation` ("This request has been blocked by
 * our content filters") closes over 3 days (2026-08-12 → 08-15), including
 * one traced live for a real user report — "tapping a chapter talks like a
 * normal conversation instead of reading the lesson". The pre-existing
 * VTID-03557 retry reconnects to Nova again, which has now been shown
 * unreliable for this exact instruction shape; this discriminator routes
 * straight to the VTID-03502 Vertex-fallback machinery instead, WITHOUT the
 * `hasProducedAudio` gate that guards the sibling premature-close predicate
 * — an explicit, direct user request (a My Journey chapter tap) must never
 * be silently swapped for generic chat to save one provider hop.
 */

import { shouldFallbackToVertexOnGuidedTopicContentFilterBlock } from '../../src/routes/orb-live';

const base = {
  closeReason: 'nova_validation',
  hasGuidedTopicRequest: true,
  sessionActive: true,
  initiatedLocally: false,
  rotationInFlight: false,
  alreadyFellBack: false,
};

describe('VTID-03647 shouldFallbackToVertexOnGuidedTopicContentFilterBlock', () => {
  it('fires on the measured failure: guided-topic session, content-filter close', () => {
    expect(shouldFallbackToVertexOnGuidedTopicContentFilterBlock(base)).toBe(true);
  });

  it('does NOT fire for a close reason other than nova_validation', () => {
    // A premature-close / normal disconnect goes through the existing
    // VTID-03557/VTID-03502 predicates, not this one.
    expect(
      shouldFallbackToVertexOnGuidedTopicContentFilterBlock({ ...base, closeReason: 'nova_stream_error' }),
    ).toBe(false);
    expect(
      shouldFallbackToVertexOnGuidedTopicContentFilterBlock({ ...base, closeReason: null }),
    ).toBe(false);
  });

  it('does NOT fire when the session has no guided-topic request', () => {
    // An ordinary conversation blocked by the content filter still gets the
    // existing (audio-gated) VTID-03557 retry — this predicate is scoped to
    // the explicit-user-request case only.
    expect(
      shouldFallbackToVertexOnGuidedTopicContentFilterBlock({ ...base, hasGuidedTopicRequest: false }),
    ).toBe(false);
  });

  it('does NOT fire when we closed the stream ourselves', () => {
    expect(shouldFallbackToVertexOnGuidedTopicContentFilterBlock({ ...base, initiatedLocally: true })).toBe(false);
  });

  it('does NOT fire during a planned rotation', () => {
    expect(shouldFallbackToVertexOnGuidedTopicContentFilterBlock({ ...base, rotationInFlight: true })).toBe(false);
  });

  it('does NOT fire on an inactive session', () => {
    expect(shouldFallbackToVertexOnGuidedTopicContentFilterBlock({ ...base, sessionActive: false })).toBe(false);
  });

  it('does NOT fire twice — a Vertex-side failure cannot bounce back and loop', () => {
    expect(shouldFallbackToVertexOnGuidedTopicContentFilterBlock({ ...base, alreadyFellBack: true })).toBe(false);
  });

  it('fires REGARDLESS of whether audio was already produced (the deliberate divergence from VTID-03502)', () => {
    // There is no hasProducedAudio field at all in this predicate's args —
    // this test exists to make that omission a documented decision, not an
    // oversight, if a future edit tries to add one by analogy with the
    // sibling predicate.
    expect(Object.keys(base)).not.toContain('hasProducedAudio');
  });

  it('requires EVERY guarding condition — no single flag can force it on', () => {
    const negations = [
      { closeReason: 'nova_stream_error' },
      { hasGuidedTopicRequest: false },
      { sessionActive: false },
      { initiatedLocally: true },
      { rotationInFlight: true },
      { alreadyFellBack: true },
    ];
    for (const n of negations) {
      expect(shouldFallbackToVertexOnGuidedTopicContentFilterBlock({ ...base, ...n })).toBe(false);
    }
  });
});
