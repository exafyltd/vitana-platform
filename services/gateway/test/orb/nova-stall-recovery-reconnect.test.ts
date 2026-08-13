/**
 * VTID-03636 — a watchdog-triggered Nova stall must reconnect Nova itself,
 * never fall through to silence.
 *
 * Live report: "connected, but got stuck in the middle of the conversation."
 * Root cause traced through real prod telemetry (session live-d5cfc38d,
 * 2026-08-13): turn 4 started speaking at 10:05:00.219, produced no further
 * audio, and `startResponseWatchdog` fired `audio_stall` 20s later and
 * force-terminated the upstream WebSocket (this file's watchdog is
 * provider-agnostic — it terminates whatever `session.upstreamWs` currently
 * is and sets `_stallRecoveryPending = true`). The Vertex raw-WS close
 * handler has honored that flag since VTID-STREAM-RECONNECT
 * (`classifyUpstreamClose` treats it like Vertex's own code=1000 close), but
 * the Nova `onClose` handler never checked it — so the close fell through
 * `shouldRetryNovaOnPrematureClose` (blocked: the one retry budget was
 * already spent on this session's first-connect content-filter block) and
 * `shouldFallbackToVertexOnNovaClose` (blocked: three prior turns had
 * already produced real audio) and the final generic disconnect notice
 * (blocked: `initiated_locally` is true — the watchdog's own `.terminate()`
 * caused the close). Measured consequence: `upstream_closed reason=
 * terminated` followed by five `audio_no_ws` events ~3s apart with no
 * reconnect ever attempted — the session was silently abandoned while the
 * client kept streaming audio into a dead connection.
 *
 * `shouldReconnectNovaOnStall` is deliberately the inverse of the other two
 * predicates on the two signals that distinguish this case: it requires
 * `stallRecoveryPending` (which only the watchdog sets) rather than
 * requiring the close to be REMOTE, and it does not care about prior audio
 * at all — a mid-conversation stall is not the same failure as a premature
 * close at connect open, so it must not compete for the same retry/fallback
 * budgets. The caller reconnects Nova via the normal provider-selection
 * path and never sets `_novaFallbackToVertex`, keeping Nova the sole active
 * voice provider.
 */

import { shouldReconnectNovaOnStall } from '../../src/routes/orb-live';

const base = {
  sessionActive: true,
  rotationInFlight: false,
  stallRecoveryPending: true,
};

describe('VTID-03636 shouldReconnectNovaOnStall', () => {
  it('fires on the measured failure: active session, watchdog-armed stall recovery', () => {
    expect(shouldReconnectNovaOnStall(base)).toBe(true);
  });

  it('fires REGARDLESS of prior audio — unlike the retry/fallback predicates, a mid-conversation stall is not a premature-close-at-connect', () => {
    // shouldReconnectNovaOnStall's signature has no hasProducedAudio input at
    // all; this test documents that omission is intentional by exercising
    // the exact scenario (turns already completed with real audio) that
    // blocks both sibling predicates.
    expect(shouldReconnectNovaOnStall(base)).toBe(true);
  });

  it('does NOT fire when the watchdog did not arm stall recovery', () => {
    expect(shouldReconnectNovaOnStall({ ...base, stallRecoveryPending: false })).toBe(false);
  });

  it('does NOT fire during a planned rotation, which owns its own reconnect', () => {
    expect(shouldReconnectNovaOnStall({ ...base, rotationInFlight: true })).toBe(false);
  });

  it('does NOT fire on an inactive session', () => {
    expect(shouldReconnectNovaOnStall({ ...base, sessionActive: false })).toBe(false);
  });

  it('requires EVERY condition — no single flag can force it on', () => {
    const negations = [
      { sessionActive: false },
      { rotationInFlight: true },
      { stallRecoveryPending: false },
    ];
    for (const n of negations) {
      expect(shouldReconnectNovaOnStall({ ...base, ...n })).toBe(false);
    }
  });
});
