/**
 * VTID-04204 — pure aggregation of Dev Autopilot execution status counts
 * over the last 24 hours. No DB access; every case here is exercised
 * against the real, unmocked function.
 */

import { summarizeExecutionStatusCounts } from '../src/services/dev-autopilot-execution-stats';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('VTID-04204 summarizeExecutionStatusCounts', () => {
  it('excludes records older than 24 hours from the given now', () => {
    const records = [
      { status: 'completed', created_at: new Date(NOW - 1 * HOUR).toISOString() }, // in window
      { status: 'completed', created_at: new Date(NOW - 23 * HOUR).toISOString() }, // in window (barely)
      { status: 'completed', created_at: new Date(NOW - 25 * HOUR).toISOString() }, // OUT of window
      { status: 'failed', created_at: new Date(NOW - 48 * HOUR).toISOString() }, // OUT of window
    ];
    expect(summarizeExecutionStatusCounts(records, NOW)).toEqual({ completed: 2 });
  });

  it('represents every status value present in the (time-filtered) input, with a correct count', () => {
    const records = [
      { status: 'queued', created_at: new Date(NOW - 1 * HOUR).toISOString() },
      { status: 'queued', created_at: new Date(NOW - 2 * HOUR).toISOString() },
      { status: 'running', created_at: new Date(NOW - 3 * HOUR).toISOString() },
      { status: 'awaiting_approval', created_at: new Date(NOW - 4 * HOUR).toISOString() },
      { status: 'completed', created_at: new Date(NOW - 5 * HOUR).toISOString() },
      { status: 'completed', created_at: new Date(NOW - 6 * HOUR).toISOString() },
      { status: 'completed', created_at: new Date(NOW - 7 * HOUR).toISOString() },
      { status: 'completed', created_at: new Date(NOW - 8 * HOUR).toISOString() },
      { status: 'completed', created_at: new Date(NOW - 9 * HOUR).toISOString() },
      { status: 'failed', created_at: new Date(NOW - 10 * HOUR).toISOString() },
    ];
    expect(summarizeExecutionStatusCounts(records, NOW)).toEqual({
      queued: 2,
      running: 1,
      awaiting_approval: 1,
      completed: 5,
      failed: 1,
    });
  });

  it('an empty input array returns an empty counts object, not an error', () => {
    // Deliberately not a fixed zero-filled enum (see the module's own
    // header comment) — an object with no status keys at all IS "all-zero
    // counts": every status this function could ever report is implicitly
    // zero when the key is absent, and this avoids hardcoding a status
    // enum that would drift from the real dev_autopilot_executions CHECK
    // constraint, the exact anti-pattern this repo's own VTID-03644/
    // VTID-03696 already got burned by.
    expect(() => summarizeExecutionStatusCounts([], NOW)).not.toThrow();
    expect(summarizeExecutionStatusCounts([], NOW)).toEqual({});
  });

  it('is NOT filtered to any particular status — mixed statuses in the window all count', () => {
    const records = [
      { status: 'cancelled', created_at: new Date(NOW - 1 * HOUR).toISOString() },
      { status: 'reverted', created_at: new Date(NOW - 1 * HOUR).toISOString() },
      { status: 'rejected', created_at: new Date(NOW - 1 * HOUR).toISOString() },
      { status: 'archived', created_at: new Date(NOW - 1 * HOUR).toISOString() },
    ];
    expect(summarizeExecutionStatusCounts(records, NOW)).toEqual({
      cancelled: 1,
      reverted: 1,
      rejected: 1,
      archived: 1,
    });
  });

  it('defaults nowMs to Date.now() and windowMs to 24 hours when omitted', () => {
    const realNow = Date.now();
    const records = [
      { status: 'completed', created_at: new Date(realNow - 1000).toISOString() },
      { status: 'completed', created_at: new Date(realNow - 30 * HOUR).toISOString() },
    ];
    expect(summarizeExecutionStatusCounts(records)).toEqual({ completed: 1 });
  });

  it('skips a malformed record (missing/blank status, unparsable created_at) rather than throwing', () => {
    const records = [
      { status: '', created_at: new Date(NOW - 1 * HOUR).toISOString() },
      { status: 'completed', created_at: 'not-a-date' },
      { status: 'completed', created_at: new Date(NOW - 1 * HOUR).toISOString() },
    ] as unknown as { status: string; created_at: string }[];
    expect(() => summarizeExecutionStatusCounts(records, NOW)).not.toThrow();
    expect(summarizeExecutionStatusCounts(records, NOW)).toEqual({ completed: 1 });
  });

  it('a non-array input returns an empty counts object rather than throwing', () => {
    expect(summarizeExecutionStatusCounts(undefined as unknown as [], NOW)).toEqual({});
    expect(summarizeExecutionStatusCounts(null as unknown as [], NOW)).toEqual({});
  });

  it('respects a custom windowMs when provided', () => {
    const records = [
      { status: 'completed', created_at: new Date(NOW - 2 * HOUR).toISOString() },
      { status: 'completed', created_at: new Date(NOW - 4 * HOUR).toISOString() },
    ];
    expect(summarizeExecutionStatusCounts(records, NOW, 3 * HOUR)).toEqual({ completed: 1 });
  });
});
