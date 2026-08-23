/**
 * VTID-03597 — did the user's previous ORB session actually FAIL?
 *
 * ## Why this exists
 *
 * `fetchLastSessionInfo()` used to answer that question by looking at the
 * previous session's metrics alone:
 *
 *     wasFailure = turnCount === 0 || audioOut === 0;
 *
 * It read no close reason at all. But "nobody spoke and nothing was said" is
 * the signature of the three most ordinary ways a session ends, none of which
 * is a failure:
 *
 *   - `idle_no_engagement`   the user opened ORB and didn't speak; VTID-03510's
 *                            cost reaper closed the billed stream. Working as
 *                            designed.
 *   - `expired_ttl`          the absolute 30-minute cap. Also the reaper.
 *   - `superseded_by_new_session`  the user reopened ORB, so the old session
 *                            was replaced. That is the user being present, not
 *                            a fault.
 *
 * Measured on production over 14 days: **153 of 176 stop events (87%) would be
 * classified as failures**, across exactly those three reasons — and there was
 * not one `nova_stream_error` in the entire window. So `wasFailure` was true
 * almost always, and the legacy apology branch (which fires when wasFailure is
 * set and the reopen lands in the reconnect/recent bucket) greeted the user
 * with *"Entschuldige, da ist etwas schiefgelaufen"* — sorry, something went
 * wrong — for sessions where nothing had.
 *
 * Reported live 2026-08-11 as that apology repeating in the Messenger thread.
 *
 * **VTID-03510 is what turned this from rare into constant, and it was mine.**
 * Cutting the idle reap from 32 minutes to 5 did not create the predicate bug,
 * but it moved the stop event much closer to the user's next open — and the
 * apology only fires when that next open lands in the `reconnect`/`recent`
 * window. A latent misclassification became the common path.
 *
 * ## Why an allowlist of FAILURES, not a denylist of benign reasons
 *
 * The set of ways a session can end benignly is open — VTID-03561 added three
 * new reasons in one commit (`client_disconnect`, `client_error`,
 * `ws_session_expired`) and more will follow. A denylist would silently
 * mis-flag every reason invented after it was written, which is the same shape
 * of bug this file exists to remove.
 *
 * The set of genuine failures is small, named, and changes rarely. So: name the
 * failures, and let everything else — including reasons that do not exist yet —
 * default to "not a failure".
 *
 * That default is also the safe one. A missed apology costs nothing: the user
 * gets an ordinary greeting. A false apology tells someone their product is
 * broken when it is not, which is precisely the screenshot that prompted this.
 */

/**
 * Close reasons that mean the previous session genuinely failed the user.
 *
 * `nova_stream_error` is the Nova Sonic "Premature close" (CLAUDE.md §2e) —
 * the bidirectional stream dies at open and the user hears silence.
 * `nova_stream_timeout` is the same class, surfaced by the inactivity deadline.
 *
 * Deliberately NOT here:
 *   - `client_disconnect` / `ws_session_expired` — the user closed the tab or
 *     the socket aged out. Ordinary.
 *   - `client_error` — a client-side transport error. It may well have been a
 *     bad experience, but the gateway cannot tell a dropped mobile connection
 *     from a real fault, and apologising for a tunnel change is the false
 *     positive this file removes. Revisit on evidence, not on suspicion.
 */
const FAILURE_CLOSE_REASONS: ReadonlySet<string> = new Set([
  'nova_stream_error',
  'nova_stream_timeout',
]);

export interface PreviousSessionClose {
  /** `metadata.reason` from the previous `vtid.live.session.stop` event. */
  reason?: string | null;
  /** Retained for the one case metrics still decide — see below. */
  turnCount?: number;
  audioOutChunks?: number;
}

/**
 * True only when the previous session ended in a way worth apologising for.
 *
 * The metrics are still consulted, but only to CONFIRM a reason that already
 * claims failure — never to infer one. A `nova_stream_error` that nonetheless
 * delivered audio and completed turns is not the silent-open failure the
 * apology is written for, so it does not qualify: §2e records `audio_out = 0`
 * as perfectly correlated with that reason and present under no other, which
 * is exactly what makes it a safe confirmation rather than a second guess.
 */
export function wasPreviousSessionFailure(close: PreviousSessionClose | null | undefined): boolean {
  if (!close) return false;

  const reason = (close.reason ?? '').trim();
  // No reason recorded — an older event, or a clean stop that predates the
  // VTID-03561 emit. Unknown is NOT failure: see the safe-default note above.
  if (!reason) return false;
  if (!FAILURE_CLOSE_REASONS.has(reason)) return false;

  // The reason says failure. Confirm the user actually got nothing.
  const audioOut = Number(close.audioOutChunks) || 0;
  return audioOut === 0;
}

/** Exposed for tests and diagnostics — the reasons that count as failure. */
export function failureCloseReasons(): string[] {
  return [...FAILURE_CLOSE_REASONS];
}
