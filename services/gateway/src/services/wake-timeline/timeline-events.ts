/**
 * VTID-02917 (B0d.3) — ORB wake reliability timeline event names + aggregate
 * shapes.
 *
 * The 16 event names are LOCKED. The user instructed not to invent
 * rename variants in future sessions — every event consumer (recorder,
 * orb-live.ts instrumentation points, Command Hub panel) imports from
 * here, never from a string literal.
 */

// ---------------------------------------------------------------------------
// The 16 locked event names — DO NOT rename, DO NOT add to this list
// outside of an explicit scope expansion approved by the user.
// ---------------------------------------------------------------------------

export const WAKE_TIMELINE_EVENT_NAMES = [
  'wake_clicked',
  'client_context_received',
  'ws_opened',
  'session_start_received',
  'session_context_built',
  'continuation_decision_started',
  'continuation_decision_finished',
  'wake_brief_selected',
  'upstream_live_connect_started',
  'upstream_live_connected',
  'first_model_output',
  'first_audio_output',
  'disconnect',
  'reconnect_attempt',
  'reconnect_success',
  'manual_restart_required',
] as const;

export type WakeTimelineEventName = (typeof WAKE_TIMELINE_EVENT_NAMES)[number];

export const WAKE_TIMELINE_EVENT_NAMES_SET: ReadonlySet<WakeTimelineEventName> =
  new Set(WAKE_TIMELINE_EVENT_NAMES);

export function isWakeTimelineEventName(
  v: unknown,
): v is WakeTimelineEventName {
  return (
    typeof v === 'string' &&
    WAKE_TIMELINE_EVENT_NAMES_SET.has(v as WakeTimelineEventName)
  );
}

// ---------------------------------------------------------------------------
// Event shape — one row per recorded event inside the session timeline.
// `metadata` is intentionally free-form (capped by JSONB) so each event
// can carry a small payload (e.g. continuation_decision_finished carries
// the picked kind; first_audio_output carries the bytes/ms; disconnect
// carries the reason).
// ---------------------------------------------------------------------------

export interface WakeTimelineEvent {
  name: WakeTimelineEventName;
  /** ISO 8601. Recorder injects when missing. */
  at: string;
  /** Monotonic millis since session start (for delta visualization). */
  tSessionMs: number;
  /** Optional small payload. Recorder validates structure is plain object. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Per-wake aggregate (computed at session-end, never inferred at read time).
// ---------------------------------------------------------------------------

export type ContinuationKindHint =
  | 'wake_brief'
  | 'next_step'
  | 'did_you_know'
  | 'feature_discovery'
  | 'opportunity'
  | 'reminder'
  | 'check_in'
  | 'offer_to_continue'
  | 'journey_guidance'
  | 'match_journey_next_move'
  | 'none_with_reason';

export interface WakeAggregates {
  /**
   * Time from the earliest `wake_clicked` (frontend) OR
   * `session_start_received` (backend fallback) to the first
   * `first_audio_output`. `null` when first_audio_output never fired.
   */
  time_to_first_audio_ms: number | null;

  /**
   * The continuation kind that fired on the wake. When nothing fired,
   * `none_with_reason` (a real kind, not a sentinel). Mirrors B0d.1's
   * AssistantContinuationDecision semantics.
   */
  selected_continuation_kind: ContinuationKindHint | null;

  /**
   * Reason populated when `selected_continuation_kind === 'none_with_reason'`
   * OR when no decision fired at all (B0d.2 not yet wired into
   * orb-live.ts; B0d.3 still records the absence).
   */
  none_with_reason?: string;

  /**
   * Did the orb fall back to the silent path / manual restart / any
   * non-happy-path branch? `false` means a clean wake-to-first-audio.
   */
  fallback_used: boolean;
}

// ---------------------------------------------------------------------------
// Per-disconnect aggregate (one per disconnect event in the session).
// ---------------------------------------------------------------------------

export type WakeTransport = 'websocket' | 'sse' | 'rest_stream' | null;

export interface DisconnectAggregate {
  /** Specific reason if known; `null` if the recorder couldn't classify. */
  disconnect_reason: string | null;
  /** When disconnect_reason is null, the recorder MUST set this — never silent. */
  unknown_with_context?: Record<string, unknown>;
  session_age_ms: number;
  transport: WakeTransport;
  upstream_state: string | null;
  /** ISO 8601 timestamp of the disconnect. */
  at: string;
}

// ---------------------------------------------------------------------------
// Full timeline row as exposed by the read API. The DB row mirrors this
// shape (minus the computed display helpers); the recorder also keeps
// an in-memory copy keyed by session_id for sub-second visibility.
// ---------------------------------------------------------------------------

export interface WakeTimelineRow {
  session_id: string;
  tenant_id: string | null;
  user_id: string | null;
  surface: string;
  events: WakeTimelineEvent[];
  aggregates: {
    wake: WakeAggregates | null;
    disconnects: DisconnectAggregate[];
  } | null;
  transport: WakeTransport;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
}
