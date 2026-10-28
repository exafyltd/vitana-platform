/**
 * VTID-02927 (R0) — reliability cohort analysis tests.
 *
 * Pure function. Builds synthetic WakeTimelineRow cohorts that cover:
 *   - Empty cohort.
 *   - Happy-path cohort (every session reached first_audio_output).
 *   - Mixed cohort (some happy, some failed) — drop-off counts correct.
 *   - Cohort with unknown disconnects — unknown_pct correct.
 *   - Continuation outcome distribution.
 *   - Evidence pointers identify a happy + a failed session.
 *   - Latency percentiles (p50/p90/p99) deterministic on fixed inputs.
 */

import { analyzeReliabilityCohort } from '../../../src/services/wake-timeline/reliability-cohort-analysis';
import type {
  WakeTimelineRow,
  WakeTimelineEvent,
} from '../../../src/services/wake-timeline/timeline-events';

function ev(
  name: WakeTimelineEvent['name'],
  tSessionMs: number,
  metadata?: Record<string, unknown>,
): WakeTimelineEvent {
  return {
    name,
    at: new Date(1_700_000_000_000 + tSessionMs).toISOString(),
    tSessionMs,
    ...(metadata ? { metadata } : {}),
  };
}

function happySession(
  id: string,
  ttfa: number,
  stages: {
    wake_to_gateway: number;
    gateway_to_decision: number;
    decision_to_upstream: number;
    upstream_to_first_audio: number;
  },
  selectedKind: string = 'wake_brief',
): WakeTimelineRow {
  return {
    session_id: id,
    tenant_id: 't',
    user_id: 'u',
    surface: 'orb_wake',
    transport: 'sse',
    events: [
      ev('wake_clicked', 0),
      ev('session_start_received', stages.wake_to_gateway),
      ev('continuation_decision_finished', stages.wake_to_gateway + stages.gateway_to_decision),
      ev('upstream_live_connected',
        stages.wake_to_gateway + stages.gateway_to_decision + stages.decision_to_upstream),
      ev('first_audio_output', ttfa),
    ],
    aggregates: {
      wake: {
        time_to_first_audio_ms: ttfa,
        stage_breakdown: {
          wake_to_gateway_ms: stages.wake_to_gateway,
          gateway_to_decision_ms: stages.gateway_to_decision,
          decision_to_upstream_ms: stages.decision_to_upstream,
          upstream_to_first_audio_ms: stages.upstream_to_first_audio,
        },
        selected_continuation_kind: selectedKind as any,
        fallback_used: false,
      },
      disconnects: [],
    },
    started_at: '2026-05-11T18:00:00.000Z',
    ended_at: null,
    updated_at: '2026-05-11T18:01:00.000Z',
  };
}

function failedSession(
  id: string,
  disconnectReason: string | null = 'upstream_failed',
): WakeTimelineRow {
  return {
    session_id: id,
    tenant_id: 't',
    user_id: 'u',
    surface: 'orb_wake',
    transport: 'sse',
    events: [
      ev('wake_clicked', 0),
      ev('session_start_received', 100),
      ev('disconnect', 500, disconnectReason ? { disconnect_reason: disconnectReason } : {}),
    ],
    aggregates: {
      wake: {
        time_to_first_audio_ms: null,
        stage_breakdown: {
          wake_to_gateway_ms: 100,
          gateway_to_decision_ms: null,
          decision_to_upstream_ms: null,
          upstream_to_first_audio_ms: null,
        },
        selected_continuation_kind: null,
        fallback_used: true,
      },
      disconnects: [
        {
          disconnect_reason: disconnectReason,
          ...(disconnectReason === null ? { unknown_with_context: { metadata_keys: [] } } : {}),
          session_age_ms: 500,
          transport: 'sse',
          upstream_state: null,
          at: '2026-05-11T18:00:00.500Z',
        },
      ],
    },
    started_at: '2026-05-11T18:00:00.000Z',
    ended_at: '2026-05-11T18:00:00.500Z',
    updated_at: '2026-05-11T18:00:00.500Z',
  };
}

describe('R0 — analyzeReliabilityCohort', () => {
  it('returns zero counts on an empty cohort', () => {
    const out = analyzeReliabilityCohort([]);
    expect(out.total_sessions).toBe(0);
    expect(out.sessions_with_events).toBe(0);
    expect(out.sessions_with_first_audio).toBe(0);
    expect(out.disconnects.total).toBe(0);
    expect(out.disconnects.unknown_pct).toBe(0);
    expect(out.evidence.one_successful_session_id).toBeNull();
    expect(out.evidence.one_failed_session_id).toBeNull();
  });

  it('counts happy-path sessions correctly', () => {
    const out = analyzeReliabilityCohort([
      happySession('s1', 1000, {
        wake_to_gateway: 100, gateway_to_decision: 50,
        decision_to_upstream: 500, upstream_to_first_audio: 350,
      }),
      happySession('s2', 1200, {
        wake_to_gateway: 100, gateway_to_decision: 50,
        decision_to_upstream: 600, upstream_to_first_audio: 450,
      }),
    ]);
    expect(out.total_sessions).toBe(2);
    expect(out.sessions_with_first_audio).toBe(2);
    expect(out.sessions_with_fallback).toBe(0);
    expect(out.milestone_reach.first_audio_output).toBe(2);
    expect(out.milestone_reach.disconnect).toBe(0);
  });

  it('counts mixed cohort drop-off correctly', () => {
    const out = analyzeReliabilityCohort([
      happySession('s1', 1000, { wake_to_gateway: 100, gateway_to_decision: 50, decision_to_upstream: 500, upstream_to_first_audio: 350 }),
      failedSession('s2', 'upstream_failed'),
      failedSession('s3', null),
    ]);
    expect(out.total_sessions).toBe(3);
    expect(out.sessions_with_first_audio).toBe(1);
    expect(out.sessions_with_fallback).toBe(2);
    expect(out.milestone_reach.first_audio_output).toBe(1);
    expect(out.milestone_reach.disconnect).toBe(2);
  });

  it('computes unknown_pct correctly when some disconnects lack a reason', () => {
    const out = analyzeReliabilityCohort([
      failedSession('s1', 'upstream_failed'),
      failedSession('s2', null), // unknown
      failedSession('s3', null), // unknown
      failedSession('s4', 'closed_by_client'),
    ]);
    expect(out.disconnects.total).toBe(4);
    expect(out.disconnects.unknown).toBe(2);
    expect(out.disconnects.unknown_pct).toBe(50);
    expect(out.disconnects.by_reason).toEqual({
      upstream_failed: 1,
      closed_by_client: 1,
      unknown_with_context: 2,
    });
  });

  it('tallies continuation outcomes by kind', () => {
    const out = analyzeReliabilityCohort([
      happySession('s1', 1000, { wake_to_gateway: 100, gateway_to_decision: 50, decision_to_upstream: 500, upstream_to_first_audio: 350 }, 'wake_brief'),
      happySession('s2', 1000, { wake_to_gateway: 100, gateway_to_decision: 50, decision_to_upstream: 500, upstream_to_first_audio: 350 }, 'wake_brief'),
      happySession('s3', 1000, { wake_to_gateway: 100, gateway_to_decision: 50, decision_to_upstream: 500, upstream_to_first_audio: 350 }, 'feature_discovery'),
    ]);
    expect(out.continuation.by_kind).toEqual({
      wake_brief: 2,
      feature_discovery: 1,
    });
  });

  it('captures none_with_reason_breakdown when wake aggregate carries it', () => {
    const row: WakeTimelineRow = {
      session_id: 's-nwr',
      tenant_id: 't',
      user_id: 'u',
      surface: 'orb_wake',
      transport: 'sse',
      events: [],
      aggregates: {
        wake: {
          time_to_first_audio_ms: 800,
          stage_breakdown: {
            wake_to_gateway_ms: null,
            gateway_to_decision_ms: null,
            decision_to_upstream_ms: null,
            upstream_to_first_audio_ms: null,
          },
          selected_continuation_kind: 'none_with_reason' as any,
          none_with_reason: 'voice_pause_active',
          fallback_used: false,
        },
        disconnects: [],
      },
      started_at: '2026-05-11T18:00:00.000Z',
      ended_at: null,
      updated_at: '2026-05-11T18:01:00.000Z',
    };
    const out = analyzeReliabilityCohort([row]);
    expect(out.continuation.none_with_reason_breakdown).toEqual({
      voice_pause_active: 1,
    });
  });

  it('picks one happy + one failed session id for evidence', () => {
    const out = analyzeReliabilityCohort([
      failedSession('s1'),
      happySession('s2', 1000, { wake_to_gateway: 100, gateway_to_decision: 50, decision_to_upstream: 500, upstream_to_first_audio: 350 }),
      happySession('s3', 1100, { wake_to_gateway: 100, gateway_to_decision: 50, decision_to_upstream: 600, upstream_to_first_audio: 350 }),
    ]);
    // First happy + first failed are picked deterministically.
    expect(out.evidence.one_successful_session_id).toBe('s2');
    expect(out.evidence.one_failed_session_id).toBe('s1');
  });

  it('names the first missing stage on a failed session', () => {
    const out = analyzeReliabilityCohort([failedSession('s1')]);
    // Failed session has wake_clicked + session_start_received +
    // disconnect — the first MISSING milestone is
    // continuation_decision_finished.
    expect(out.evidence.one_failed_missing_stage).toBe('continuation_decision_finished');
  });

  it('computes p50/p90/p99 deterministically on fixed inputs', () => {
    const rows: WakeTimelineRow[] = [];
    for (let i = 1; i <= 100; i++) {
      rows.push(
        happySession(`s${i}`, i, {
          wake_to_gateway: i,
          gateway_to_decision: 0,
          decision_to_upstream: 0,
          upstream_to_first_audio: 0,
        }),
      );
    }
    const out = analyzeReliabilityCohort(rows);
    const ttfa = out.latency.time_to_first_audio_ms;
    expect(ttfa.count).toBe(100);
    // ceil(0.5 * 100) - 1 = 49 → index 49 → value 50
    expect(ttfa.p50).toBe(50);
    // ceil(0.9 * 100) - 1 = 89 → index 89 → value 90
    expect(ttfa.p90).toBe(90);
    // ceil(0.99 * 100) - 1 = 98 → index 98 → value 99
    expect(ttfa.p99).toBe(99);
  });
});
