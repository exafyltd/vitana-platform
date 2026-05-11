/**
 * VTID-02917 (B0d.3) — aggregateTimeline pure-function tests.
 *
 * Covers:
 *   - Per-wake aggregate (time_to_first_audio_ms,
 *     selected_continuation_kind, none_with_reason, fallback_used).
 *   - Per-disconnect aggregate (disconnect_reason / unknown_with_context,
 *     session_age_ms, transport, upstream_state).
 *   - Defensive: out-of-order events, missing events, multiple disconnects.
 *   - "Silent unknowns are forbidden" — a disconnect without a reason
 *     gets unknown_with_context filled in by the aggregator.
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
  return {
    name,
    at,
    tSessionMs,
    ...(metadata ? { metadata } : {}),
  };
}

describe('B0d.3 — aggregateTimeline (pure)', () => {
  describe('wake aggregate', () => {
    it('returns null when there are no events', () => {
      const out = aggregateTimeline({ events: [], startedAt: BASE_AT, transport: null });
      expect(out.wake).toBeNull();
      expect(out.disconnects).toEqual([]);
    });

    it('computes time_to_first_audio_ms from wake_clicked to first_audio_output', () => {
      const out = aggregateTimeline({
        events: [
          ev('wake_clicked', 0),
          ev('session_start_received', 50),
          ev('first_audio_output', 350),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.wake?.time_to_first_audio_ms).toBe(350);
      expect(out.wake?.fallback_used).toBe(false);
    });

    it('falls back to session_start_received when wake_clicked is missing', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('first_audio_output', 200),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.wake?.time_to_first_audio_ms).toBe(200);
    });

    it('reports time_to_first_audio_ms as null when first_audio_output never fires', () => {
      const out = aggregateTimeline({
        events: [ev('session_start_received', 0)],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.wake?.time_to_first_audio_ms).toBeNull();
    });

    it('captures selected_continuation_kind from wake_brief_selected metadata', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('wake_brief_selected', 100, { selected_continuation_kind: 'wake_brief' }),
          ev('first_audio_output', 300),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.wake?.selected_continuation_kind).toBe('wake_brief');
      expect(out.wake?.none_with_reason).toBeUndefined();
    });

    it('captures none_with_reason when the wake produced no continuation', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('wake_brief_selected', 50, {
            selected_continuation_kind: 'none_with_reason',
            none_with_reason: 'all_providers_suppressed',
          }),
          ev('first_audio_output', 200),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.wake?.selected_continuation_kind).toBe('none_with_reason');
      expect(out.wake?.none_with_reason).toBe('all_providers_suppressed');
    });

    it('marks fallback_used when manual_restart_required fires', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('manual_restart_required', 100),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.wake?.fallback_used).toBe(true);
    });

    it('marks fallback_used when reconnect_attempt fires without reconnect_success', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('reconnect_attempt', 100),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.wake?.fallback_used).toBe(true);
    });

    it('does NOT mark fallback when reconnect_attempt is followed by reconnect_success', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('reconnect_attempt', 100),
          ev('reconnect_success', 150),
          ev('first_audio_output', 200),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.wake?.fallback_used).toBe(false);
    });

    it('marks fallback when disconnect fires before any first_audio_output', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('disconnect', 80, { disconnect_reason: 'upstream_failed' }),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.wake?.fallback_used).toBe(true);
    });

    it('handles out-of-order events by sorting on tSessionMs', () => {
      const out = aggregateTimeline({
        events: [
          ev('first_audio_output', 300),
          ev('wake_clicked', 0),
          ev('session_start_received', 50),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.wake?.time_to_first_audio_ms).toBe(300);
    });
  });

  describe('disconnect aggregate', () => {
    it('returns empty array when no disconnect event fired', () => {
      const out = aggregateTimeline({
        events: [ev('session_start_received', 0)],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.disconnects).toEqual([]);
    });

    it('reports disconnect_reason + session_age_ms + transport + upstream_state', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('disconnect', 5000, {
            disconnect_reason: 'upstream_idle_timeout',
            upstream_state: 'closed',
            transport: 'websocket',
          }),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.disconnects.length).toBe(1);
      const d = out.disconnects[0];
      expect(d.disconnect_reason).toBe('upstream_idle_timeout');
      expect(d.upstream_state).toBe('closed');
      expect(d.transport).toBe('websocket'); // event metadata wins over session transport
      expect(d.session_age_ms).toBe(5000);
      expect(d.unknown_with_context).toBeUndefined();
    });

    it('fills unknown_with_context when disconnect_reason is null', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('disconnect', 1000, { random_field: 'something' }),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      const d = out.disconnects[0];
      expect(d.disconnect_reason).toBeNull();
      expect(d.unknown_with_context).toBeDefined();
      expect(d.unknown_with_context).toMatchObject({
        metadata_keys: expect.arrayContaining(['random_field']),
      });
    });

    it('falls back to session transport when the disconnect event lacks one', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('disconnect', 100, { disconnect_reason: 'closed_by_client' }),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.disconnects[0].transport).toBe('sse');
    });

    it('records multiple disconnects in order', () => {
      const out = aggregateTimeline({
        events: [
          ev('session_start_received', 0),
          ev('disconnect', 1000, { disconnect_reason: 'first' }),
          ev('reconnect_attempt', 1100),
          ev('reconnect_success', 1200),
          ev('disconnect', 5000, { disconnect_reason: 'second' }),
        ],
        startedAt: BASE_AT,
        transport: 'sse',
      });
      expect(out.disconnects.length).toBe(2);
      expect(out.disconnects[0].disconnect_reason).toBe('first');
      expect(out.disconnects[1].disconnect_reason).toBe('second');
      expect(out.disconnects[1].session_age_ms).toBe(5000);
    });
  });
});
