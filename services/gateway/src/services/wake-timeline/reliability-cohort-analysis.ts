/**
 * VTID-02927 (R0): cohort-level reliability analysis over a set of
 * wake timelines.
 *
 * Pure function over `WakeTimelineRow[]`. Produces the read-view the
 * R0 brief specifies:
 *   - Where latency lives (stage-by-stage p50 / p90 / p99 across
 *     wakes that reached first_audio_output)
 *   - Which stage drops sessions (count of wakes that never reached
 *     each milestone)
 *   - Percentage of unknown disconnects
 *   - Continuation outcome distribution
 *   - Transport distribution
 *
 * Wall: NO mutation. NO optimization. NO suggested fixes. Surface only.
 */

import type { WakeTimelineRow } from './timeline-events';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LatencyBucket {
  p50: number | null;
  p90: number | null;
  p99: number | null;
  count: number;
}

export interface StageLatencyBreakdown {
  wake_to_gateway_ms: LatencyBucket;
  gateway_to_decision_ms: LatencyBucket;
  decision_to_upstream_ms: LatencyBucket;
  upstream_to_first_audio_ms: LatencyBucket;
}

export interface MilestoneReachCounts {
  /** Sessions where wake_clicked fired (browser-side). */
  wake_clicked: number;
  /** Sessions where session_start_received fired (gateway boundary). */
  session_start_received: number;
  /** Sessions where continuation_decision_finished fired. */
  continuation_decision_finished: number;
  /** Sessions where upstream_live_connected fired. */
  upstream_live_connected: number;
  /** Sessions where first_audio_output fired (happy path). */
  first_audio_output: number;
  /** Sessions where disconnect fired. */
  disconnect: number;
}

export interface CohortAnalysis {
  /** Wake timelines analyzed. */
  total_sessions: number;
  /** Sessions with at least one event. */
  sessions_with_events: number;
  /** Sessions that reached first_audio_output. */
  sessions_with_first_audio: number;
  /** Sessions where `fallback_used = true`. */
  sessions_with_fallback: number;
  /**
   * Where latency lives. Computed only over sessions that REACHED the
   * relevant milestone; per-bucket count makes the sample size visible.
   */
  latency: {
    time_to_first_audio_ms: LatencyBucket;
    stages: StageLatencyBreakdown;
  };
  /**
   * How many sessions reached each milestone in the wake path. The
   * drop-off between milestones is "which stage drops sessions".
   */
  milestone_reach: MilestoneReachCounts;
  /**
   * Disconnect aggregates rolled up across the cohort.
   */
  disconnects: {
    total: number;
    by_reason: Record<string, number>;
    /** Disconnects with reason === null (unknown_with_context). */
    unknown: number;
    unknown_pct: number;
    by_transport: Record<string, number>;
  };
  /**
   * Continuation outcome distribution across wakes that ran the
   * decision. `none_with_reason_breakdown` itemizes the suppressed
   * cases so operators can see which suppression reason dominates.
   */
  continuation: {
    by_kind: Record<string, number>;
    none_with_reason_breakdown: Record<string, number>;
  };
  /**
   * Per-session evidence list — at least one successful wake + one
   * failed/slow wake reconstructed. Honors the R0 acceptance criterion
   * #3: every wake is identifiable end-to-end with a concrete reason.
   */
  evidence: {
    one_successful_session_id: string | null;
    one_failed_session_id: string | null;
    one_failed_missing_stage: string | null;
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function analyzeReliabilityCohort(
  rows: ReadonlyArray<WakeTimelineRow>,
): CohortAnalysis {
  const total_sessions = rows.length;
  let sessions_with_events = 0;
  let sessions_with_first_audio = 0;
  let sessions_with_fallback = 0;

  const ttfa: number[] = [];
  const wake_to_gateway: number[] = [];
  const gateway_to_decision: number[] = [];
  const decision_to_upstream: number[] = [];
  const upstream_to_first_audio: number[] = [];

  const milestone_reach: MilestoneReachCounts = {
    wake_clicked: 0,
    session_start_received: 0,
    continuation_decision_finished: 0,
    upstream_live_connected: 0,
    first_audio_output: 0,
    disconnect: 0,
  };

  const milestoneNames: Array<keyof MilestoneReachCounts> = [
    'wake_clicked',
    'session_start_received',
    'continuation_decision_finished',
    'upstream_live_connected',
    'first_audio_output',
    'disconnect',
  ];

  let disconnectsTotal = 0;
  let disconnectsUnknown = 0;
  const disconnectsByReason: Record<string, number> = {};
  const disconnectsByTransport: Record<string, number> = {};

  const continuationByKind: Record<string, number> = {};
  const noneWithReasonBreakdown: Record<string, number> = {};

  let oneSuccessfulSessionId: string | null = null;
  let oneFailedSessionId: string | null = null;
  let oneFailedMissingStage: string | null = null;

  for (const row of rows) {
    const events = row.events ?? [];
    if (events.length > 0) sessions_with_events++;

    // Reached-milestone bookkeeping.
    const reached: Record<string, boolean> = {};
    for (const m of milestoneNames) {
      if (events.some((e) => e.name === m)) {
        milestone_reach[m]++;
        reached[m] = true;
      }
    }

    const wake = row.aggregates?.wake;
    if (wake) {
      if (wake.fallback_used) sessions_with_fallback++;
      if (wake.time_to_first_audio_ms != null) {
        ttfa.push(wake.time_to_first_audio_ms);
        sessions_with_first_audio++;
      }
      if (wake.stage_breakdown) {
        const s = wake.stage_breakdown;
        if (s.wake_to_gateway_ms != null) wake_to_gateway.push(s.wake_to_gateway_ms);
        if (s.gateway_to_decision_ms != null) gateway_to_decision.push(s.gateway_to_decision_ms);
        if (s.decision_to_upstream_ms != null) decision_to_upstream.push(s.decision_to_upstream_ms);
        if (s.upstream_to_first_audio_ms != null) upstream_to_first_audio.push(s.upstream_to_first_audio_ms);
      }
      // Continuation outcome.
      const kind = wake.selected_continuation_kind ?? 'no_decision_recorded';
      continuationByKind[kind] = (continuationByKind[kind] ?? 0) + 1;
      if (wake.none_with_reason) {
        noneWithReasonBreakdown[wake.none_with_reason] =
          (noneWithReasonBreakdown[wake.none_with_reason] ?? 0) + 1;
      }
    }

    // Disconnect roll-up.
    for (const d of row.aggregates?.disconnects ?? []) {
      disconnectsTotal++;
      const reason = d.disconnect_reason ?? null;
      if (reason === null) {
        disconnectsUnknown++;
        disconnectsByReason['unknown_with_context'] =
          (disconnectsByReason['unknown_with_context'] ?? 0) + 1;
      } else {
        disconnectsByReason[reason] = (disconnectsByReason[reason] ?? 0) + 1;
      }
      const transport = d.transport ?? 'null';
      disconnectsByTransport[transport] = (disconnectsByTransport[transport] ?? 0) + 1;
    }

    // Evidence collection — pick the first happy + first sad path.
    if (!oneSuccessfulSessionId && wake?.time_to_first_audio_ms != null && !wake.fallback_used) {
      oneSuccessfulSessionId = row.session_id;
    }
    if (!oneFailedSessionId && (wake?.fallback_used || (wake && wake.time_to_first_audio_ms == null && events.length > 0))) {
      oneFailedSessionId = row.session_id;
      // Name the FIRST missing stage so the report has a concrete pointer.
      const order: Array<keyof MilestoneReachCounts> = [
        'wake_clicked',
        'session_start_received',
        'continuation_decision_finished',
        'upstream_live_connected',
        'first_audio_output',
      ];
      for (const stage of order) {
        if (!reached[stage]) {
          oneFailedMissingStage = stage;
          break;
        }
      }
    }
  }

  const unknown_pct = disconnectsTotal === 0
    ? 0
    : Math.round((disconnectsUnknown / disconnectsTotal) * 1000) / 10;

  return {
    total_sessions,
    sessions_with_events,
    sessions_with_first_audio,
    sessions_with_fallback,
    latency: {
      time_to_first_audio_ms: bucket(ttfa),
      stages: {
        wake_to_gateway_ms: bucket(wake_to_gateway),
        gateway_to_decision_ms: bucket(gateway_to_decision),
        decision_to_upstream_ms: bucket(decision_to_upstream),
        upstream_to_first_audio_ms: bucket(upstream_to_first_audio),
      },
    },
    milestone_reach,
    disconnects: {
      total: disconnectsTotal,
      by_reason: disconnectsByReason,
      unknown: disconnectsUnknown,
      unknown_pct,
      by_transport: disconnectsByTransport,
    },
    continuation: {
      by_kind: continuationByKind,
      none_with_reason_breakdown: noneWithReasonBreakdown,
    },
    evidence: {
      one_successful_session_id: oneSuccessfulSessionId,
      one_failed_session_id: oneFailedSessionId,
      one_failed_missing_stage: oneFailedMissingStage,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bucket(values: number[]): LatencyBucket {
  if (values.length === 0) {
    return { p50: null, p90: null, p99: null, count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    count: values.length,
  };
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(p * sortedValues.length) - 1),
  );
  return sortedValues[idx];
}
