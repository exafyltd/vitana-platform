/**
 * VTID-04996 — "find a time". `computeFreeSlots` is pure: free stretches that
 * fit a duration, over the same busy time the calendar shows, inside the
 * member's waking hours in their own time zone.
 */
import { computeFreeSlots, awakeSpans, type ExternalBusyLike, type CalendarWindowItem } from '../src/services/calendar-service';

const own = (id: string, start: string, end: string | null, over: Record<string, unknown> = {}): CalendarWindowItem =>
  ({ id, event_id: id, start_time: start, end_time: end, busy: false, occurrence_index: null,
     event: { id, title: `T-${id}`, status: 'confirmed', source_type: 'manual', start_time: start, end_time: end, ...over } }) as unknown as CalendarWindowItem;
const busy = (id: string, start: string, end: string): CalendarWindowItem =>
  ({ id, event_id: id, start_time: start, end_time: end, busy: true, occurrence_index: null, event: null }) as unknown as CalendarWindowItem;
const ext = (id: string, start: string, end: string): ExternalBusyLike => ({ id, event_id: id, start_time: start, end_time: end, source: 'google' });

const TZ = 'Europe/Berlin'; // 2026-10-05 is CEST (UTC+2): 07:00-22:00 local = 05:00-20:00Z
const base = {
  from: Date.parse('2026-10-05T00:00:00Z'),
  to: Date.parse('2026-10-08T00:00:00Z'),
  durationMin: 60,
  limit: 3,
  tz: TZ,
  quiet: null,
  now: Date.parse('2026-10-04T00:00:00Z'),
};

describe('computeFreeSlots (VTID-04996)', () => {
  it('an empty calendar offers the start of each waking day, one slot per stretch', () => {
    const r = computeFreeSlots([], [], base);
    expect(r.map((s) => s.start)).toEqual(['2026-10-05T05:00:00.000Z', '2026-10-06T05:00:00.000Z', '2026-10-07T05:00:00.000Z']);
    expect(r[0]).toMatchObject({ end: '2026-10-05T06:00:00.000Z', duration_minutes: 60, free_until: '2026-10-05T20:00:00.000Z' });
  });

  it('skips own commitments, other lenses and external calendars', () => {
    const r = computeFreeSlots(
      [own('a', '2026-10-05T05:00:00Z', '2026-10-05T07:00:00Z'), busy('w', '2026-10-05T07:00:00Z', '2026-10-05T07:30:00Z')],
      [ext('g', '2026-10-05T07:30:00Z', '2026-10-05T08:00:00Z')],
      { ...base, limit: 1 },
    );
    expect(r[0].start).toBe('2026-10-05T08:00:00.000Z');
  });

  it('a gap shorter than the duration is not offered; the next stretch is', () => {
    const r = computeFreeSlots(
      [own('a', '2026-10-05T05:00:00Z', '2026-10-05T07:00:00Z'), own('b', '2026-10-05T07:30:00Z', '2026-10-05T19:30:00Z')],
      [],
      { ...base, limit: 2 },
    );
    // 07:00-07:30Z is only 30 min; 19:30-20:00Z only 30 min → next day
    expect(r[0].start).toBe('2026-10-06T05:00:00.000Z');
  });

  it('quiet hours replace the 07-22 default (quiet 20:00-08:00 → awake 08:00-20:00 local)', () => {
    const r = computeFreeSlots([], [], { ...base, limit: 1, quiet: { startMin: 20 * 60, endMin: 8 * 60 } });
    expect(r[0].start).toBe('2026-10-05T06:00:00.000Z');
    expect(r[0].free_until).toBe('2026-10-05T18:00:00.000Z');
  });

  it('a quiet window inside the day (13:00-15:00) leaves two waking spans', () => {
    expect(awakeSpans({ startMin: 13 * 60, endMin: 15 * 60 })).toEqual([[0, 780], [900, 1440]]);
    expect(awakeSpans(null)).toEqual([[420, 1320]]);
    const r = computeFreeSlots(
      [own('a', '2026-10-05T00:00:00Z', '2026-10-05T11:00:00Z')],
      [],
      { ...base, limit: 1, durationMin: 30, quiet: { startMin: 13 * 60, endMin: 15 * 60 } },
    );
    // morning span ends 13:00 local = 11:00Z, fully busy → afternoon span from 15:00 local = 13:00Z
    expect(r[0].start).toBe('2026-10-05T13:00:00.000Z');
  });

  it('reminders, subscription dates and non-confirmed entries do not take time', () => {
    const r = computeFreeSlots(
      [
        own('r', '2026-10-05T05:00:00Z', '2026-10-05T06:00:00Z', { source_type: 'reminder' }),
        own('s', '2026-10-05T05:00:00Z', '2026-10-05T06:00:00Z', { source_type: 'subscription' }),
        own('p', '2026-10-05T05:00:00Z', '2026-10-05T06:00:00Z', { status: 'pending' }),
      ],
      [],
      { ...base, limit: 1 },
    );
    expect(r[0].start).toBe('2026-10-05T05:00:00.000Z');
  });

  it('an expected test-result date does not take time', () => {
    const r = computeFreeSlots(
      [own('t', '2026-10-05T05:00:00Z', '2026-10-05T06:00:00Z', { source_type: 'test_result' })],
      [],
      { ...base, limit: 1 },
    );
    expect(r[0].start).toBe('2026-10-05T05:00:00.000Z');
  });

  it('the entry being moved does not block its own slot', () => {
    const items = [own('a', '2026-10-05T05:00:00Z', '2026-10-05T07:00:00Z')];
    expect(computeFreeSlots(items, [], { ...base, limit: 1 })[0].start).toBe('2026-10-05T07:00:00.000Z');
    expect(computeFreeSlots(items, [], { ...base, limit: 1, excludeEventId: 'a' })[0].start).toBe('2026-10-05T05:00:00.000Z');
  });

  it('never offers the past: starts on the next quarter hour after now', () => {
    const r = computeFreeSlots([], [], { ...base, limit: 1, now: Date.parse('2026-10-05T09:07:00Z') });
    expect(r[0].start).toBe('2026-10-05T09:15:00.000Z');
  });

  it('an entry without an end blocks one hour', () => {
    const r = computeFreeSlots([own('a', '2026-10-05T05:00:00Z', null)], [], { ...base, limit: 1 });
    expect(r[0].start).toBe('2026-10-05T06:00:00.000Z');
  });

  it('follows the local day across the DST change (Berlin 2026-10-25 is UTC+1)', () => {
    const r = computeFreeSlots([], [], { ...base, from: Date.parse('2026-10-24T00:00:00Z'), to: Date.parse('2026-10-26T12:00:00Z'), now: Date.parse('2026-10-20T00:00:00Z') });
    expect(r.map((s) => s.start)).toEqual(['2026-10-24T05:00:00.000Z', '2026-10-25T06:00:00.000Z', '2026-10-26T06:00:00.000Z']);
  });

  it('respects the range end and rejects ranges over 14 days or an empty duration', () => {
    expect(computeFreeSlots([], [], { ...base, to: Date.parse('2026-10-05T05:30:00Z') })).toEqual([]);
    expect(computeFreeSlots([], [], { ...base, to: base.from + 15 * 86_400_000 })).toEqual([]);
    expect(computeFreeSlots([], [], { ...base, durationMin: 0 })).toEqual([]);
  });

  it('a slot ends exactly where the stretch allows (touching the next entry is fine)', () => {
    const r = computeFreeSlots([own('a', '2026-10-05T06:00:00Z', '2026-10-05T20:00:00Z')], [], { ...base, limit: 1 });
    expect(r[0]).toMatchObject({ start: '2026-10-05T05:00:00.000Z', end: '2026-10-05T06:00:00.000Z', free_until: '2026-10-05T06:00:00.000Z' });
  });
});
