/**
 * VTID-02917 (B0d.3) — timeline event-name constants tests.
 *
 * The 16 event names are LOCKED. This test prevents accidental renames
 * or additions in future commits: if you change the list, this test
 * fails until you also update the assertion below, which forces a
 * conscious decision.
 */

import {
  WAKE_TIMELINE_EVENT_NAMES,
  WAKE_TIMELINE_EVENT_NAMES_SET,
  isWakeTimelineEventName,
} from '../../../src/services/wake-timeline/timeline-events';

describe('B0d.3 — wake timeline event constants are locked', () => {
  it('contains exactly the 16 locked event names in the documented order', () => {
    expect(WAKE_TIMELINE_EVENT_NAMES).toEqual([
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
    ]);
    expect(WAKE_TIMELINE_EVENT_NAMES.length).toBe(16);
    expect(WAKE_TIMELINE_EVENT_NAMES_SET.size).toBe(16);
  });

  it('isWakeTimelineEventName accepts every locked name', () => {
    for (const name of WAKE_TIMELINE_EVENT_NAMES) {
      expect(isWakeTimelineEventName(name)).toBe(true);
    }
  });

  it('isWakeTimelineEventName rejects unknown names', () => {
    expect(isWakeTimelineEventName('made_up_event')).toBe(false);
    expect(isWakeTimelineEventName('')).toBe(false);
    expect(isWakeTimelineEventName(null)).toBe(false);
    expect(isWakeTimelineEventName(undefined)).toBe(false);
    expect(isWakeTimelineEventName(42)).toBe(false);
  });
});
