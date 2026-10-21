// Proactive Guide — Awareness Prompt Formatter (VTID-01950) — unit tests
//
// Pure formatting logic: no DB, no network. `formatLocalHHMM` from
// ./user-timezone is real (deterministic given ISO + tz), so no module
// mocking is needed here.
//
// Scope:
//   1. Null/empty-input handling.
//   2. Header + compact-mode toggling.
//   3. Each conditional line block (tenure, last_interaction, journey, goal,
//      community, recent_activity, prior_session_themes) — present when
//      populated, absent when empty/zero.
//   4. renderSessionsTrackingBlock — today/yesterday rendering, entry
//      slicing (last 4), ordinal formatting, summary truncation, and the
//      trailing tz/recall-tool instruction lines.

import { formatAwarenessForPrompt } from '../../../src/services/guide/awareness-prompt';
import type { UserAwareness } from '../../../src/services/guide/types';

function baseAwareness(overrides: Partial<UserAwareness> = {}): UserAwareness {
  return {
    tenure: { stage: 'day7', days_since_signup: 5, active_usage_days: 3, registered_at: '2026-07-01T00:00:00Z' },
    journey: { current_wave: null, day_in_journey: 5, is_past_90_day: false },
    goal: null,
    community_signals: {
      diary_streak_days: 0,
      connection_count: 0,
      group_count: 0,
      pending_match_count: 0,
      memory_goals: [],
      memory_interests: [],
    },
    recent_activity: {
      open_autopilot_recs: 0,
      activated_recs_last_7d: 0,
      dismissed_recs_last_7d: 0,
      overdue_calendar_count: 0,
      upcoming_calendar_24h_count: 0,
    },
    last_interaction: null,
    feature_introductions: [],
    prior_session_themes: [],
    adaptation_plans: null,
    routines: [],
    tastes_preferences: null,
    sessions_today: { count: 0, entries: [] },
    last_session_yesterday: null,
    user_timezone: 'Europe/Berlin',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Null / empty input
// ---------------------------------------------------------------------------

describe('formatAwarenessForPrompt — null input', () => {
  it('returns an empty string for null awareness', () => {
    expect(formatAwarenessForPrompt(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. Header + compact toggle
// ---------------------------------------------------------------------------

describe('formatAwarenessForPrompt — header / compact mode', () => {
  it('non-compact output starts with the section header', () => {
    const out = formatAwarenessForPrompt(baseAwareness());
    expect(out.split('\n')[0]).toBe('=== USER AWARENESS (right now) ===');
  });

  it('compact output omits the section header', () => {
    const out = formatAwarenessForPrompt(baseAwareness(), { compact: true });
    expect(out).not.toContain('=== USER AWARENESS');
  });

  it('non-compact output ends with the "use naturally" guidance lines', () => {
    const out = formatAwarenessForPrompt(baseAwareness());
    expect(out).toContain('Use this awareness naturally. Reference it when relevant — never recite.');
    expect(out).toContain('If the user mentions something (interest, concern, goal), acknowledge it.');
  });

  it('compact output omits the "use naturally" guidance lines', () => {
    const out = formatAwarenessForPrompt(baseAwareness(), { compact: true });
    expect(out).not.toContain('Use this awareness naturally');
  });
});

// ---------------------------------------------------------------------------
// 3. Tenure + last_interaction
// ---------------------------------------------------------------------------

describe('formatAwarenessForPrompt — tenure', () => {
  it('renders the tenure stage + day count exactly', () => {
    const out = formatAwarenessForPrompt(baseAwareness({ tenure: { stage: 'day14', days_since_signup: 12, active_usage_days: 8, registered_at: 'x' } }));
    expect(out).toContain('Tenure: day14 (day 12)');
  });
});

describe('formatAwarenessForPrompt — last_interaction', () => {
  it('renders the "never spoken before" line for the first bucket', () => {
    const out = formatAwarenessForPrompt(
      baseAwareness({
        last_interaction: { bucket: 'first', time_ago: 'never before', last_session_at: null, diff_ms: Infinity, was_failure: false, motivation_signal: 'fresh', days_since_last: Infinity },
      }),
    );
    expect(out).toContain('Last interaction: NEVER spoken before.');
  });

  it('renders time_ago/bucket/days/motivation for a non-first bucket', () => {
    const out = formatAwarenessForPrompt(
      baseAwareness({
        last_interaction: { bucket: 'yesterday', time_ago: 'yesterday', last_session_at: 'x', diff_ms: 90000000, was_failure: false, motivation_signal: 'engaged', days_since_last: 1 },
      }),
    );
    expect(out).toContain('Last interaction: yesterday (yesterday, 1d, motivation=engaged)');
  });

  it('omits the Last interaction line entirely when null', () => {
    const out = formatAwarenessForPrompt(baseAwareness({ last_interaction: null }));
    expect(out).not.toContain('Last interaction');
  });
});

// ---------------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------------

describe('formatAwarenessForPrompt — journey', () => {
  it('renders the past-90-day line when is_past_90_day is true', () => {
    const out = formatAwarenessForPrompt(baseAwareness({ journey: { current_wave: null, day_in_journey: 120, is_past_90_day: true } }));
    expect(out).toContain('Journey: past 90-day plan (day 120).');
  });

  it('renders the wave line when a current_wave is present', () => {
    const out = formatAwarenessForPrompt(
      baseAwareness({ journey: { current_wave: { id: 'wave-1', name: 'Getting Started', description: 'x' }, day_in_journey: 3, is_past_90_day: false } }),
    );
    expect(out).toContain('Journey: day 3/90, wave "Getting Started"');
  });

  it('renders no Journey line at all when neither past-90 nor a current wave is set', () => {
    const out = formatAwarenessForPrompt(baseAwareness({ journey: { current_wave: null, day_in_journey: 45, is_past_90_day: false } }));
    expect(out).not.toContain('Journey:');
  });
});

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

describe('formatAwarenessForPrompt — goal', () => {
  it('renders the goal line with the system-seeded suffix when seeded', () => {
    const out = formatAwarenessForPrompt(baseAwareness({ goal: { primary_goal: 'Improve quality of life', category: 'longevity', is_system_seeded: true } }));
    expect(out).toContain('Life Compass goal: "Improve quality of life" (longevity, system-seeded)');
  });

  it('renders the goal line without the suffix when not seeded', () => {
    const out = formatAwarenessForPrompt(baseAwareness({ goal: { primary_goal: 'Run a marathon', category: 'fitness', is_system_seeded: false } }));
    expect(out).toContain('Life Compass goal: "Run a marathon" (fitness)');
    expect(out).not.toContain('system-seeded');
  });

  it('omits the goal line entirely when null', () => {
    const out = formatAwarenessForPrompt(baseAwareness({ goal: null }));
    expect(out).not.toContain('Life Compass goal');
  });
});

// ---------------------------------------------------------------------------
// Community signals
// ---------------------------------------------------------------------------

describe('formatAwarenessForPrompt — community signals', () => {
  it('joins only the non-zero/non-empty parts', () => {
    const out = formatAwarenessForPrompt(
      baseAwareness({
        community_signals: {
          diary_streak_days: 4,
          connection_count: 0,
          group_count: 2,
          pending_match_count: 0,
          memory_goals: ['lose weight', 'sleep better', 'run more', 'meditate'],
          memory_interests: [],
        },
      }),
    );
    expect(out).toContain('Community: diary streak 4d; 2 groups; goals: lose weight, sleep better, run more');
    expect(out).not.toContain('connections');
  });

  it('omits the Community line entirely when every signal is zero/empty', () => {
    const out = formatAwarenessForPrompt(baseAwareness());
    expect(out).not.toContain('Community:');
  });
});

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

describe('formatAwarenessForPrompt — recent activity', () => {
  it('joins only the non-zero parts', () => {
    const out = formatAwarenessForPrompt(
      baseAwareness({ recent_activity: { open_autopilot_recs: 3, activated_recs_last_7d: 0, dismissed_recs_last_7d: 0, overdue_calendar_count: 0, upcoming_calendar_24h_count: 2 } }),
    );
    expect(out).toContain('Recent activity: 3 open recs; 2 upcoming 24h');
  });

  it('omits the Recent activity line when every count is zero', () => {
    const out = formatAwarenessForPrompt(baseAwareness());
    expect(out).not.toContain('Recent activity:');
  });
});

// ---------------------------------------------------------------------------
// Prior session themes
// ---------------------------------------------------------------------------

describe('formatAwarenessForPrompt — prior session themes', () => {
  it('renders only the most recent entry, capped to 3 themes, date-sliced', () => {
    const out = formatAwarenessForPrompt(
      baseAwareness({
        prior_session_themes: [
          { session_id: 's1', summary: 'x', themes: ['sleep', 'diary', 'goals', 'extra'], ended_at: '2026-07-20T10:00:00.000Z' },
          { session_id: 's0', summary: 'older', themes: ['old-theme'], ended_at: '2026-07-19T10:00:00.000Z' },
        ],
      }),
    );
    expect(out).toContain('Last conversation (2026-07-20): sleep, diary, goals');
    expect(out).not.toContain('extra');
    expect(out).not.toContain('old-theme');
  });

  it('omits the line when the most recent entry has no themes', () => {
    const out = formatAwarenessForPrompt(baseAwareness({ prior_session_themes: [{ session_id: 's1', summary: 'x', themes: [], ended_at: '2026-07-20T10:00:00.000Z' }] }));
    expect(out).not.toContain('Last conversation');
  });

  it('omits the line entirely when the array is empty', () => {
    const out = formatAwarenessForPrompt(baseAwareness({ prior_session_themes: [] }));
    expect(out).not.toContain('Last conversation');
  });
});

// ---------------------------------------------------------------------------
// Sessions tracking block
// ---------------------------------------------------------------------------

describe('formatAwarenessForPrompt — sessions tracking block', () => {
  it('renders nothing when there are no sessions today and no yesterday session', () => {
    const out = formatAwarenessForPrompt(baseAwareness());
    expect(out).not.toContain('Sessions today');
    expect(out).not.toContain('local to the user');
  });

  it('renders "Sessions today: N prior (this is the Nth)" using ordinal(count+1)', () => {
    const out = formatAwarenessForPrompt(
      baseAwareness({
        user_timezone: 'Etc/UTC',
        sessions_today: {
          count: 1,
          entries: [{ session_id: 's1', channel: 'voice', summary: 'talked about sleep', themes: ['sleep'], ended_at: '2026-07-20T09:14:00.000Z' }],
        },
      }),
    );
    expect(out).toContain('Sessions today: 1 prior (this is the 2nd).');
    expect(out).toMatch(/09:14 \(voice\) themes: sleep — talked about sleep/);
  });

  it('renders only the last 4 today-entries (chronological slice)', () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      session_id: `s${i}`,
      channel: 'text' as const,
      summary: `summary-${i}`,
      themes: [],
      ended_at: `2026-07-20T0${i}:00:00.000Z`,
    }));
    const out = formatAwarenessForPrompt(baseAwareness({ sessions_today: { count: 6, entries } }));

    expect(out).not.toContain('summary-0');
    expect(out).not.toContain('summary-1');
    expect(out).toContain('summary-2');
    expect(out).toContain('summary-5');
  });

  it('renders ordinal suffixes correctly (2nd, 11th, 21st)', () => {
    const mk = (count: number) =>
      formatAwarenessForPrompt(baseAwareness({ sessions_today: { count, entries: [{ session_id: 's', channel: 'text', summary: 's', themes: [], ended_at: '2026-07-20T00:00:00.000Z' }] } }));

    expect(mk(1)).toContain('this is the 2nd');
    expect(mk(10)).toContain('this is the 11th');
    expect(mk(20)).toContain('this is the 21st');
  });

  it('renders the yesterday last-session line with hh:mm + themes + summary', () => {
    const out = formatAwarenessForPrompt(
      baseAwareness({
        user_timezone: 'Etc/UTC',
        last_session_yesterday: { session_id: 'y1', channel: 'voice', summary: 'discussed the wave transition', themes: ['journey'], ended_at: '2026-07-19T18:30:00.000Z' },
      }),
    );
    expect(out).toMatch(/Yesterday's last session 18:30 themes: journey — discussed the wave transition/);
  });

  it('appends the tz + recall-tool instruction lines whenever the block renders', () => {
    const out = formatAwarenessForPrompt(
      baseAwareness({ last_session_yesterday: { session_id: 'y1', channel: 'text', summary: 's', themes: [], ended_at: '2026-07-19T18:30:00.000Z' } }),
    );
    expect(out).toContain('(All session times are local to the user — Europe/Berlin. Always quote times in this timezone, never UTC.)');
    expect(out).toContain('call recall_conversation_at_time to fetch the actual turns');
  });

  it('truncates a long summary to 240 chars with an ellipsis, trimming trailing whitespace first', () => {
    const longSummary = 'a'.repeat(238) + '   more text after padding';
    const out = formatAwarenessForPrompt(
      baseAwareness({ last_session_yesterday: { session_id: 'y1', channel: 'text', summary: longSummary, themes: [], ended_at: '2026-07-19T18:30:00.000Z' } }),
    );
    expect(out).toContain('a'.repeat(238) + '…');
    expect(out).not.toContain('more text after padding');
  });

  it('does not truncate a summary at or under the 240-char limit', () => {
    const exact = 'b'.repeat(240);
    const out = formatAwarenessForPrompt(
      baseAwareness({ last_session_yesterday: { session_id: 'y1', channel: 'text', summary: exact, themes: [], ended_at: '2026-07-19T18:30:00.000Z' } }),
    );
    expect(out).toContain(exact);
    expect(out).not.toContain(exact + '…');
  });
});
