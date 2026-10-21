/**
 * Journey Conversation V2 — speech intent tests (spec §8–10, §18).
 *
 * Verifies: same-day return sessions get the short greeting (never a second
 * deep inspiration), anti-repetition memory is wired in, the language rule
 * is present on every rendered intent, and intents carry NO hard-coded
 * user-facing motivational paragraphs.
 */

import {
  buildGreetingSpeechIntent,
  buildResponsibilitySpeechIntent,
  renderSpeechIntentBlock,
} from '../src/services/guide/speech-intent';
import type { UserAwareness } from '../src/services/guide/types';

function makeAwareness(overrides: Partial<UserAwareness> = {}): UserAwareness {
  const base: UserAwareness = {
    tenure: {
      stage: 'day7',
      days_since_signup: 7,
      active_usage_days: 5,
      registered_at: new Date().toISOString(),
    },
    journey: { current_wave: null, day_in_journey: 7, is_past_90_day: false },
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
  };
  return { ...base, ...overrides };
}

describe('buildGreetingSpeechIntent', () => {
  it('first session of the day → daily_inspiration with required elements', () => {
    const intent = buildGreetingSpeechIntent(makeAwareness());
    expect(intent.type).toBe('daily_inspiration');
    expect(intent.must_include).toEqual(
      expect.arrayContaining(['personal_name', 'health_journey', 'support']),
    );
    expect(intent.max_per_day).toBe(1);
  });

  it('same-day return session → short_return_greeting, never inspiration', () => {
    const awareness = makeAwareness({
      sessions_today: {
        count: 2,
        entries: [
          {
            session_id: 's1',
            channel: 'voice',
            summary: 'morning chat',
            themes: ['diary'],
            ended_at: new Date().toISOString(),
          },
        ],
      },
    });
    const intent = buildGreetingSpeechIntent(awareness);
    expect(intent.type).toBe('short_return_greeting');
    expect(intent.forbidden_patterns.join(' ')).toMatch(/full daily inspiration/);
  });

  it('threads recent greeting openings into anti-repetition memory', () => {
    const awareness = makeAwareness();
    awareness.journey_v2 = {
      extended_tenure_stage: 'day7',
      experience_level: 'orientation',
      vitana_index_maturity: 'baseline',
      journey_progress: null,
      profile_completion_status: {
        first_name: true,
        last_name: false,
        birthday: false,
        profile_picture: false,
        gender: false,
        location: false,
        completion_percent: 17,
      },
      completed_priority_tasks: {
        life_compass_defined: false,
        profile_completed: false,
        diary_started: false,
        autopilot_used: false,
      },
      diary_entry_today: false,
      proactive_pause_state: { paused_all: false, paused_categories: [], paused_nudge_keys: [] },
      recent_greeting_openings: ['Guten Morgen, Anna — ein neuer Tag auf deinem Weg.'],
      autopilot_activations_lifetime: 0,
    };
    const intent = buildGreetingSpeechIntent(awareness);
    expect(intent.avoid_repeating).toContain(
      'Guten Morgen, Anna — ein neuer Tag auf deinem Weg.',
    );
  });
});

describe('renderSpeechIntentBlock', () => {
  it('always contains the language rule (no English leakage)', () => {
    const block = renderSpeechIntentBlock(buildGreetingSpeechIntent(makeAwareness()));
    expect(block).toMatch(/LANGUAGE: generate it in the user's language/);
    expect(block).toMatch(/NEVER fall back to English/);
  });

  it('contains no sanctioned user-facing wording', () => {
    const block = renderSpeechIntentBlock(buildGreetingSpeechIntent(makeAwareness()));
    expect(block).toMatch(/NO sanctioned wording to copy/);
    // Intent blocks describe constraints, not greetings to recite.
    expect(block).not.toMatch(/Good morning, \{Name\}/);
  });

  it('renders anti-repetition openings and the once-per-day rule', () => {
    const intent = buildGreetingSpeechIntent(makeAwareness());
    intent.avoid_repeating = ['Hallo Max, schön dich zu hören!'];
    const block = renderSpeechIntentBlock(intent);
    expect(block).toContain('Hallo Max, schön dich zu hören!');
    expect(block).toMatch(/once-per-day message/);
  });
});

describe('buildResponsibilitySpeechIntent', () => {
  it('caps at once per day and forbids reciting the full list', () => {
    const intent = buildResponsibilitySpeechIntent(makeAwareness());
    expect(intent.type).toBe('responsibility_reflection');
    expect(intent.max_per_day).toBe(1);
    expect(intent.forbidden_patterns.join(' ')).toMatch(/every responsibility/);
    expect(intent.may_include.length).toBeGreaterThanOrEqual(5);
  });
});
