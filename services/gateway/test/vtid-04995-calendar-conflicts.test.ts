/**
 * VTID-04995 — overlap warnings. `computeConflicts` is pure: what a proposed
 * time overlaps, given the calendar window and the external busy blocks.
 */
import { computeConflicts, type ExternalBusyLike } from '../src/services/calendar-service';
import type { CalendarWindowItem } from '../src/services/calendar-service';

const own = (id: string, start: string, end: string | null, over: Record<string, unknown> = {}): CalendarWindowItem =>
  ({ id, event_id: id, start_time: start, end_time: end, busy: false, occurrence_index: null,
     event: { id, title: `T-${id}`, status: 'confirmed', source_type: 'manual', start_time: start, end_time: end, ...over } }) as unknown as CalendarWindowItem;
const busy = (id: string, start: string, end: string): CalendarWindowItem =>
  ({ id, event_id: id, start_time: start, end_time: end, busy: true, occurrence_index: null, event: null }) as unknown as CalendarWindowItem;
const ext = (id: string, start: string, end: string, source = 'google'): ExternalBusyLike => ({ id, event_id: id, start_time: start, end_time: end, source });

const P = { start: '2026-10-05T09:00:00Z', end: '2026-10-05T10:00:00Z' };

describe('computeConflicts (VTID-04995)', () => {
  it('an overlapping own entry is reported with its title', () => {
    const r = computeConflicts([own('a', '2026-10-05T09:30:00Z', '2026-10-05T10:30:00Z')], [], P);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'own', title: 'T-a' });
  });

  it('entries that only touch the boundary do not overlap', () => {
    const r = computeConflicts([own('a', '2026-10-05T08:00:00Z', '2026-10-05T09:00:00Z'), own('b', '2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z')], [], P);
    expect(r).toEqual([]);
  });

  it('another lens shows as busy with no title; a connected calendar as external with no title', () => {
    const r = computeConflicts([busy('w', '2026-10-05T09:15:00Z', '2026-10-05T09:45:00Z')], [ext('g:1', '2026-10-05T09:50:00Z', '2026-10-05T10:20:00Z', 'microsoft')], P);
    expect(r.map((x) => [x.kind, x.title])).toEqual([['busy', null], ['external', null]]);
    expect(r[1].source).toBe('microsoft');
    expect(JSON.stringify(r)).not.toContain('T-');
  });

  it('reminders and subscription dates never conflict; cancelled/pending entries are ignored', () => {
    const r = computeConflicts([
      own('r', '2026-10-05T09:00:00Z', '2026-10-05T09:15:00Z', { source_type: 'reminder' }),
      own('s', '2026-10-05T09:00:00Z', '2026-10-05T09:15:00Z', { source_type: 'subscription' }),
      own('p', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z', { status: 'pending' }),
    ], [], P);
    expect(r).toEqual([]);
  });

  it('the entry being edited or moved does not conflict with itself, whichever occurrence', () => {
    const r = computeConflicts([own('me', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z'), own('x', '2026-10-05T09:10:00Z', '2026-10-05T09:20:00Z')], [], P, { excludeEventId: 'me' });
    expect(r.map((x) => x.event_id)).toEqual(['x']);
  });

  it('an entry without an end counts as one hour', () => {
    expect(computeConflicts([own('n', '2026-10-05T09:59:00Z', null)], [], P)).toHaveLength(1);
    expect(computeConflicts([own('n', '2026-10-05T10:00:00Z', null)], [], P)).toEqual([]);
  });

  it('an invalid or empty proposed window has no conflicts', () => {
    const items = [own('a', '2026-10-05T09:30:00Z', '2026-10-05T10:30:00Z')];
    expect(computeConflicts(items, [], { start: P.end, end: P.start })).toEqual([]);
    expect(computeConflicts(items, [], { start: 'x', end: P.end })).toEqual([]);
  });

  it('across the autumn clock change (Berlin, 2026-10-25) instants decide, not wall-clock hours', () => {
    // 02:00–03:00 CEST (+02:00) is 00:00Z–01:00Z; the next 02:00–03:00 CET (+01:00) is 01:00Z–02:00Z: they touch, they do not overlap.
    const first = own('cest', '2026-10-25T02:00:00+02:00', '2026-10-25T03:00:00+02:00');
    const second = { start: '2026-10-25T02:00:00+01:00', end: '2026-10-25T03:00:00+01:00' };
    expect(computeConflicts([first], [], second)).toEqual([]);
    // …but 02:30 CEST (00:30Z) overlaps a 00:45Z–01:15Z proposal.
    expect(computeConflicts([own('x', '2026-10-25T02:30:00+02:00', '2026-10-25T03:30:00+02:00')], [], { start: '2026-10-25T00:45:00Z', end: '2026-10-25T01:15:00Z' })).toHaveLength(1);
  });

  it('a whole-day entry overlaps anything inside its day', () => {
    const r = computeConflicts([own('day', '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z')], [], P);
    expect(r).toHaveLength(1);
  });

  it('results come back in time order and are capped at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => own(`m${i}`, '2026-10-05T09:00:00Z', '2026-10-05T09:30:00Z'));
    expect(computeConflicts(many, [], P)).toHaveLength(20);
    const r = computeConflicts([own('late', '2026-10-05T09:40:00Z', '2026-10-05T09:50:00Z'), own('early', '2026-10-05T09:00:00Z', '2026-10-05T09:10:00Z')], [], P);
    expect(r.map((x) => x.event_id)).toEqual(['early', 'late']);
  });
});
