/**
 * VTID-02932 (B2) — compileContinuityContext tests.
 *
 * Pure function. Verifies:
 *   - Open thread sorting (newest mentioned first) + cap.
 *   - Owed promise sorting (due-soonest first, nulls last) + cap.
 *   - Kept-recently window = 7 days, ordered newest-first, capped.
 *   - Counts (open_threads_total, promises_owed_total, promises_overdue,
 *     threads_mentioned_today) computed correctly with UTC day boundary.
 *   - source_health reflects the input fetch results.
 *   - days_since_last_mention / days_overdue math.
 */

import { compileContinuityContext } from '../../../src/services/continuity/compile-continuity-context';
import type {
  AssistantPromiseRow,
  OpenThreadRow,
} from '../../../src/services/continuity/types';

const NOW = Date.parse('2026-05-11T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function thread(over: Partial<OpenThreadRow>): OpenThreadRow {
  return {
    thread_id: 't',
    topic: 'topic',
    summary: null,
    status: 'open',
    session_id_first: null,
    session_id_last: null,
    last_mentioned_at: '2026-05-11T00:00:00Z',
    resolved_at: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-11T00:00:00Z',
    ...over,
  };
}

function promise(over: Partial<AssistantPromiseRow>): AssistantPromiseRow {
  return {
    promise_id: 'p',
    thread_id: null,
    session_id: null,
    promise_text: 'text',
    due_at: null,
    status: 'owed',
    decision_id: null,
    kept_at: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-11T00:00:00Z',
    ...over,
  };
}

describe('B2 — compileContinuityContext', () => {
  describe('open threads', () => {
    it('returns only status=open threads', () => {
      const ctx = compileContinuityContext({
        threadsResult: {
          ok: true,
          rows: [
            thread({ thread_id: 'a', status: 'open' }),
            thread({ thread_id: 'b', status: 'resolved' }),
            thread({ thread_id: 'c', status: 'abandoned' }),
          ],
        },
        promisesResult: { ok: true, rows: [] },
        nowMs: NOW,
      });
      expect(ctx.open_threads.map(t => t.thread_id)).toEqual(['a']);
    });

    it('sorts by last_mentioned_at DESC (newest first)', () => {
      const ctx = compileContinuityContext({
        threadsResult: {
          ok: true,
          rows: [
            thread({ thread_id: 'a', last_mentioned_at: '2026-05-09T00:00:00Z' }),
            thread({ thread_id: 'b', last_mentioned_at: '2026-05-11T00:00:00Z' }),
            thread({ thread_id: 'c', last_mentioned_at: '2026-05-10T00:00:00Z' }),
          ],
        },
        promisesResult: { ok: true, rows: [] },
        nowMs: NOW,
      });
      expect(ctx.open_threads.map(t => t.thread_id)).toEqual(['b', 'c', 'a']);
    });

    it('caps to openThreadLimit (default 5)', () => {
      const ctx = compileContinuityContext({
        threadsResult: {
          ok: true,
          rows: Array.from({ length: 12 }, (_, i) => thread({
            thread_id: 't' + i,
            last_mentioned_at: new Date(NOW - i * 1000).toISOString(),
          })),
        },
        promisesResult: { ok: true, rows: [] },
        nowMs: NOW,
      });
      expect(ctx.open_threads).toHaveLength(5);
    });

    it('respects custom openThreadLimit', () => {
      const ctx = compileContinuityContext({
        threadsResult: {
          ok: true,
          rows: [
            thread({ thread_id: 'a' }),
            thread({ thread_id: 'b' }),
            thread({ thread_id: 'c' }),
          ],
        },
        promisesResult: { ok: true, rows: [] },
        nowMs: NOW,
        openThreadLimit: 2,
      });
      expect(ctx.open_threads).toHaveLength(2);
    });

    it('computes days_since_last_mention from now', () => {
      const ctx = compileContinuityContext({
        threadsResult: {
          ok: true,
          rows: [
            thread({ thread_id: 'a', last_mentioned_at: new Date(NOW - 3 * DAY).toISOString() }),
          ],
        },
        promisesResult: { ok: true, rows: [] },
        nowMs: NOW,
      });
      expect(ctx.open_threads[0].days_since_last_mention).toBe(3);
    });
  });

  describe('promises owed', () => {
    it('returns only status=owed promises', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: [
            promise({ promise_id: 'a', status: 'owed' }),
            promise({ promise_id: 'b', status: 'kept', kept_at: '2026-05-11T00:00:00Z' }),
            promise({ promise_id: 'c', status: 'broken' }),
            promise({ promise_id: 'd', status: 'cancelled' }),
          ],
        },
        nowMs: NOW,
      });
      expect(ctx.promises_owed.map(p => p.promise_id)).toEqual(['a']);
    });

    it('sorts owed by due_at ASC (soonest first)', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: [
            promise({ promise_id: 'a', due_at: '2026-05-13T00:00:00Z' }),
            promise({ promise_id: 'b', due_at: '2026-05-11T00:00:00Z' }),
            promise({ promise_id: 'c', due_at: '2026-05-12T00:00:00Z' }),
          ],
        },
        nowMs: NOW,
      });
      expect(ctx.promises_owed.map(p => p.promise_id)).toEqual(['b', 'c', 'a']);
    });

    it('places null due_at AFTER any present due_at', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: [
            promise({ promise_id: 'a', due_at: null }),
            promise({ promise_id: 'b', due_at: '2026-05-15T00:00:00Z' }),
            promise({ promise_id: 'c', due_at: null }),
          ],
        },
        nowMs: NOW,
      });
      expect(ctx.promises_owed.map(p => p.promise_id)).toEqual(['b', 'a', 'c']);
    });

    it('computes days_overdue (positive when overdue)', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: [
            promise({ promise_id: 'a', due_at: new Date(NOW - 2 * DAY).toISOString() }),
          ],
        },
        nowMs: NOW,
      });
      expect(ctx.promises_owed[0].days_overdue).toBe(2);
    });

    it('returns negative days_overdue when due_at is in the future', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: [
            promise({ promise_id: 'a', due_at: new Date(NOW + 2 * DAY).toISOString() }),
          ],
        },
        nowMs: NOW,
      });
      expect(ctx.promises_owed[0].days_overdue).toBeLessThanOrEqual(0);
    });

    it('caps to promisesOwedLimit (default 5)', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: Array.from({ length: 10 }, (_, i) =>
            promise({ promise_id: 'p' + i, due_at: new Date(NOW + i * DAY).toISOString() }),
          ),
        },
        nowMs: NOW,
      });
      expect(ctx.promises_owed).toHaveLength(5);
    });
  });

  describe('promises kept recently', () => {
    it('returns only status=kept promises with kept_at in last 7 days', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: [
            promise({ promise_id: 'recent', status: 'kept', kept_at: new Date(NOW - 2 * DAY).toISOString() }),
            promise({ promise_id: 'old',    status: 'kept', kept_at: new Date(NOW - 30 * DAY).toISOString() }),
            promise({ promise_id: 'no_ts',  status: 'kept', kept_at: null }),
            promise({ promise_id: 'owed',   status: 'owed' }),
          ],
        },
        nowMs: NOW,
      });
      expect(ctx.promises_kept_recently.map(p => p.promise_id)).toEqual(['recent']);
    });

    it('sorts by kept_at DESC', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: [
            promise({ promise_id: 'a', status: 'kept', kept_at: new Date(NOW - 1 * DAY).toISOString() }),
            promise({ promise_id: 'b', status: 'kept', kept_at: new Date(NOW - 3 * DAY).toISOString() }),
            promise({ promise_id: 'c', status: 'kept', kept_at: new Date(NOW - 2 * DAY).toISOString() }),
          ],
        },
        nowMs: NOW,
      });
      expect(ctx.promises_kept_recently.map(p => p.promise_id)).toEqual(['a', 'c', 'b']);
    });

    it('caps to promisesKeptLimit (default 3)', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: Array.from({ length: 8 }, (_, i) =>
            promise({
              promise_id: 'k' + i,
              status: 'kept',
              kept_at: new Date(NOW - i * 60 * 1000).toISOString(),
            }),
          ),
        },
        nowMs: NOW,
      });
      expect(ctx.promises_kept_recently).toHaveLength(3);
    });
  });

  describe('counts', () => {
    it('open_threads_total counts all open threads (not just the capped surface)', () => {
      const ctx = compileContinuityContext({
        threadsResult: {
          ok: true,
          rows: Array.from({ length: 12 }, (_, i) => thread({ thread_id: 't' + i })),
        },
        promisesResult: { ok: true, rows: [] },
        nowMs: NOW,
        openThreadLimit: 3,
      });
      expect(ctx.counts.open_threads_total).toBe(12);
      expect(ctx.open_threads).toHaveLength(3);
    });

    it('promises_owed_total counts all owed (not just the surfaced 5)', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: Array.from({ length: 8 }, (_, i) => promise({ promise_id: 'p' + i })),
        },
        nowMs: NOW,
      });
      expect(ctx.counts.promises_owed_total).toBe(8);
    });

    it('promises_overdue counts owed promises with due_at < now', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: {
          ok: true,
          rows: [
            promise({ promise_id: 'a', due_at: new Date(NOW - 1 * DAY).toISOString() }),
            promise({ promise_id: 'b', due_at: new Date(NOW + 1 * DAY).toISOString() }),
            promise({ promise_id: 'c', due_at: new Date(NOW - 5 * DAY).toISOString() }),
            promise({ promise_id: 'd', due_at: null }),
          ],
        },
        nowMs: NOW,
      });
      expect(ctx.counts.promises_overdue).toBe(2);
    });

    it('threads_mentioned_today uses UTC day boundary', () => {
      // 2026-05-11T12:00:00Z → UTC day starts 2026-05-11T00:00:00Z.
      const ctx = compileContinuityContext({
        threadsResult: {
          ok: true,
          rows: [
            thread({ thread_id: 'today_early', last_mentioned_at: '2026-05-11T00:01:00Z' }),
            thread({ thread_id: 'today_late',  last_mentioned_at: '2026-05-11T11:59:00Z' }),
            thread({ thread_id: 'yesterday',   last_mentioned_at: '2026-05-10T23:59:00Z' }),
          ],
        },
        promisesResult: { ok: true, rows: [] },
        nowMs: NOW,
      });
      expect(ctx.counts.threads_mentioned_today).toBe(2);
    });
  });

  describe('source_health', () => {
    it('passes through ok:true when both fetches succeed', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: true, rows: [] },
        promisesResult: { ok: true, rows: [] },
        nowMs: NOW,
      });
      expect(ctx.source_health.user_open_threads.ok).toBe(true);
      expect(ctx.source_health.assistant_promises.ok).toBe(true);
    });

    it('reflects failure with reason when threads fetch failed', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: false, rows: [], reason: 'supabase_unconfigured' },
        promisesResult: { ok: true, rows: [] },
        nowMs: NOW,
      });
      expect(ctx.source_health.user_open_threads.ok).toBe(false);
      expect(ctx.source_health.user_open_threads.reason).toBe('supabase_unconfigured');
      expect(ctx.source_health.assistant_promises.ok).toBe(true);
    });

    it('treats !ok inputs as empty rows for surface arrays', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: false, rows: [], reason: 'boom' },
        promisesResult: { ok: false, rows: [], reason: 'boom' },
        nowMs: NOW,
      });
      expect(ctx.open_threads).toEqual([]);
      expect(ctx.promises_owed).toEqual([]);
      expect(ctx.promises_kept_recently).toEqual([]);
      expect(ctx.counts.open_threads_total).toBe(0);
    });

    it('defaults reason to "unknown_failure" when an !ok result omits one', () => {
      const ctx = compileContinuityContext({
        threadsResult: { ok: false, rows: [] },
        promisesResult: { ok: false, rows: [] },
        nowMs: NOW,
      });
      expect(ctx.source_health.user_open_threads.reason).toBe('unknown_failure');
      expect(ctx.source_health.assistant_promises.reason).toBe('unknown_failure');
    });
  });
});
