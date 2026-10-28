/**
 * Journey Conversation V2 — composed prompt block tests (spec §15, §18).
 *
 * Verifies the block contains: exactly one ON-YES tool contract, the
 * maturity style guidance, the compact journey awareness, the speech
 * intent with the language rule, pause-suppression wording, and the
 * fail-open contract (empty string on arbiter failure).
 */

const pickFocusMock = jest.fn();
const telemetryMock = jest.fn(async () => {});

jest.mock('../src/services/guide/conversation-focus', () => ({
  pickConversationFocus: (...args: unknown[]) => pickFocusMock(...args),
}));
jest.mock('../src/services/guide/guide-telemetry', () => ({
  emitGuideTelemetry: (...args: unknown[]) => telemetryMock(...args),
}));

import { buildJourneyConversationV2Block } from '../src/services/guide/journey-conversation-v2';
import type { UserAwareness, JourneyV2Awareness } from '../src/services/guide/types';

function makeJourneyV2(overrides: Partial<JourneyV2Awareness> = {}): JourneyV2Awareness {
  return {
    extended_tenure_stage: 'day30plus',
    experience_level: 'building',
    vitana_index_maturity: 'stable',
    journey_progress: {
      mode: 'guided',
      onboarding_status: 'in_progress',
      current_session: 6,
      completed_topic_count: 11,
      last_opened_topic_id: 't-011',
      next_recommended_topic_id: 't-012',
      next_recommended_session: 6,
    },
    profile_completion_status: {
      first_name: true,
      last_name: true,
      birthday: true,
      profile_picture: true,
      gender: true,
      location: true,
      completion_percent: 100,
    },
    completed_priority_tasks: {
      life_compass_defined: true,
      profile_completed: true,
      diary_started: true,
      autopilot_used: true,
    },
    diary_entry_today: false,
    proactive_pause_state: { paused_all: false, paused_categories: [], paused_nudge_keys: [] },
    recent_greeting_openings: ['Hallo Anna, schön dich zu hören.'],
    autopilot_activations_lifetime: 3,
    ...overrides,
  };
}

function makeAwareness(overrides: Partial<UserAwareness> = {}): UserAwareness {
  const base: UserAwareness = {
    tenure: {
      stage: 'day30plus',
      days_since_signup: 35,
      active_usage_days: 20,
      registered_at: new Date().toISOString(),
    },
    journey: { current_wave: null, day_in_journey: 35, is_past_90_day: false },
    goal: { primary_goal: 'Transform Health', category: 'health', is_system_seeded: false },
    community_signals: {
      diary_streak_days: 5,
      connection_count: 3,
      group_count: 1,
      pending_match_count: 0,
      memory_goals: [],
      memory_interests: [],
    },
    recent_activity: {
      open_autopilot_recs: 1,
      activated_recs_last_7d: 1,
      dismissed_recs_last_7d: 0,
      overdue_calendar_count: 0,
      upcoming_calendar_24h_count: 0,
    },
    last_interaction: null,
    feature_introductions: ['life_compass', 'autopilot'],
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

const input = (awareness: UserAwareness) => ({
  user_id: 'user-1',
  awareness,
  channel: 'voice' as const,
});

beforeEach(() => {
  jest.clearAllMocks();
  pickFocusMock.mockResolvedValue({
    focus: {
      kind: 'daily_diary',
      nudge_key: 'diary_today:2026-06-12',
      title: 'No diary entry yet today',
      detail: 'rotate the angle',
      reason: 'daily lived data powers the Vitana Index',
      category: 'diary',
      on_yes_tool: 'save_diary_entry',
      on_yes_payload_hint: 'use dictated content as content',
    },
    suppressed_by_pause: false,
  });
});

describe('buildJourneyConversationV2Block', () => {
  it('contains exactly one ON-YES tool contract and the single-focus rule', async () => {
    const block = await buildJourneyConversationV2Block(input(makeAwareness()));
    expect((block.match(/ON USER CONSENT/g) ?? []).length).toBe(1);
    expect(block).toContain('save_diary_entry');
    expect(block).toMatch(/Exactly ONE proactive suggestion per turn/);
    expect(block).toMatch(/NEVER call this tool without the user's explicit consent/);
  });

  it('injects maturity style guidance and compact journey awareness', async () => {
    const block = await buildJourneyConversationV2Block(input(makeAwareness()));
    expect(block).toContain('Experience level: building');
    expect(block).toMatch(/coach mode/i);
    expect(block).toContain('GUIDED mode, session 6, 11 topics completed');
    expect(block).toContain('Vitana Index maturity: stable');
    // Compact: never the topic catalog, only the next topic id.
    expect(block).toContain('t-012');
  });

  it('returning_low_data users get re-entry guidance, not beginner wording', async () => {
    const awareness = makeAwareness({
      journey_v2: makeJourneyV2({ experience_level: 'returning_low_data' }),
    });
    const block = await buildJourneyConversationV2Block(input(awareness));
    expect(block).toContain('Experience level: returning_low_data');
    expect(block).toMatch(/Do NOT use beginner wording/);
  });

  it('always includes a speech intent with the language rule', async () => {
    const block = await buildJourneyConversationV2Block(input(makeAwareness()));
    expect(block).toContain('=== SPEECH INTENT: daily_inspiration ===');
    expect(block).toMatch(/NEVER fall back to English/);
    // Anti-repetition memory threaded through from user_journey
    expect(block).toContain('Hallo Anna, schön dich zu hören.');
  });

  it('same-day return session renders the short greeting intent', async () => {
    const awareness = makeAwareness({
      sessions_today: {
        count: 1,
        entries: [
          {
            session_id: 's1',
            channel: 'voice',
            summary: 'earlier',
            themes: [],
            ended_at: new Date().toISOString(),
          },
        ],
      },
    });
    const block = await buildJourneyConversationV2Block(input(awareness));
    expect(block).toContain('=== SPEECH INTENT: short_return_greeting ===');
    expect(block).not.toContain('=== SPEECH INTENT: daily_inspiration ===');
  });

  it('pause suppression renders the quiet contract and no focus', async () => {
    pickFocusMock.mockResolvedValue({
      focus: null,
      suppressed_by_pause: true,
      suppressing_pause: { scope: 'all', paused_until: '2099-01-01T00:00:00Z' },
    });
    const block = await buildJourneyConversationV2Block(input(makeAwareness()));
    expect(block).toContain('SUPPRESSED BY USER PAUSE');
    expect(block).toMatch(/Make NO unsolicited suggestion/);
    expect(block).not.toContain('ON USER CONSENT');
    expect(telemetryMock).toHaveBeenCalledWith(
      'guide.focus.suppressed',
      expect.objectContaining({ pause_scope: 'all' }),
    );
  });

  it('teaching focus carries the feature-introduction dedup rule', async () => {
    pickFocusMock.mockResolvedValue({
      focus: {
        kind: 'journey_next_topic',
        nudge_key: 'journey_topic:t-012:2026-06-12',
        title: 'Next My Journey topic',
        reason: 'teaching center',
        category: 'journey',
      },
      suppressed_by_pause: false,
    });
    const block = await buildJourneyConversationV2Block(input(makeAwareness()));
    expect(block).toMatch(/never repeat a beginner explanation/);
    expect(block).toContain('record_feature_introduction');
  });

  it('emits focus telemetry through the existing guide channel', async () => {
    await buildJourneyConversationV2Block(input(makeAwareness()));
    expect(telemetryMock).toHaveBeenCalledWith(
      'guide.focus.selected',
      expect.objectContaining({
        kind: 'daily_diary',
        experience_level: 'building',
        mode: 'guided',
      }),
    );
  });

  it('fails open: arbiter failure → empty string (legacy path fallback)', async () => {
    pickFocusMock.mockRejectedValue(new Error('boom'));
    const block = await buildJourneyConversationV2Block(input(makeAwareness()));
    expect(block).toBe('');
  });
});
