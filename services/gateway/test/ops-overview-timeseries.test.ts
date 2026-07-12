/**
 * Tests for the Overview trend rollup's pure bucketing logic. The route
 * handler itself is a thin Supabase passthrough (auth + fetch + bucketize);
 * bucketize() is where the actual behavior lives, so — same pattern as
 * autonomy-pulse.test.ts — this unit-tests the pure function directly
 * rather than standing up a full HTTP + Supabase mock harness.
 */

import { bucketize } from '../src/routes/ops-overview-timeseries';

describe('bucketize', () => {
  const REAL_NOW = Date.now;
  const FIXED_NOW = new Date('2026-07-12T12:00:00.000Z').getTime();

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    Date.now = REAL_NOW;
    jest.restoreAllMocks();
  });

  const hoursAgoIso = (hours: number) => new Date(FIXED_NOW - hours * 3_600_000).toISOString();

  it('returns 24 zero buckets for an empty input', () => {
    const buckets = bucketize([]);
    expect(buckets).toHaveLength(24);
    expect(buckets.every((v) => v === 0)).toBe(true);
  });

  it('places a just-now event in the last bucket', () => {
    const buckets = bucketize([new Date(FIXED_NOW).toISOString()]);
    expect(buckets[23]).toBe(1);
    expect(buckets.slice(0, 23).every((v) => v === 0)).toBe(true);
  });

  it('places a 23-hours-ago event in the first bucket', () => {
    const buckets = bucketize([hoursAgoIso(23)]);
    expect(buckets[0]).toBe(1);
    expect(buckets.slice(1).every((v) => v === 0)).toBe(true);
  });

  it('drops events older than the 24h lookback window', () => {
    const buckets = bucketize([hoursAgoIso(30), hoursAgoIso(48)]);
    expect(buckets.every((v) => v === 0)).toBe(true);
  });

  it('drops events from the future (clock skew safety)', () => {
    const buckets = bucketize([new Date(FIXED_NOW + 3_600_000).toISOString()]);
    expect(buckets.every((v) => v === 0)).toBe(true);
  });

  it('accumulates multiple events landing in the same hour bucket', () => {
    const buckets = bucketize([hoursAgoIso(2), hoursAgoIso(2), hoursAgoIso(2.5)]);
    const nonZero = buckets.filter((v) => v > 0);
    expect(nonZero).toEqual([3]);
  });

  it('spreads events across distinct hour buckets in the right order (oldest first)', () => {
    const buckets = bucketize([hoursAgoIso(10), hoursAgoIso(1)]);
    const tenHoursIdx = 24 - 1 - 10;
    const oneHourIdx = 24 - 1 - 1;
    expect(buckets[tenHoursIdx]).toBe(1);
    expect(buckets[oneHourIdx]).toBe(1);
    expect(tenHoursIdx).toBeLessThan(oneHourIdx);
  });
});
