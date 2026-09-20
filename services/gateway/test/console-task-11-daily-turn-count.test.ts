/**
 * VTID-04174 (console task 11): `countOperatorTurnsToday` — how many distinct
 * operator turns happened on the current UTC day.
 *
 * The helper is pure and must degrade to 0 without throwing when the caller
 * has no data at all (OPERATOR_THREADS_ENABLED off, tables empty or absent),
 * which is why the empty/absent cases are pinned alongside the counting ones.
 */

// The module imports the LLM router at load time; stub it so this suite stays
// a pure unit test with no provider/DB surface (same posture as
// vtid-04022-operator-threads.test.ts).
jest.mock('../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));

import { countOperatorTurnsToday } from '../src/services/operator-threads';

const NOW = new Date('2026-09-20T13:45:00.000Z');

/** ISO instants on the UTC day of NOW, at the given hours. */
const today = (hour: number, minute = 0, second = 0): string =>
  new Date(Date.UTC(2026, 8, 20, hour, minute, second)).toISOString();

describe('VTID-04174 countOperatorTurnsToday', () => {
  it('counts only the timestamps on the current UTC day (AC-1)', () => {
    const timestamps = [
      today(0, 0, 0), // first instant of the day — included
      today(9, 30),
      today(13, 44, 59), // one second before `now` — included
      new Date(Date.UTC(2026, 8, 19, 23, 59, 59)).toISOString(), // yesterday
      new Date(Date.UTC(2026, 8, 21, 0, 0, 0)).toISOString(), // tomorrow
      new Date(Date.UTC(2026, 7, 20, 12, 0, 0)).toISOString(), // last month
    ];
    expect(countOperatorTurnsToday(timestamps, NOW)).toBe(3);
  });

  it('spans multiple days in one list and ignores the other days (AC-3)', () => {
    const timestamps = [
      '2026-09-18T08:00:00.000Z',
      '2026-09-19T08:00:00.000Z',
      '2026-09-19T20:00:00.000Z',
      '2026-09-20T01:00:00.000Z',
      '2026-09-20T02:00:00.000Z',
      '2026-09-21T08:00:00.000Z',
    ];
    expect(countOperatorTurnsToday(timestamps, NOW)).toBe(2);
  });

  it('returns 0 for an empty list without throwing (AC-2)', () => {
    expect(countOperatorTurnsToday([], NOW)).toBe(0);
    expect(countOperatorTurnsToday([], NOW)).not.toBeNaN();
  });

  it('degrades gracefully to 0 for absent / non-list data — feature off or tables missing', () => {
    expect(countOperatorTurnsToday(null, NOW)).toBe(0);
    expect(countOperatorTurnsToday(undefined, NOW)).toBe(0);
    expect(countOperatorTurnsToday([], NOW)).toBe(0);
    // A Supabase read that failed and handed back a non-array must not throw.
    expect(countOperatorTurnsToday({} as unknown as string[], NOW)).toBe(0);
  });

  it('skips unparseable entries instead of throwing', () => {
    expect(countOperatorTurnsToday([today(10), 'not-a-date', '', null, undefined, NaN], NOW)).toBe(1);
    expect(countOperatorTurnsToday([null, undefined, 'nope'], NOW)).toBe(0);
  });

  it('counts distinct instants only, and accepts Date and epoch-ms entries', () => {
    const dup = today(11);
    expect(countOperatorTurnsToday([dup, dup, today(11, 0, 0), today(12)], NOW)).toBe(2);
    expect(countOperatorTurnsToday([new Date(Date.UTC(2026, 8, 20, 5, 0, 0)), Date.UTC(2026, 8, 20, 6, 0, 0)], NOW)).toBe(2);
  });

  it('uses the UTC day boundary, not a local-time one', () => {
    // 2026-09-20T00:00:00Z is still 2026-09-19 in negative-offset zones; the
    // UTC day starts here regardless of the host timezone.
    expect(countOperatorTurnsToday(['2026-09-20T00:00:00.000Z'], NOW)).toBe(1);
    expect(countOperatorTurnsToday(['2026-09-19T23:59:59.999Z'], NOW)).toBe(0);
    expect(countOperatorTurnsToday(['2026-09-21T00:00:00.000Z'], NOW)).toBe(0);
  });

  it('is stable with the current wall clock when given no explicit now', () => {
    expect(countOperatorTurnsToday([])).toBe(0);
    expect(countOperatorTurnsToday([new Date().toISOString()])).toBe(1);
  });

  it('degrades to 0 rather than counting everything when `now` is unparseable', () => {
    expect(countOperatorTurnsToday([today(10)], new Date('nonsense'))).toBe(0);
  });
});
