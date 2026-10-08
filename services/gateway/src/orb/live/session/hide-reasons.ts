/**
 * VTID-05001 — why the ORB overlay closed.
 *
 * The widget's `_hide(reason)` reports which of its close paths ran, how long
 * after the tap, on which transport, and whether the session had started.
 * The continuity route copies these into its `orb.session.continuity.persisted`
 * event. Until now that event only said `reason: "hide"`, so the 2026-10-04..07
 * prod failure (overlay closed ~1.3 s after the tap, before `session_started`)
 * could not be traced to a caller.
 *
 * Client input, so everything is allowlisted or clamped; anything else is
 * dropped. The list mirrors HIDE_REASONS in
 * src/frontend/command-hub/orb-widget.js — a test keeps them in step.
 */

export const HIDE_REASONS = [
  'session_superseded',
  'signup_redirect',
  'navigate',
  'end_teaching_session',
  'end_conversation',
  'commerce_setup_draft',
  'bg_watchdog',
  'fab_toggle',
  'close_button',
  'guided_topic_end',
  'reset',
  'nav_tool',
  'api_hide',
  'api_toggle',
  'view_role_change',
  'unknown',
] as const;

export type HideReason = (typeof HIDE_REASONS)[number];

export interface HideDiagnostics {
  hide_reason?: HideReason;
  ms_since_tap?: number;
  transport?: 'ws' | 'sse';
  start_phase?: 'connecting' | 'started';
}

/** Longest tap-to-close interval worth recording (1 h); longer is clamped. */
export const MAX_MS_SINCE_TAP = 3_600_000;

/**
 * Pick the four diagnostic fields out of a continuity POST body. Missing or
 * invalid fields are omitted, so an older widget (which sends none) produces
 * an empty object and the event is unchanged.
 */
export function sanitizeHideDiagnostics(body: unknown): HideDiagnostics {
  const out: HideDiagnostics = {};
  if (!body || typeof body !== 'object') return out;
  const b = body as Record<string, unknown>;
  if (typeof b.hide_reason === 'string' && (HIDE_REASONS as readonly string[]).includes(b.hide_reason)) {
    out.hide_reason = b.hide_reason as HideReason;
  }
  if (typeof b.ms_since_tap === 'number' && Number.isFinite(b.ms_since_tap)) {
    out.ms_since_tap = Math.min(MAX_MS_SINCE_TAP, Math.max(0, Math.round(b.ms_since_tap)));
  }
  if (b.transport === 'ws' || b.transport === 'sse') out.transport = b.transport;
  if (b.start_phase === 'connecting' || b.start_phase === 'started') out.start_phase = b.start_phase;
  return out;
}
