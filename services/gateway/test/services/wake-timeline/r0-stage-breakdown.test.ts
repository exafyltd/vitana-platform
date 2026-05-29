/**
 * VTID-02927 (R0) — stage-breakdown extension to aggregateTimeline.
 *
 * The 4 stage deltas the operator uses to answer "where does the
 * wake latency live?":
 *   - wake_to_gateway_ms
 *   - gateway_to_decision_ms
 *   - decision_to_upstream_ms
 *   - upstream_to_first_audio_ms
 *
 * Each is non-negative ms when both endpoints fired, null otherwise.
 */

import { aggregateTimeline } from '../../../src/services/wake-timeline/aggregate-timeline';
import type { WakeTimelineEvent } from '../../../src/services/wake-timeline/timeline-events';

const BASE_AT = '2026-05-11T18:00:00.000Z';
const BASE_MS = Date.parse(BASE_AT);

function ev(
  name: WakeTimelineEvent['name'],
  tSessionMs: number,
  metadata?: Record<string, unknown>,
): WakeTimelineEvent {
  const at = new Date(BASE_MS + tSessionMs).toISOString();
  return { name, at, tSessionMs, ...(metadata ? { metadata } : {}) };
}

describe('R0 — aggregateTimeline.stage_breakdown', () => {
  it('returns all-null breakdown when the events array is empty', () => {
    const out = aggregateTimeline({ events: [], startedAt: BASE_AT, transport: null });
    expect(out.wake).toBeNull();
  });

  it('computes all 4 stage deltas on a fully-instrumented happy path', () => {
    const out = aggregateTimeline({
      events: [
        ev('wake_clicked', 0),
        ev('session_start_received', 100),
        ev('continuation_decision_finished', 150),
        ev('upstream_live_connected', 800),
        ev('first_audio_output', 1200),
      ],
      startedAt: BASE_AT,
      transport: 'sse',
    });
    const s = out.wake?.stage_breakdown;
    expect(s).toEqual({
      wake_to_gateway_ms: 100,
      gateway_to_decision_ms: 50,
      decision_to_upstream_ms: 650,
      upstream_to_first_audio_ms: 400,
    });
  });

  it('returns null for wake_to_gateway_ms when wake_clicked is missing', () => {
    const out = aggregateTimeline({
      events: [
        ev('session_start_received', 0),
        ev('continuation_decision_finished', 100),
      ],
      startedAt: BASE_AT,
      transport: 'sse',
    });
    expect(out.wake?.stage_breakdown.wake_to_gateway_ms).toBeNull();
  });

  it('returns null for gateway_to_decision_ms when session_start is missing', () => {
    const out = aggregateTimeline({
      events: [
        ev('wake_clicked', 0),
        ev('continuation_decision_finished', 100),
      ],
      startedAt: BASE_AT,
      transport: 'sse',
    });
    expect(out.wake?.stage_breakdown.gateway_to_decision_ms).toBeNull();
  });

  it('returns null for decision_to_upstream_ms when decision_finished is missing', () => {
    const out = aggregateTimeline({
      events: [
        ev('wake_clicked', 0),
        ev('session_start_received', 50),
        ev('upstream_live_connected', 500),
      ],
      startedAt: BASE_AT,
      transport: 'sse',
    });
    expect(out.wake?.stage_breakdown.decision_to_upstream_ms).toBeNull();
  });

  it('returns null for upstream_to_first_audio_ms when first_audio never fired', () => {
    const out = aggregateTimeline({
      events: [
        ev('wake_clicked', 0),
        ev('session_start_received', 50),
        ev('continuation_decision_finished', 100),
        ev('upstream_live_connected', 800),
      ],
      startedAt: BASE_AT,
      transport: 'sse',
    });
    expect(out.wake?.stage_breakdown.upstream_to_first_audio_ms).toBeNull();
  });

  it('clamps to zero when events arrive out of order (defensive)', () => {
    // Reversed timestamps (shouldn't happen in practice, but the
    // aggregator must not produce negative deltas).
    const out = aggregateTimeline({
      events: [
        ev('wake_clicked', 200),
        ev('session_start_received', 100),
      ],
      startedAt: BASE_AT,
      transport: 'sse',
    });
    expect(out.wake?.stage_breakdown.wake_to_gateway_ms).toBe(0);
  });
});
