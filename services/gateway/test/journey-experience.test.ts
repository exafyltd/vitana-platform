/**
 * Journey Conversation V2 — maturity model unit tests (spec §4, §18).
 *
 * Covers the five required scenarios:
 *   1. first-time user
 *   2. active day-30 user
 *   3. low-data day-90 user
 *   4. six-month mature user
 *   5. six-month low-data returning user
 * plus the single-signal over-promotion guard (clarification B) and the
 * calendar-stage / index-maturity mappings.
 */

import {
  deriveExtendedTenureStage,
  deriveJourneyExperienceLevel,
  deriveVitanaIndexMaturity,
  computeEngagementScore,
  EXPERIENCE_STYLE_GUIDANCE,
  type ExperienceSignals,
} from '../src/services/guide/journey-experience';

function signals(overrides: Partial<ExperienceSignals> = {}): ExperienceSignals {
  return {
    days_since_signup: 0,
    active_usage_days: 0,
    completed_journey_topics: 0,
    completed_journey_sessions: 0,
    diary_streak_days: 0,
    autopilot_activations: 0,
    connection_count: 0,
    group_count: 0,
    completed_priority_tasks: 0,
    vitana_index_maturity: 'none',
    ...overrides,
  };
}

describe('deriveExtendedTenureStage', () => {
  it('maps calendar days to stages', () => {
    expect(deriveExtendedTenureStage(0)).toBe('day0');
    expect(deriveExtendedTenureStage(1)).toBe('day1');
    expect(deriveExtendedTenureStage(2)).toBe('day1');
    expect(deriveExtendedTenureStage(3)).toBe('day3');
    expect(deriveExtendedTenureStage(7)).toBe('day7');
    expect(deriveExtendedTenureStage(14)).toBe('day14');
    expect(deriveExtendedTenureStage(30)).toBe('day30plus');
    expect(deriveExtendedTenureStage(60)).toBe('day60plus');
    expect(deriveExtendedTenureStage(90)).toBe('day90plus');
    expect(deriveExtendedTenureStage(180)).toBe('day180plus');
    expect(deriveExtendedTenureStage(365)).toBe('day180plus');
  });

  it('clamps negative input to day0', () => {
    expect(deriveExtendedTenureStage(-5)).toBe('day0');
  });
});

describe('deriveVitanaIndexMaturity', () => {
  it('returns none without an index snapshot', () => {
    expect(
      deriveVitanaIndexMaturity({
        has_index_snapshot: false,
        active_usage_days: 100,
        diary_streak_days: 100,
      }),
    ).toBe('none');
  });

  it('grades richness from active days + double-weighted diary streak', () => {
    const m = (active: number, streak: number) =>
      deriveVitanaIndexMaturity({
        has_index_snapshot: true,
        active_usage_days: active,
        diary_streak_days: streak,
      });
    expect(m(2, 1)).toBe('baseline'); // 4
    expect(m(5, 4)).toBe('emerging'); // 13
    expect(m(20, 5)).toBe('stable'); // 30
    expect(m(30, 10)).toBe('rich'); // 50
  });
});

describe('deriveJourneyExperienceLevel — required scenarios', () => {
  it('scenario 1: first-time user (day 0, no data) → first_time', () => {
    expect(deriveJourneyExperienceLevel(signals())).toBe('first_time');
  });

  it('scenario 2: active day-30 user → active (calendar cap holds advanced back)', () => {
    const s = signals({
      days_since_signup: 30,
      active_usage_days: 25,
      completed_journey_topics: 10,
      completed_journey_sessions: 8,
      diary_streak_days: 10,
      autopilot_activations: 2,
      connection_count: 3,
      group_count: 1,
      completed_priority_tasks: 4,
      vitana_index_maturity: 'emerging',
    });
    // Engagement score lands in the 'advanced' band, but advanced requires
    // ≥ 90 calendar days — the calendar cap demotes to 'active'.
    expect(computeEngagementScore(s)).toBeGreaterThanOrEqual(150);
    expect(deriveJourneyExperienceLevel(s)).toBe('active');
  });

  it('scenario 3: low-data day-90 user → returning_low_data, never beginner', () => {
    const s = signals({ days_since_signup: 90, active_usage_days: 2 });
    expect(deriveJourneyExperienceLevel(s)).toBe('returning_low_data');
  });

  it('scenario 4: six-month engaged user → mature', () => {
    const s = signals({
      days_since_signup: 200,
      active_usage_days: 120,
      completed_journey_topics: 40,
      completed_journey_sessions: 30,
      diary_streak_days: 30,
      autopilot_activations: 10,
      connection_count: 10,
      group_count: 4,
      completed_priority_tasks: 4,
      vitana_index_maturity: 'rich',
    });
    expect(deriveJourneyExperienceLevel(s)).toBe('mature');
  });

  it('scenario 5: six-month user with EMPTY v2 fields → returning_low_data (backfill floor)', () => {
    // This is the exact backfill case: an existing user whose journey
    // fields are all zero must NOT be classified as a first-time user.
    const s = signals({ days_since_signup: 180 });
    const level = deriveJourneyExperienceLevel(s);
    expect(level).toBe('returning_low_data');
    expect(level).not.toBe('first_time');
  });
});

describe('deriveJourneyExperienceLevel — guards', () => {
  it('single strong signal cannot over-promote (clarification B)', () => {
    // A 30-day diary streak alone (with the diary priority task) must not
    // produce an advanced/mature classification.
    const s = signals({
      days_since_signup: 30,
      diary_streak_days: 30,
      completed_priority_tasks: 1,
    });
    const level = deriveJourneyExperienceLevel(s);
    expect(['learning', 'building']).toContain(level);
  });

  it('first_time is strictly the first 3 calendar days', () => {
    expect(deriveJourneyExperienceLevel(signals({ days_since_signup: 3 }))).toBe('orientation');
    expect(deriveJourneyExperienceLevel(signals({ days_since_signup: 10 }))).toBe('orientation');
  });

  it('mature requires 180 calendar days no matter the score', () => {
    const s = signals({
      days_since_signup: 100,
      active_usage_days: 90,
      completed_journey_topics: 40,
      completed_journey_sessions: 30,
      diary_streak_days: 30,
      autopilot_activations: 10,
      connection_count: 10,
      group_count: 4,
      completed_priority_tasks: 4,
      vitana_index_maturity: 'rich',
    });
    expect(deriveJourneyExperienceLevel(s)).toBe('advanced');
  });

  it('every level has style guidance and returning_low_data avoids beginner wording', () => {
    for (const guidance of Object.values(EXPERIENCE_STYLE_GUIDANCE)) {
      expect(guidance.length).toBeGreaterThan(20);
    }
    expect(EXPERIENCE_STYLE_GUIDANCE.returning_low_data).toMatch(/NOT use beginner wording/i);
  });
});
