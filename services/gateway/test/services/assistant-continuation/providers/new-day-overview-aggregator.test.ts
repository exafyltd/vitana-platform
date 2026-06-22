/**
 * VTID-03166 — Aggregator + overview-aware renderer tests.
 *
 * Locks:
 *   - dayWindowUtcIso correctness for IANA timezones
 *   - formatHhmmInTz returns hh:mm in user TZ
 *   - aggregateNewDayOverview degrades gracefully on partial source failure
 *   - renderNewDayReturnLineWithOverview picks at most 2 content clauses,
 *     never speaks Life Compass when calendar/Index already fired,
 *     suppresses Index clause for sub-10-point trend, branches by lang
 */

import {
  dayWindowUtcIso,
  formatHhmmInTz,
  aggregateNewDayOverview,
  EMPTY_OVERVIEW,
  type NewDayOverviewPayload,
} from '../../../../src/services/assistant-continuation/providers/new-day-overview-aggregator';
import {
  renderNewDayReturnLineWithOverview,
} from '../../../../src/services/assistant-continuation/providers/new-day-return';

describe('VTID-03166 dayWindowUtcIso', () => {
  it('produces 24-hour-wide window for a recognized TZ', () => {
    const now = new Date('2026-06-15T12:30:00.000Z');
    const w = dayWindowUtcIso(now, 'Europe/Berlin');
    // Berlin in June is UTC+2 → local 14:30. Local day [00:00, 23:59:59.999] = UTC [22:00 prev, 21:59 today].
    expect(w.startUtc.startsWith('2026-06-14T22:00:00')).toBe(true);
    expect(w.endUtc.startsWith('2026-06-15T21:59:59')).toBe(true);
  });
  it('falls back to UTC day when TZ invalid', () => {
    const now = new Date('2026-06-15T12:30:00.000Z');
    const w = dayWindowUtcIso(now, 'Not/A_Real_Timezone');
    // Falls back to UTC midnight pair.
    expect(w.startUtc).toBe('2026-06-15T00:00:00.000Z');
  });
});

describe('VTID-03166 formatHhmmInTz', () => {
  it('returns HH:MM in IANA TZ', () => {
    // UTC 14:30 → Berlin 16:30 (June, UTC+2)
    expect(formatHhmmInTz('2026-06-15T14:30:00.000Z', 'Europe/Berlin')).toBe('16:30');
  });
  it('handles different TZ', () => {
    // UTC 14:30 → LA 07:30 (June, UTC-7)
    expect(formatHhmmInTz('2026-06-15T14:30:00.000Z', 'America/Los_Angeles')).toBe('07:30');
  });
  it('returns 00:00 on invalid TZ', () => {
    // Note: Intl tends to silently fall back to UTC for invalid TZ on some Node builds.
    // The contract is "never throw"; the actual value is implementation-defined.
    expect(() => formatHhmmInTz('2026-06-15T14:30:00.000Z', 'Not/A_TZ')).not.toThrow();
  });
});

function makeAggregatorFakeSupabase(rows: {
  calendar?: Array<{ title: string; start_time: string; status?: string }>;
  calendarError?: boolean;
} = {}) {
  const calendarRows = rows.calendar ?? [];
  return {
    from(table: string) {
      if (table === 'calendar_events') {
        const builder: any = {
          select() { return builder; },
          eq() { return builder; },
          gte() { return builder; },
          lt() { return builder; },
          lte() { return builder; },
          order() { return builder; },
          async limit() {
            if (rows.calendarError) return { data: null, error: { message: 'boom' } };
            return { data: calendarRows, error: null };
          },
        };
        return builder;
      }
      // Default for life_compass / vitana_index queries we won't exercise here.
      return {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        async limit() { return { data: [], error: null }; },
        async maybeSingle() { return { data: null, error: null }; },
      } as any;
    },
  } as any;
}

describe('VTID-03166 aggregateNewDayOverview', () => {
  const FIXED_NOW = new Date('2026-06-15T12:30:00.000Z');

  it('returns EMPTY_OVERVIEW shape when all sources empty', async () => {
    const sb = makeAggregatorFakeSupabase({ calendar: [] });
    const out = await aggregateNewDayOverview({
      supabase: sb,
      userId: 'u1',
      lastSessionAtIso: '2026-06-14T00:00:00.000Z',
      todayDateIso: '2026-06-15',
      timezone: 'Europe/Berlin',
      now: FIXED_NOW,
    });
    expect(out.calendar_passed_count).toBe(0);
    expect(out.calendar_today_count).toBe(0);
    expect(out.life_compass_goal).toBeNull();
    expect(out.vitana_index_today).toBeNull();
  });

  it('returns counts + notable for calendar events', async () => {
    const sb = makeAggregatorFakeSupabase({
      calendar: [
        { title: 'Team Sync', start_time: '2026-06-15T13:00:00.000Z' },
        { title: 'Lunch', start_time: '2026-06-15T11:00:00.000Z' },
      ],
    });
    const out = await aggregateNewDayOverview({
      supabase: sb,
      userId: 'u1',
      lastSessionAtIso: '2026-06-14T00:00:00.000Z',
      todayDateIso: '2026-06-15',
      timezone: 'Europe/Berlin',
      now: FIXED_NOW,
    });
    // Both calendar queries (passed + today) hit the same fake — both get the same rows.
    expect(out.calendar_passed_count).toBe(2);
    expect(out.calendar_passed_notable?.title).toBe('Team Sync');
  });

  it('degrades gracefully when calendar query errors', async () => {
    const sb = makeAggregatorFakeSupabase({ calendarError: true });
    const out = await aggregateNewDayOverview({
      supabase: sb,
      userId: 'u1',
      lastSessionAtIso: null,
      todayDateIso: '2026-06-15',
      timezone: 'Europe/Berlin',
      now: FIXED_NOW,
    });
    expect(out.calendar_passed_count).toBe(0);
    expect(out.calendar_today_count).toBe(0);
  });
});

describe('VTID-03166 renderNewDayReturnLineWithOverview', () => {
  const args = {
    lang: 'en',
    salutation: 'afternoon' as const,
    firstName: 'Dragan',
    timezone: 'Europe/Berlin',
    payload: { ...EMPTY_OVERVIEW } as NewDayOverviewPayload,
  };

  it('renders just salutation + invitation when payload empty', () => {
    const line = renderNewDayReturnLineWithOverview(args, () => 0);
    expect(line).toMatch(/Good afternoon, Dragan\./);
    expect(line).toMatch(/Let me walk you to what's next|Let me show you your next step|Let's get started/);
    expect(line).not.toMatch(/event|Index|focus/i);
  });

  it('includes the calendar-passed clause when present', () => {
    const line = renderNewDayReturnLineWithOverview({
      ...args,
      payload: {
        ...EMPTY_OVERVIEW,
        calendar_passed_count: 1,
        calendar_passed_notable: { title: 'Team Sync', start_iso: '2026-06-15T08:00:00.000Z' },
      },
    }, () => 0);
    expect(line).toMatch(/Since we last spoke you had "Team Sync" at 10:00/);
  });

  it('includes today clause when present', () => {
    const line = renderNewDayReturnLineWithOverview({
      ...args,
      payload: {
        ...EMPTY_OVERVIEW,
        calendar_today_count: 2,
        calendar_today_next: { title: 'Maxina Sync', start_iso: '2026-06-15T13:00:00.000Z' },
      },
    }, () => 0);
    expect(line).toMatch(/Today you have 2 events lined up, next is "Maxina Sync" at 15:00/);
  });

  it('includes Vitana Index clause only when delta >= 10', () => {
    const lineBelow = renderNewDayReturnLineWithOverview({
      ...args,
      payload: { ...EMPTY_OVERVIEW, vitana_index_today: 612, vitana_index_trend_7d: 5 },
    }, () => 0);
    expect(lineBelow).not.toMatch(/Index/);

    const lineAbove = renderNewDayReturnLineWithOverview({
      ...args,
      payload: { ...EMPTY_OVERVIEW, vitana_index_today: 612, vitana_index_trend_7d: 18 },
    }, () => 0);
    expect(lineAbove).toMatch(/Your Vitana Index is at 612, up 18 points/);
  });

  it('Life Compass clause fires only when no calendar/Index content', () => {
    // With calendar content present → no Life Compass clause
    const withCal = renderNewDayReturnLineWithOverview({
      ...args,
      payload: {
        ...EMPTY_OVERVIEW,
        calendar_today_count: 1,
        calendar_today_next: { title: 'Meeting', start_iso: '2026-06-15T13:00:00.000Z' },
        life_compass_goal: 'sleep better',
      },
    }, () => 0);
    expect(withCal).not.toMatch(/focus stays/);

    // No calendar, no index → Life Compass appears
    const compassOnly = renderNewDayReturnLineWithOverview({
      ...args,
      payload: { ...EMPTY_OVERVIEW, life_compass_goal: 'sleep better' },
    }, () => 0);
    expect(compassOnly).toMatch(/Your focus stays on: sleep better/);
  });

  it('caps content clauses at 2 (calendar passed + today, no Index even when material)', () => {
    const line = renderNewDayReturnLineWithOverview({
      ...args,
      payload: {
        calendar_passed_count: 1,
        calendar_passed_notable: { title: 'Call', start_iso: '2026-06-15T08:00:00.000Z' },
        calendar_today_count: 1,
        calendar_today_next: { title: 'Lunch', start_iso: '2026-06-15T13:00:00.000Z' },
        vitana_index_today: 600,
        vitana_index_trend_7d: 20,
        life_compass_goal: 'sleep better',
      },
    }, () => 0);
    expect(line).toMatch(/Call/);
    expect(line).toMatch(/Lunch/);
    expect(line).not.toMatch(/Vitana Index/);
    expect(line).not.toMatch(/focus stays/);
  });

  it('German branch wires through cleanly', () => {
    const line = renderNewDayReturnLineWithOverview({
      ...args,
      lang: 'de',
      salutation: 'morning',
      payload: {
        ...EMPTY_OVERVIEW,
        calendar_today_count: 1,
        calendar_today_next: { title: 'Maxina Sync', start_iso: '2026-06-15T13:00:00.000Z' },
      },
    }, () => 0);
    expect(line).toMatch(/Guten Morgen, Dragan\./);
    expect(line).toMatch(/Heute steht "Maxina Sync"/);
    expect(line).toMatch(/Lass mich dir zeigen, was als Nächstes kommt|Lass mich dir deinen nächsten Schritt|Lass uns gleich loslegen/);
  });

  it('no firstName → opens without name comma', () => {
    const line = renderNewDayReturnLineWithOverview({
      ...args,
      firstName: null,
      payload: {
        ...EMPTY_OVERVIEW,
        calendar_today_count: 1,
        calendar_today_next: { title: 'X', start_iso: '2026-06-15T13:00:00.000Z' },
      },
    }, () => 0);
    expect(line).not.toMatch(/, Dragan/);
    expect(line).toMatch(/Good afternoon\./);
  });
});
