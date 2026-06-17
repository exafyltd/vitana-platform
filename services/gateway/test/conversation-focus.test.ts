/**
 * Journey Conversation V2 — single proactive arbiter tests (spec §7, §18).
 *
 * Covers: priority ordering (overdue > compass > diary > upcoming > rec >
 * profile > journey > community > inspiration), the one-candidate
 * guarantee, scoped-pause skip vs blanket-pause suppression, consent-gated
 * tool contracts, and the maturity gate on profile nudges.
 */

const isPausedMock = jest.fn();
const canSurfaceMock = jest.fn();
const recordTouchMock = jest.fn(async () => {});

jest.mock('../src/services/guide/pause-check', () => ({
  isPaused: (...args: unknown[]) => isPausedMock(...args),
}));
jest.mock('../src/services/guide/presence-pacer', () => ({
  canSurfaceProactively: (...args: unknown[]) => canSurfaceMock(...args),
  recordTouch: (...args: unknown[]) => recordTouchMock(...args),
}));

// Chainable, thenable Supabase table mock.
let tableRows: Record<string, any[]> = {};
function tableMock(rows: any[]) {
  const res = { data: rows, error: null, count: rows.length };
  const b: any = {};
  for (const m of ['select', 'eq', 'gt', 'lt', 'gte', 'in', 'order']) {
    b[m] = jest.fn(() => b);
  }
  b.limit = jest.fn(() => Promise.resolve(res));
  b.maybeSingle = jest.fn(() => Promise.resolve({ data: rows[0] ?? null, error: null }));
  b.then = (onF: any, onR: any) => Promise.resolve(res).then(onF, onR);
  return b;
}
jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => ({
    from: (table: string) => tableMock(tableRows[table] ?? []),
  }),
}));

import { pickConversationFocus } from '../src/services/guide/conversation-focus';
import type { UserAwareness, JourneyV2Awareness } from '../src/services/guide/types';

function makeJourneyV2(overrides: Partial<JourneyV2Awareness> = {}): JourneyV2Awareness {
  return {
    extended_tenure_stage: 'day14',
    experience_level: 'learning',
    vitana_index_maturity: 'emerging',
    journey_progress: {
      mode: 'guided',
      onboarding_status: 'in_progress',
      current_session: 3,
      completed_topic_count: 5,
      last_opened_topic_id: 't-005',
      next_recommended_topic_id: 't-006',
      next_recommended_session: 3,
    },
    profile_completion_status: {
      first_name: true,
      last_name: true,
      birthday: false,
      profile_picture: false,
      gender: true,
      location: true,
      completion_percent: 67,
    },
    completed_priority_tasks: {
      life_compass_defined: true,
      profile_completed: false,
      diary_started: true,
      autopilot_used: false,
    },
    diary_entry_today: true,
    proactive_pause_state: { paused_all: false, paused_categories: [], paused_nudge_keys: [] },
    recent_greeting_openings: [],
    autopilot_activations_lifetime: 0,
    ...overrides,
  };
}

function makeAwareness(overrides: Partial<UserAwareness> = {}): UserAwareness {
  const base: UserAwareness = {
    tenure: {
      stage: 'day14',
      days_since_signup: 14,
      active_usage_days: 10,
      registered_at: new Date().toISOString(),
    },
    journey: { current_wave: null, day_in_journey: 14, is_past_90_day: false },
    goal: { primary_goal: 'Transform Health', category: 'health', is_system_seeded: false },
    community_signals: {
      diary_streak_days: 3,
      connection_count: 2,
      group_count: 1,
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
    journey_v2: makeJourneyV2(),
  };
  return { ...base, ...overrides };
}

const baseInput = (awareness: UserAwareness) => ({
  user_id: 'user-1',
  awareness,
  channel: 'voice' as const,
});

beforeEach(() => {
  jest.clearAllMocks();
  tableRows = {};
  isPausedMock.mockResolvedValue({ paused: false });
  canSurfaceMock.mockResolvedValue({ allow: true });
});

describe('pickConversationFocus — priority order', () => {
  it('overdue autopilot event outranks everything (incl. missing Life Compass)', async () => {
    tableRows['calendar_events'] = [
      { id: 'ev-1', title: 'Morning walk', start_time: '2026-06-12T06:00:00Z', duration_minutes: 20 },
    ];
    const awareness = makeAwareness({
      goal: null, // missing compass would otherwise win
      recent_activity: {
        open_autopilot_recs: 2,
        activated_recs_last_7d: 0,
        dismissed_recs_last_7d: 0,
        overdue_calendar_count: 1,
        upcoming_calendar_24h_count: 1,
      },
    });
    const sel = await pickConversationFocus(baseInput(awareness));
    expect(sel.focus?.kind).toBe('overdue_autopilot_event');
    expect(sel.focus?.nudge_key).toBe('overdue_event:ev-1');
  });

  it('missing user-defined Life Compass outranks diary/recs (system-seeded counts as missing)', async () => {
    const awareness = makeAwareness({
      goal: { primary_goal: 'Improve quality of life', category: 'longevity', is_system_seeded: true },
      journey_v2: makeJourneyV2({ diary_entry_today: false }),
    });
    const sel = await pickConversationFocus(baseInput(awareness));
    expect(sel.focus?.kind).toBe('missing_life_compass');
  });

  it('daily diary (no entry today) outranks upcoming events and recommendations', async () => {
    tableRows['calendar_events'] = [
      { id: 'ev-2', title: 'Stretching', start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 10 },
    ];
    const awareness = makeAwareness({
      journey_v2: makeJourneyV2({ diary_entry_today: false }),
      recent_activity: {
        open_autopilot_recs: 1,
        activated_recs_last_7d: 0,
        dismissed_recs_last_7d: 0,
        overdue_calendar_count: 0,
        upcoming_calendar_24h_count: 1,
      },
    });
    const sel = await pickConversationFocus(baseInput(awareness));
    expect(sel.focus?.kind).toBe('daily_diary');
    expect(sel.focus?.on_yes_tool).toBe('save_diary_entry');
  });

  it('open recommendation wins over profile/journey when diary is done', async () => {
    tableRows['autopilot_recommendations'] = [
      { id: 'rec-1', title: 'Hydration habit', summary: 'Drink a glass of water after waking', priority: 80 },
    ];
    const awareness = makeAwareness({
      recent_activity: {
        open_autopilot_recs: 1,
        activated_recs_last_7d: 0,
        dismissed_recs_last_7d: 0,
        overdue_calendar_count: 0,
        upcoming_calendar_24h_count: 0,
      },
    });
    const sel = await pickConversationFocus(baseInput(awareness));
    expect(sel.focus?.kind).toBe('autopilot_recommendation');
    expect(sel.focus?.on_yes_tool).toBe('activate_recommendation');
    expect(sel.focus?.on_yes_payload_hint).toContain('rec-1');
  });

  it('profile completion fires before journey topic when profile incomplete', async () => {
    const sel = await pickConversationFocus(baseInput(makeAwareness()));
    expect(sel.focus?.kind).toBe('profile_completion');
    expect(sel.focus?.title).toContain('67%');
    expect(sel.focus?.title).toContain('birthday');
  });

  it('journey topic is the focus when profile is complete', async () => {
    const awareness = makeAwareness({
      journey_v2: makeJourneyV2({
        profile_completion_status: {
          first_name: true,
          last_name: true,
          birthday: true,
          profile_picture: true,
          gender: true,
          location: true,
          completion_percent: 100,
        },
      }),
    });
    const sel = await pickConversationFocus(baseInput(awareness));
    expect(sel.focus?.kind).toBe('journey_next_topic');
    expect(sel.focus?.nudge_key).toContain('t-006');
    expect(sel.focus?.reason).toContain('GUIDED JOURNEY mode');
  });

  it('full-app mode journey focus instructs gentle reconnection', async () => {
    const awareness = makeAwareness({
      journey_v2: makeJourneyV2({
        profile_completion_status: {
          first_name: true,
          last_name: true,
          birthday: true,
          profile_picture: true,
          gender: true,
          location: true,
          completion_percent: 100,
        },
        journey_progress: {
          mode: 'full',
          onboarding_status: 'qualified',
          current_session: 12,
          completed_topic_count: 30,
          last_opened_topic_id: 't-030',
          next_recommended_topic_id: 't-031',
          next_recommended_session: 12,
        },
      }),
    });
    const sel = await pickConversationFocus(baseInput(awareness));
    expect(sel.focus?.kind).toBe('journey_next_topic');
    expect(sel.focus?.reason).toContain('FULL APP mode');
    expect(sel.focus?.reason).toContain('do not interrupt');
  });

  it('mature users are never nagged about profile fields', async () => {
    const awareness = makeAwareness({
      journey_v2: makeJourneyV2({
        experience_level: 'mature',
        journey_progress: null, // no journey topic either
      }),
    });
    const sel = await pickConversationFocus(baseInput(awareness));
    expect(sel.focus?.kind).not.toBe('profile_completion');
  });

  it('falls through to inspiration when nothing else applies (pacer-gated)', async () => {
    const awareness = makeAwareness({
      journey_v2: makeJourneyV2({
        profile_completion_status: {
          first_name: true,
          last_name: true,
          birthday: true,
          profile_picture: true,
          gender: true,
          location: true,
          completion_percent: 100,
        },
        journey_progress: null,
      }),
    });
    const sel = await pickConversationFocus(baseInput(awareness));
    expect(sel.focus?.kind).toBe('inspiration');
    expect(canSurfaceMock).toHaveBeenCalledWith('user-1', 'vitana_responsibility_message');
    expect(recordTouchMock).toHaveBeenCalled();
  });

  it('inspiration respects the once-per-day pacer cap', async () => {
    canSurfaceMock.mockResolvedValue({ allow: false, reason: 'surface_already_touched_today' });
    const awareness = makeAwareness({
      journey_v2: makeJourneyV2({
        profile_completion_status: {
          first_name: true,
          last_name: true,
          birthday: true,
          profile_picture: true,
          gender: true,
          location: true,
          completion_percent: 100,
        },
        journey_progress: null,
      }),
    });
    const sel = await pickConversationFocus(baseInput(awareness));
    expect(sel.focus).toBeNull();
    expect(sel.suppressed_by_pause).toBe(false);
  });
});

describe('pickConversationFocus — pause semantics', () => {
  it('a blanket (all-scope) pause suppresses every proactive focus', async () => {
    isPausedMock.mockResolvedValue({
      paused: true,
      pause: { scope: 'all', paused_until: new Date(Date.now() + 3600_000).toISOString() },
    });
    const sel = await pickConversationFocus(baseInput(makeAwareness()));
    expect(sel.focus).toBeNull();
    expect(sel.suppressed_by_pause).toBe(true);
  });

  it('a nudge_key-scoped pause skips to the next candidate', async () => {
    // First candidate (profile_completion) paused; next (journey topic) not.
    isPausedMock
      .mockResolvedValueOnce({
        paused: true,
        pause: { scope: 'nudge_key', paused_until: new Date(Date.now() + 3600_000).toISOString() },
      })
      .mockResolvedValue({ paused: false });
    const sel = await pickConversationFocus(baseInput(makeAwareness()));
    expect(sel.focus?.kind).toBe('journey_next_topic');
    expect(sel.suppressed_by_pause).toBe(false);
  });

  it('returns exactly one focus', async () => {
    tableRows['calendar_events'] = [
      { id: 'ev-9', title: 'Walk', start_time: '2026-06-12T06:00:00Z', duration_minutes: 20 },
    ];
    tableRows['autopilot_recommendations'] = [
      { id: 'rec-9', title: 'Sleep wind-down', summary: 's', priority: 50 },
    ];
    const awareness = makeAwareness({
      goal: null,
      recent_activity: {
        open_autopilot_recs: 3,
        activated_recs_last_7d: 0,
        dismissed_recs_last_7d: 0,
        overdue_calendar_count: 2,
        upcoming_calendar_24h_count: 2,
      },
      journey_v2: makeJourneyV2({ diary_entry_today: false }),
    });
    const sel = await pickConversationFocus(baseInput(awareness));
    // One focus object, not an array — the single-suggestion invariant.
    expect(sel.focus).toBeTruthy();
    expect(Array.isArray(sel.focus)).toBe(false);
    expect(sel.focus?.kind).toBe('overdue_autopilot_event');
  });
});
