/**
 * VTID-02917 (B0d.3) — Pure aggregation over a WakeTimelineRow.
 *
 * Computes the per-wake + per-disconnect aggregates from the events
 * array. Pure function: no IO, no clock, deterministic on its input.
 * The recorder calls this on session-end; the read API also calls it
 * lazily when the stored aggregates field is null (e.g. for an
 * in-flight session).
 *
 * Measure-before-optimize: this slice ONLY computes the summary. It
 * does NOT decide if the summary is "bad" or trigger any tuning.
 */

import type {
  ContinuationKindHint,
  DisconnectAggregate,
  WakeAggregates,
  WakeTimelineEvent,
  WakeTransport,
} from './timeline-events';

export interface AggregateInputs {
  events: ReadonlyArray<WakeTimelineEvent>;
  /** ISO 8601 of when the session was created. */
  startedAt: string;
  transport: WakeTransport;
}

export interface AggregateOutputs {
  wake: WakeAggregates | null;
  disconnects: DisconnectAggregate[];
}

/**
 * Build the aggregates from the raw event stream + session metadata.
 * Tolerates missing / out-of-order events: every "missing" branch
 * produces an explicit null + a reason, never a silent guess.
 */
export function aggregateTimeline(input: AggregateInputs): AggregateOutputs {
  const events = [...input.events].sort(
    (a, b) => a.tSessionMs - b.tSessionMs,
  );
  const sessionStartMs = Date.parse(input.startedAt);

  return {
    wake: computeWakeAggregate(events),
    disconnects: computeDisconnectAggregates(events, sessionStartMs, input.transport),
  };
}

function computeWakeAggregate(
  events: ReadonlyArray<WakeTimelineEvent>,
): WakeAggregates | null {
  if (events.length === 0) return null;

  // `wake_clicked` is the user-perceived start when the frontend sent it;
  // fall back to `session_start_received` (backend's earliest signal).
  const wakeClick = events.find((e) => e.name === 'wake_clicked');
  const sessionStart = events.find((e) => e.name === 'session_start_received');
  const startEvent = wakeClick ?? sessionStart;
  const firstAudio = events.find((e) => e.name === 'first_audio_output');

  let time_to_first_audio_ms: number | null = null;
  if (startEvent && firstAudio) {
    time_to_first_audio_ms = Math.max(
      0,
      firstAudio.tSessionMs - startEvent.tSessionMs,
    );
  }

  // Continuation outcome — the wake_brief_selected event carries the kind.
  const wakeBrief = events.find((e) => e.name === 'wake_brief_selected');
  let selected_continuation_kind: ContinuationKindHint | null = null;
  let none_with_reason: string | undefined;
  if (wakeBrief) {
    const m = (wakeBrief.metadata ?? {}) as Record<string, unknown>;
    const kind = m.selected_continuation_kind;
    if (typeof kind === 'string') {
      selected_continuation_kind = kind as ContinuationKindHint;
    }
    if (
      selected_continuation_kind === 'none_with_reason' &&
      typeof m.none_with_reason === 'string'
    ) {
      none_with_reason = m.none_with_reason;
    }
  }

  // Fallback was used when any of these fired:
  //   - manual_restart_required
  //   - reconnect_attempt with no following reconnect_success
  //   - first_audio_output never fired but disconnect did
  const hasManualRestart = events.some((e) => e.name === 'manual_restart_required');
  const hasReconnectAttempt = events.some((e) => e.name === 'reconnect_attempt');
  const hasReconnectSuccess = events.some((e) => e.name === 'reconnect_success');
  const hasDisconnect = events.some((e) => e.name === 'disconnect');
  const fallback_used =
    hasManualRestart ||
    (hasReconnectAttempt && !hasReconnectSuccess) ||
    (!firstAudio && hasDisconnect);

  // R0 (VTID-02927): stage-by-stage breakdown so operators can read
  // "where the latency lives" without walking events by hand.
  // (sessionStart already in scope from the time_to_first_audio block.)
  const decisionFinished = events.find((e) => e.name === 'continuation_decision_finished');
  const upstreamConnected = events.find((e) => e.name === 'upstream_live_connected');
  const stage_breakdown = {
    wake_to_gateway_ms:
      wakeClick && sessionStart
        ? Math.max(0, sessionStart.tSessionMs - wakeClick.tSessionMs)
        : null,
    gateway_to_decision_ms:
      sessionStart && decisionFinished
        ? Math.max(0, decisionFinished.tSessionMs - sessionStart.tSessionMs)
        : null,
    decision_to_upstream_ms:
      decisionFinished && upstreamConnected
        ? Math.max(0, upstreamConnected.tSessionMs - decisionFinished.tSessionMs)
        : null,
    upstream_to_first_audio_ms:
      upstreamConnected && firstAudio
        ? Math.max(0, firstAudio.tSessionMs - upstreamConnected.tSessionMs)
        : null,
  };

  return {
    time_to_first_audio_ms,
    stage_breakdown,
    selected_continuation_kind,
    fallback_used,
    ...(none_with_reason ? { none_with_reason } : {}),
  };
}

function computeDisconnectAggregates(
  events: ReadonlyArray<WakeTimelineEvent>,
  sessionStartMs: number,
  transport: WakeTransport,
): DisconnectAggregate[] {
  return events
    .filter((e) => e.name === 'disconnect')
    .map((e) => {
      const m = (e.metadata ?? {}) as Record<string, unknown>;
      const eventAtMs = Date.parse(e.at);
      const session_age_ms = Number.isFinite(eventAtMs) && Number.isFinite(sessionStartMs)
        ? Math.max(0, eventAtMs - sessionStartMs)
        : e.tSessionMs;
      const reason = typeof m.disconnect_reason === 'string' ? m.disconnect_reason : null;
      const upstreamState = typeof m.upstream_state === 'string' ? m.upstream_state : null;

      const out: DisconnectAggregate = {
        disconnect_reason: reason,
        session_age_ms,
        transport: typeof m.transport === 'string'
          ? (m.transport as WakeTransport)
          : transport,
        upstream_state: upstreamState,
        at: e.at,
      };

      // Per the plan: when disconnect_reason is null, we MUST attach
      // unknown_with_context. Silent unknowns are forbidden.
      if (reason === null) {
        out.unknown_with_context = {
          metadata_keys: Object.keys(m),
          tSessionMs: e.tSessionMs,
        };
      }

      return out;
    });
}
