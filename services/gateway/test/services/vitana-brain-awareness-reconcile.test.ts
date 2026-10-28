/**
 * VTID-03262 (Fix-4) — buildAwarenessBlock journey reconciliation.
 *
 * One day-counter, one "where am I". Pre-graduation the Journey Foundation
 * onboarding checklist is the user's current "where am I" and the 90-day wave
 * plan is explicitly demoted to background (so Vitana never narrates two
 * competing journey stories). Post-graduation the 90-day wave arc leads.
 * Without a Foundation signal the legacy wave line is preserved (back-compat).
 */

import { buildAwarenessBlock } from '../../src/services/vitana-brain';
import type { FoundationAwarenessSignal } from '../../src/services/vitana-brain';
import type { UserAwareness } from '../../src/services/guide/types';

function makeAwareness(overrides: Partial<UserAwareness> = {}): UserAwareness {
  return {
    tenure: { stage: 'day1', days_since_signup: 3, active_usage_days: 2, registered_at: '2026-05-30T10:00:00Z' },
    journey: { current_wave: { id: 'w1', name: 'Momentum', description: 'build the habit' }, day_in_journey: 3, is_past_90_day: false },
    goal: null,
    community_signals: { diary_streak_days: 0, connection_count: 0, group_count: 0, pending_match_count: 0, memory_goals: [], memory_interests: [] },
    recent_activity: { open_autopilot_recs: 0, activated_recs_last_7d: 0, dismissed_recs_last_7d: 0, overdue_calendar_count: 0, upcoming_calendar_24h_count: 0 },
    last_interaction: null,
    feature_introductions: [],
    prior_session_themes: [],
    user_timezone: 'Europe/Berlin',
    sessions_today: null,
    last_session_yesterday: null,
    ...overrides,
  } as unknown as UserAwareness;
}

const onFoundation: FoundationAwarenessSignal = {
  on_foundation: true,
  graduated: false,
  next_step_title: 'Set your Life Compass',
};

describe('VTID-03262 — journey-model reconciliation in buildAwarenessBlock', () => {
  it('pre-graduation: Foundation is the "where am I"; the 90-day wave is demoted (not narrated as current focus)', () => {
    const out = buildAwarenessBlock(makeAwareness(), onFoundation);
    expect(out).toMatch(/JOURNEY FOUNDATION onboarding checklist \(not yet graduated\)/);
    expect(out).toContain('Set your Life Compass');
    // The competing "day N of 90 / wave" current-focus narrative must be gone.
    expect(out).not.toMatch(/day 3 of 90, currently in wave/);
    expect(out).not.toContain('Momentum — build the habit');
  });

  it('exactly one day-counter is surfaced (day_in_journey), no second number', () => {
    const out = buildAwarenessBlock(makeAwareness({ journey: { current_wave: null, day_in_journey: 12, is_past_90_day: false } }), onFoundation);
    const dayMentions = (out.match(/\bday 12\b/gi) || []).length;
    expect(dayMentions).toBe(1);
  });

  it('post-graduation: the 90-day wave arc leads again', () => {
    const out = buildAwarenessBlock(makeAwareness(), { on_foundation: true, graduated: true, next_step_title: null });
    expect(out).toMatch(/day 3 of 90, currently in wave "Momentum"/);
    expect(out).not.toMatch(/JOURNEY FOUNDATION onboarding checklist/);
  });

  it('no Foundation signal: legacy wave line preserved (back-compat)', () => {
    const out = buildAwarenessBlock(makeAwareness());
    expect(out).toMatch(/day 3 of 90, currently in wave "Momentum"/);
    expect(out).not.toMatch(/JOURNEY FOUNDATION onboarding checklist/);
  });

  it('on_foundation=false (e.g. no foundation row): legacy wave line preserved', () => {
    const out = buildAwarenessBlock(makeAwareness(), { on_foundation: false, graduated: false, next_step_title: null });
    expect(out).toMatch(/day 3 of 90, currently in wave/);
  });
});
