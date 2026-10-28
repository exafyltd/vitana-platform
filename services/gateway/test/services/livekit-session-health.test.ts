import {
  summariseLiveKitSessionHealth,
  type OrbSessionStateRow,
} from '../../src/services/orb/livekit-session-health';

// BOOTSTRAP-LIVEKIT-CONTROL — pure session-health summary over a snapshot of
// orb_session_state 'continuity' rows. No live DB; deterministic clock.

const NOW = Date.parse('2026-06-02T12:00:00Z');

function row(over: Partial<OrbSessionStateRow> & { user_id: string }): OrbSessionStateRow {
  return {
    user_id: over.user_id,
    key: over.key ?? 'continuity',
    value: over.value ?? { conversation_id: `c-${over.user_id}`, last_turn_at: new Date(NOW).toISOString() },
    expires_at: over.expires_at ?? new Date(NOW + 10 * 60_000).toISOString(),
    updated_at: over.updated_at ?? new Date(NOW).toISOString(),
  };
}

describe('summariseLiveKitSessionHealth', () => {
  it('returns all-zero summary for an empty snapshot', () => {
    const s = summariseLiveKitSessionHealth([], { nowMs: NOW });
    expect(s.total_rows).toBe(0);
    expect(s.active_sessions).toBe(0);
    expect(s.expired_sessions).toBe(0);
    expect(s.stuck_sessions).toBe(0);
    expect(s.stuck_session_details).toEqual([]);
    expect(s.computed_at).toBe(new Date(NOW).toISOString());
  });

  it('counts active vs expired by expires_at', () => {
    const rows = [
      row({ user_id: 'active1', expires_at: new Date(NOW + 60_000).toISOString() }),
      row({ user_id: 'expired1', expires_at: new Date(NOW - 1_000).toISOString() }),
      // exactly at NOW counts as expired (<= now)
      row({ user_id: 'edge', expires_at: new Date(NOW).toISOString() }),
    ];
    const s = summariseLiveKitSessionHealth(rows, { nowMs: NOW });
    expect(s.total_rows).toBe(3);
    expect(s.active_sessions).toBe(1);
    expect(s.expired_sessions).toBe(2);
  });

  it('flags an active-but-idle session as stuck', () => {
    const rows = [
      // fresh: last turn now → active, not stuck
      row({ user_id: 'fresh', value: { last_turn_at: new Date(NOW).toISOString() } }),
      // idle 20 min but still within TTL → stuck
      row({
        user_id: 'wedged',
        value: { conversation_id: 'cw', last_turn_at: new Date(NOW - 20 * 60_000).toISOString() },
        expires_at: new Date(NOW + 5 * 60_000).toISOString(),
        updated_at: new Date(NOW - 20 * 60_000).toISOString(),
      }),
    ];
    const s = summariseLiveKitSessionHealth(rows, { nowMs: NOW }); // default 10-min threshold
    expect(s.active_sessions).toBe(2);
    expect(s.stuck_sessions).toBe(1);
    expect(s.stuck_session_details[0].user_id).toBe('wedged');
    expect(s.stuck_session_details[0].conversation_id).toBe('cw');
    expect(s.stuck_session_details[0].idle_ms).toBe(20 * 60_000);
    expect(s.stuck_session_details[0].expires_in_ms).toBe(5 * 60_000);
  });

  it('does not flag an expired session as stuck', () => {
    const rows = [
      row({
        user_id: 'gone',
        value: { last_turn_at: new Date(NOW - 60 * 60_000).toISOString() },
        expires_at: new Date(NOW - 1_000).toISOString(),
      }),
    ];
    const s = summariseLiveKitSessionHealth(rows, { nowMs: NOW });
    expect(s.expired_sessions).toBe(1);
    expect(s.stuck_sessions).toBe(0);
  });

  it('treats an active row with no activity timestamps as stuck (idle unknown)', () => {
    const rows = [
      {
        user_id: 'unknown-activity',
        key: 'continuity',
        value: { conversation_id: 'cu' },
        expires_at: new Date(NOW + 60_000).toISOString(),
        updated_at: 'not-a-date',
      } as OrbSessionStateRow,
    ];
    const s = summariseLiveKitSessionHealth(rows, { nowMs: NOW });
    expect(s.active_sessions).toBe(1);
    expect(s.stuck_sessions).toBe(1);
    expect(s.stuck_session_details[0].last_activity_at).toBeNull();
    expect(s.stuck_session_details[0].idle_ms).toBe(-1);
  });

  it('honours a custom staleAfterMs threshold', () => {
    const rows = [
      row({
        user_id: 'idle3min',
        value: { last_turn_at: new Date(NOW - 3 * 60_000).toISOString() },
        updated_at: new Date(NOW - 3 * 60_000).toISOString(),
      }),
    ];
    // 5-min threshold → not stuck
    expect(summariseLiveKitSessionHealth(rows, { nowMs: NOW, staleAfterMs: 5 * 60_000 }).stuck_sessions).toBe(0);
    // 2-min threshold → stuck
    expect(summariseLiveKitSessionHealth(rows, { nowMs: NOW, staleAfterMs: 2 * 60_000 }).stuck_sessions).toBe(1);
  });

  it('sorts stuck details worst-idle first and caps at maxDetails', () => {
    const rows = [
      row({ user_id: 'idle12', value: { last_turn_at: new Date(NOW - 12 * 60_000).toISOString() }, updated_at: new Date(NOW - 12 * 60_000).toISOString() }),
      row({ user_id: 'idle30', value: { last_turn_at: new Date(NOW - 30 * 60_000).toISOString() }, updated_at: new Date(NOW - 30 * 60_000).toISOString() }),
      row({ user_id: 'idle15', value: { last_turn_at: new Date(NOW - 15 * 60_000).toISOString() }, updated_at: new Date(NOW - 15 * 60_000).toISOString() }),
    ];
    const s = summariseLiveKitSessionHealth(rows, { nowMs: NOW, maxDetails: 2 });
    expect(s.stuck_sessions).toBe(3);
    expect(s.stuck_session_details).toHaveLength(2);
    expect(s.stuck_session_details.map((d) => d.user_id)).toEqual(['idle30', 'idle15']);
  });

  it('falls back to last_greeting_at when last_turn_at is absent', () => {
    const rows = [
      row({
        user_id: 'greeted-only',
        value: { conversation_id: 'cg', last_turn_at: null, last_greeting_at: new Date(NOW - 1 * 60_000).toISOString() },
        updated_at: new Date(NOW - 1 * 60_000).toISOString(),
      }),
    ];
    // 1 min idle, default 10-min threshold → not stuck
    expect(summariseLiveKitSessionHealth(rows, { nowMs: NOW }).stuck_sessions).toBe(0);
  });
});
