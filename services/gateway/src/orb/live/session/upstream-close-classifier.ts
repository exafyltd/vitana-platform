/**
 * VTID-03234 (report finding #2) — upstream Vertex WebSocket close classifier.
 *
 * The ORB "internet issues" loop was caused (in part) by the close handler
 * announcing a loud `connection_alert` to the client on EVERY upstream WS
 * close, BEFORE classifying whether the close was:
 *   - a persona swap (handled with a silent cue),
 *   - a TRANSPARENT reconnect — Vertex's normal ~5-min session close
 *     (code=1000) or watchdog stall-recovery (`_stallRecoveryPending`), which
 *     the gateway repairs server-side while the client's SSE/WS stays open, or
 *   - a GENUINE disconnect the client must actually react to.
 *
 * Only the genuine case warrants the loud alert. This pure helper makes that
 * decision testable in isolation (the close handler lives inside a ~13k-line
 * route file that cannot be imported directly in unit tests).
 */

export type UpstreamCloseAction =
  | 'ignore' // session inactive or setup never completed — nothing to announce
  | 'persona_swap' // voice channel-swap — silent persona cue
  | 'transparent_reconnect' // code=1000 / stall recovery — reconnect silently, no alert
  | 'genuine_disconnect'; // real failure — loud connection_alert is appropriate

export interface UpstreamCloseInput {
  /** WebSocket close code (1000 = normal close / Vertex session expiry). */
  code: number;
  /** Whether the live session is still active (not torn down by the user). */
  active: boolean;
  /** Whether Vertex setup completed (a pre-setup close is a connect failure). */
  setupComplete: boolean;
  /** Whether the watchdog force-terminated the WS for stall recovery. */
  stallRecoveryPending: boolean;
  /** Whether this close was triggered by an in-flight persona swap. */
  isPersonaSwap: boolean;
}

/**
 * Pure: classify an upstream WS close so the handler announces the RIGHT
 * thing (or nothing). No IO, no mutation.
 */
export function classifyUpstreamClose(input: UpstreamCloseInput): UpstreamCloseAction {
  const { code, active, setupComplete, stallRecoveryPending, isPersonaSwap } = input;
  // Pre-setup close or inactive session: the connect/teardown paths own it;
  // the post-setup announce block must stay silent.
  if (!active || !setupComplete) return 'ignore';
  // Persona swap closes the upstream deliberately — silent cue, not an alert.
  if (isPersonaSwap) return 'persona_swap';
  // Vertex's normal ~5-min close (1000) and watchdog stall-recovery are both
  // repaired transparently server-side — do NOT alarm the user.
  if (code === 1000 || stallRecoveryPending) return 'transparent_reconnect';
  // Anything else is a genuine disconnect the client must react to.
  return 'genuine_disconnect';
}
