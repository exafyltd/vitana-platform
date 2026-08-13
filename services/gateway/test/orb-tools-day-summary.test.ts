/**
 * VTID-03604 surface 4 — tool_get_day_summary.
 *
 * Reuses gatherOverviewPayload() (already covered by its own call sites:
 * the new-day briefing and the day-close rung) rather than re-testing the
 * aggregator itself. This file pins the orchestration this tool adds on top:
 *   - requires an authenticated user
 *   - scopes the gather to TODAY (today's local midnight as the lookback
 *     cutoff, not the user's actual last-session time)
 *   - the result is a DATA DUMP the model narrates, never a scripted sentence
 *   - an empty day says so warmly rather than reading as an error
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

const gatherOverviewPayloadMock = jest.fn();
const dayWindowUtcIsoMock = jest.fn();
const todayInTimezoneMock = jest.fn();
const getUserTimezoneMock = jest.fn();

jest.mock('../src/services/assistant-continuation/providers/new-day-overview-payload', () => ({
  gatherOverviewPayload: (...args: any[]) => gatherOverviewPayloadMock(...args),
  dayWindowUtcIso: (...args: any[]) => dayWindowUtcIsoMock(...args),
}));

jest.mock('../src/services/assistant-continuation/providers/new-day-return', () => ({
  todayInTimezone: (...args: any[]) => todayInTimezoneMock(...args),
}));

jest.mock('../src/services/daily-pace-service', () => ({
  getUserTimezone: (...args: any[]) => getUserTimezoneMock(...args),
}));

import { tool_get_day_summary } from '../src/services/orb-tools-shared';

const USER_ID = 'aaaa1111-1111-4111-8111-111111111111';
const EMPTY_OVERVIEW = {
  journey: null,
  vitana_index: { state: 'not_set_up', today: null, tier: null, tier_framing: null, trend_7d: null, weakest_pillar: null, strongest_pillar: null, balance_label: null, pillars: null, projected_day_90: null, projected_day_90_tier: null },
  life_compass: { state: 'unset', primary_goal: null, category: null, target_date: null, target_value: null, target_unit: null, starting_value: null, set_at: null, days_to_deadline: null, goal_progress_pct: null },
  calendar_today: { count: 0, next: null },
  calendar_passed: { count: 0, most_recent: null },
  autopilot: { state: 'none_yet', today_checkpoint: null, this_week: [], pending_total: 0 },
  matches_unread: 0,
  messages_unread: 0,
  reminders_today: { count: 0, next: null },
  diary_last_7d: 0,
  facts_learned_since_last: null,
  guided_journey: null,
  last_session_date_user_tz: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  getUserTimezoneMock.mockResolvedValue('Europe/Berlin');
  dayWindowUtcIsoMock.mockReturnValue({ startUtc: '2026-06-30T00:00:00.000Z', endUtc: '2026-06-30T23:59:59.999Z' });
  todayInTimezoneMock.mockReturnValue('2026-06-30');
});

describe('tool_get_day_summary', () => {
  test('requires an authenticated user', async () => {
    const r = await tool_get_day_summary({}, { user_id: '', tenant_id: null, role: null }, {} as any);
    expect(r.ok).toBe(false);
  });

  test('scopes the gather to TODAY — passes local midnight, not the last-session time', async () => {
    gatherOverviewPayloadMock.mockResolvedValue(EMPTY_OVERVIEW);
    await tool_get_day_summary({}, { user_id: USER_ID, tenant_id: 't1', role: null }, {} as any);

    expect(gatherOverviewPayloadMock).toHaveBeenCalledTimes(1);
    const arg = gatherOverviewPayloadMock.mock.calls[0][0];
    expect(arg.userId).toBe(USER_ID);
    expect(arg.timezone).toBe('Europe/Berlin');
    expect(arg.lastSessionDateUserTz).toBe('2026-06-30');
    expect(arg.lastSessionAtIso).toBe('2026-06-30T00:00:00.000Z');
  });

  test('an empty day says so warmly, has_content: false, not an error', async () => {
    gatherOverviewPayloadMock.mockResolvedValue(EMPTY_OVERVIEW);
    const r = await tool_get_day_summary({}, { user_id: USER_ID, tenant_id: 't1', role: null }, {} as any);
    expect(r.ok).toBe(true);
    expect((r.result as any).has_content).toBe(false);
    expect(r.text).toMatch(/quiet day/i);
    expect(r.text).not.toMatch(/error/i);
  });

  test('a populated day surfaces every signal as DATA, never a scripted sentence', async () => {
    gatherOverviewPayloadMock.mockResolvedValue({
      ...EMPTY_OVERVIEW,
      vitana_index: { ...EMPTY_OVERVIEW.vitana_index, today: 74, trend_7d: 3 },
      calendar_today: { count: 2, next: { title: 'Team sync', start_iso: '2026-06-30T15:00:00Z' } },
      autopilot: { ...EMPTY_OVERVIEW.autopilot, today_checkpoint: { recommendation_id: 'r1', title: 'Evening walk', summary: null, domain: null, impact_score: null } },
      reminders_today: { count: 1, next: null },
      messages_unread: 3,
      matches_unread: 1,
      facts_learned_since_last: { count: 2, sample: [] },
    });
    const r = await tool_get_day_summary({}, { user_id: USER_ID, tenant_id: 't1', role: null }, {} as any);
    expect(r.ok).toBe(true);
    const result = r.result as any;
    expect(result.has_content).toBe(true);
    expect(result.index_today).toBe(74);
    expect(result.index_trend_7d).toBe(3);
    expect(result.calendar_today_count).toBe(2);
    expect(result.autopilot_checkpoint).toBe('Evening walk');
    expect(result.reminders_today_count).toBe(1);
    expect(result.messages_unread).toBe(3);
    expect(result.matches_unread).toBe(1);
    expect(result.facts_learned_today).toBe(2);

    // The tool result is data the model narrates, not a finished sentence —
    // it must NOT read as a pre-written spoken line (CLAUDE.md NEVER-rule 41).
    expect(r.text).toMatch(/compose your own sentence/i);
    expect(r.text).not.toMatch(/^Say exactly/i);
  });

  test('a thrown gather error surfaces as ok:false, not a silent empty summary', async () => {
    gatherOverviewPayloadMock.mockRejectedValue(new Error('boom'));
    const r = await tool_get_day_summary({}, { user_id: USER_ID, tenant_id: 't1', role: null }, {} as any);
    expect(r.ok).toBe(false);
  });
});
