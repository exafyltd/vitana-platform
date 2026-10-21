/**
 * A0.2 — Characterization test for describeTimeSince.
 *
 * Purpose: lock the time-bucket logic that decides which greeting pool the
 * model uses (reconnect / recent / same_day / today / yesterday / week /
 * long / first). The bucket boundaries directly drive user-perceived
 * greeting style — a regression here is what surfaces as "Hello Dragan
 * after we just spoke" or "no greeting after 9 days away".
 *
 * Approach: freeze the clock at a known instant via jest.useFakeTimers,
 * then snapshot describeTimeSince output for representative gaps that
 * straddle every bucket boundary (the ones in the source: 120s, 15min,
 * 8h, 24h, 7d).
 *
 * Will move when: A8 extracts session lifecycle into
 * services/gateway/src/orb/live/session/. The bucket function should
 * relocate cleanly because it is already pure.
 */

import { describeTimeSince } from '../../../../src/routes/orb-live';

// Fixed wall-clock for reproducible bucket math:
//   2026-05-10T12:00:00.000Z (Sunday at noon UTC)
const FROZEN_NOW = new Date('2026-05-10T12:00:00.000Z').getTime();

// Helper: build a lastSessionInfo whose `time` is N ms before FROZEN_NOW.
function nMsAgo(ms: number): { time: string; wasFailure: boolean } {
  return { time: new Date(FROZEN_NOW - ms).toISOString(), wasFailure: false };
}

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(FROZEN_NOW));
});

afterAll(() => {
  jest.useRealTimers();
});

describe('A0.2 characterization: describeTimeSince', () => {
  describe('null / invalid input', () => {
    it.each([
      { name: 'undefined', input: undefined },
      { name: 'null', input: null },
      { name: 'no-time-field', input: { time: '', wasFailure: false } as { time: string; wasFailure: boolean } },
      { name: 'invalid-time-string', input: { time: 'not-a-date', wasFailure: true } },
    ])('"$name" returns first-bucket sentinel', ({ name, input }) => {
      const result = describeTimeSince(input as any);
      expect(result.bucket).toBe('first');
      expect(result.timeAgo).toBe('never before');
      expect(result.diffMs).toBe(Number.POSITIVE_INFINITY);
      // wasFailure must be carried through when the input had it; otherwise false.
      const expectedFailure = name === 'invalid-time-string';
      expect(result.wasFailure).toBe(expectedFailure);
    });
  });

  describe('bucket boundaries', () => {
    // Test points chosen at and just after each bucket threshold from the
    // source. The point JUST BELOW the threshold belongs to the previous
    // bucket; the point AT/AFTER belongs to the next bucket.
    const cases = [
      // reconnect bucket: 0..119s
      { name: '5s-ago', ms: 5_000, expectedBucket: 'reconnect' },
      { name: '29s-ago', ms: 29_000, expectedBucket: 'reconnect' },
      { name: '60s-ago', ms: 60_000, expectedBucket: 'reconnect' },
      { name: '119s-ago', ms: 119_000, expectedBucket: 'reconnect' },
      // recent bucket: 120s..14m59s
      { name: '120s-ago', ms: 120_000, expectedBucket: 'recent' },
      { name: '14m-ago', ms: 14 * 60_000, expectedBucket: 'recent' },
      // same_day bucket: 15m..7h59m
      { name: '15m-ago', ms: 15 * 60_000, expectedBucket: 'same_day' },
      { name: '1h-ago', ms: 60 * 60_000, expectedBucket: 'same_day' },
      { name: '7h-ago', ms: 7 * 60 * 60_000, expectedBucket: 'same_day' },
      // today bucket: 8h..23h59m
      { name: '8h-ago', ms: 8 * 60 * 60_000, expectedBucket: 'today' },
      { name: '23h-ago', ms: 23 * 60 * 60_000, expectedBucket: 'today' },
      // yesterday bucket: 24h..47h59m (diffDay === 1)
      { name: '25h-ago', ms: 25 * 60 * 60_000, expectedBucket: 'yesterday' },
      { name: '47h-ago', ms: 47 * 60 * 60_000, expectedBucket: 'yesterday' },
      // week bucket: 2..6 days
      { name: '2d-ago', ms: 2 * 24 * 60 * 60_000, expectedBucket: 'week' },
      { name: '6d-ago', ms: 6 * 24 * 60 * 60_000, expectedBucket: 'week' },
      // long bucket: 7+ days
      { name: '7d-ago', ms: 7 * 24 * 60 * 60_000, expectedBucket: 'long' },
      { name: '30d-ago', ms: 30 * 24 * 60 * 60_000, expectedBucket: 'long' },
    ] as const;

    it.each(cases)('"$name" lands in bucket "$expectedBucket"', ({ ms, expectedBucket }) => {
      expect(describeTimeSince(nMsAgo(ms)).bucket).toBe(expectedBucket);
    });
  });

  describe('full snapshot', () => {
    it('snapshots describeTimeSince across the bucket grid', () => {
      const grid = {
        nullInput: describeTimeSince(null),
        oneSecondAgo: describeTimeSince(nMsAgo(1_000)),
        thirtySecondsAgo: describeTimeSince(nMsAgo(30_000)),
        twoMinutesAgo: describeTimeSince(nMsAgo(120_000)),
        thirtyMinutesAgo: describeTimeSince(nMsAgo(30 * 60_000)),
        threeHoursAgo: describeTimeSince(nMsAgo(3 * 60 * 60_000)),
        twentyHoursAgo: describeTimeSince(nMsAgo(20 * 60 * 60_000)),
        thirtyHoursAgo: describeTimeSince(nMsAgo(30 * 60 * 60_000)),
        threeDaysAgo: describeTimeSince(nMsAgo(3 * 24 * 60 * 60_000)),
        fourteenDaysAgo: describeTimeSince(nMsAgo(14 * 24 * 60 * 60_000)),
      };
      expect(grid).toMatchSnapshot();
    });
  });

  describe('wasFailure pass-through', () => {
    it('preserves wasFailure=true regardless of bucket', () => {
      const failed = { time: new Date(FROZEN_NOW - 60_000).toISOString(), wasFailure: true };
      expect(describeTimeSince(failed).wasFailure).toBe(true);
    });

    it('preserves wasFailure=false regardless of bucket', () => {
      const ok = { time: new Date(FROZEN_NOW - 60_000).toISOString(), wasFailure: false };
      expect(describeTimeSince(ok).wasFailure).toBe(false);
    });
  });
});
