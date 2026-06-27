/**
 * Conversation Flow — register decision + Next-Best-Action ranking.
 *
 * Locks the two behaviours the user explicitly demanded:
 *  1. Recency decides the register FIRST — a return after a minute is NEVER a
 *     "good morning" briefing; the briefing owns only the first session of a day.
 *  2. Every opening has a guided next step (NBA), ranked by value × timeliness,
 *     and always grounded in real data.
 */

import { decideOpeningRegister } from '../../../src/services/conversation/decide-opening';
import { rankNextBestActions, selectNextBestAction } from '../../../src/services/conversation/next-best-action';
import type { OverviewPayload } from '../../../src/services/assistant-continuation/providers/new-day-overview-payload';

function emptyPayload(over: Partial<OverviewPayload> = {}): OverviewPayload {
  return {
    journey: null,
    vitana_index: {
      state: 'ok', today: 200, tier: 'Early', tier_framing: null, trend_7d: 0,
      weakest_pillar: { name: 'nutrition', score: 30 }, strongest_pillar: null,
      balance_label: 'balanced', pillars: null, projected_day_90: null, projected_day_90_tier: null,
    },
    life_compass: {
      state: 'set', primary_goal: 'longer life', category: null, target_date: null,
      target_value: null, target_unit: null, starting_value: null, set_at: null,
      days_to_deadline: null, goal_progress_pct: null,
    },
    calendar_today: { count: 0, next: null },
    calendar_passed: { count: 0, most_recent: null },
    autopilot: { state: 'none_yet', today_checkpoint: null, this_week: [], pending_total: 0 },
    matches_unread: 0,
    messages_unread: 0,
    reminders_today: { count: 0, next: null },
    diary_last_7d: 3,
    guided_journey: null,
    last_session_date_user_tz: null,
    ...over,
  };
}

describe('decideOpeningRegister — recency-first', () => {
  it('first-timer → first_time regardless of recency', () => {
    expect(decideOpeningRegister({ bucket: 'reconnect', isFirstTime: true, briefingDue: true })).toBe('first_time');
  });
  it('briefing due (first session of a real day) → daily_briefing, any gap', () => {
    expect(decideOpeningRegister({ bucket: 'long', isFirstTime: false, briefingDue: true })).toBe('daily_briefing');
    expect(decideOpeningRegister({ bucket: 'yesterday', isFirstTime: false, briefingDue: true })).toBe('daily_briefing');
  });
  it('same-day reopen after the briefing → recency register, NEVER a re-briefing', () => {
    expect(decideOpeningRegister({ bucket: 'reconnect', isFirstTime: false, briefingDue: false })).toBe('continue');
    expect(decideOpeningRegister({ bucket: 'recent', isFirstTime: false, briefingDue: false })).toBe('quick_resume');
    expect(decideOpeningRegister({ bucket: 'same_day', isFirstTime: false, briefingDue: false })).toBe('same_day');
    expect(decideOpeningRegister({ bucket: 'today', isFirstTime: false, briefingDue: false })).toBe('same_day');
  });
});

describe('rankNextBestActions — value × timeliness, always grounded', () => {
  it('time-sensitive (reminder/autopilot/messages) outrank continuity and community', () => {
    const p = emptyPayload({
      reminders_today: { count: 1, next: { action_text: 'take vitamin D', next_fire_at: 'x' } },
      messages_unread: 5,
      guided_journey: { sessions_completed: 8, topics_learned: 18, topics_total: 90, next_session_title: 'Vitana Index', last_session_recall: 'Vitana Index' },
      matches_unread: 15,
    });
    const ranked = rankNextBestActions(p, { rotationSeed: 0 });
    expect(ranked[0].key).toBe('reminder_due');
    // continuity (next_session) ranks above community growth (matches)
    const sessionIdx = ranked.findIndex((a) => a.key === 'next_session');
    const matchesIdx = ranked.findIndex((a) => a.key === 'review_matches');
    expect(sessionIdx).toBeLessThan(matchesIdx);
  });

  it('never invents: a payload with no signals still offers a community-growth nudge, nothing fabricated', () => {
    const p = emptyPayload();
    const nba = selectNextBestAction(p, { rotationSeed: 1 });
    expect(nba).not.toBeNull();
    expect(['make_post', 'create_activity', 'connect_community', 'focus_pillar']).toContain(nba!.key);
  });

  it('diary gap surfaces a health-momentum entry suggestion', () => {
    const p = emptyPayload({ diary_last_7d: 0 });
    const keys = rankNextBestActions(p).map((a) => a.key);
    expect(keys).toContain('diary_entry');
  });
});
