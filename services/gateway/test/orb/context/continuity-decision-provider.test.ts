/**
 * VTID-02941 (B0b-min) — continuity-decision-provider adapter tests.
 *
 * Acceptance #2: continuity data is distilled (allowed: counts, short
 * labels, due/overdue flags, recommended follow-up kind, source
 * health). Forbidden: raw messages, raw promises, raw memory rows,
 * raw profile payloads.
 *
 * The adapter MUST:
 *   - drop raw timestamps in favor of booleans/short hints
 *   - truncate long strings (topic / summary / promise_text)
 *   - keep IDs (thread_id / promise_id / decision_id) for reference
 *   - never surface kept_at / due_at / last_mentioned_at / resolved_at
 */

import {
  distillContinuityForDecision,
  pickRecommendedFollowUp,
  truncate,
} from '../../../src/orb/context/providers/continuity-decision-provider';
import type { ContinuityContext } from '../../../src/services/continuity/types';

function makeContext(over: Partial<ContinuityContext> = {}): ContinuityContext {
  return {
    open_threads: [],
    promises_owed: [],
    promises_kept_recently: [],
    counts: {
      open_threads_total: 0,
      promises_owed_total: 0,
      promises_overdue: 0,
      threads_mentioned_today: 0,
    },
    source_health: {
      user_open_threads: { ok: true },
      assistant_promises: { ok: true },
    },
    ...over,
  };
}

describe('B0b-min — distillContinuityForDecision', () => {
  describe('forbidden raw fields are NOT surfaced', () => {
    it('drops last_mentioned_at, resolved_at, created_at, updated_at on threads', () => {
      const ctx = makeContext({
        open_threads: [
          {
            thread_id: 't1',
            topic: 'magnesium',
            summary: 'follow-up',
            last_mentioned_at: '2026-05-10T12:00:00Z',
            days_since_last_mention: 3,
          },
        ],
      });
      const out = distillContinuityForDecision({ continuity: ctx });
      expect(out.open_threads[0]).toEqual({
        thread_id: 't1',
        topic: 'magnesium',
        summary: 'follow-up',
        days_since_last_mention: 3,
      });
      const keys = Object.keys(out.open_threads[0]).sort();
      expect(keys).toEqual([
        'days_since_last_mention',
        'summary',
        'thread_id',
        'topic',
      ]);
    });

    it('drops due_at, days_overdue, kept_at on promises (overdue becomes a boolean)', () => {
      const ctx = makeContext({
        promises_owed: [
          {
            promise_id: 'p1',
            promise_text: 'remind me at 8pm',
            due_at: '2026-05-10T20:00:00Z',
            days_overdue: 2,
            decision_id: 'd1',
          },
        ],
      });
      const out = distillContinuityForDecision({ continuity: ctx });
      expect(out.promises_owed[0]).toEqual({
        promise_id: 'p1',
        promise_text: 'remind me at 8pm',
        overdue: true,
        decision_id: 'd1',
      });
      const keys = Object.keys(out.promises_owed[0]).sort();
      expect(keys).toEqual(['decision_id', 'overdue', 'promise_id', 'promise_text']);
    });

    it('drops kept_at on promises_kept_recently', () => {
      const ctx = makeContext({
        promises_kept_recently: [
          {
            promise_id: 'k1',
            promise_text: 'sent that doc',
            kept_at: '2026-05-09T10:00:00Z',
          },
        ],
      });
      const out = distillContinuityForDecision({ continuity: ctx });
      expect(out.promises_kept_recently[0]).toEqual({
        promise_id: 'k1',
        promise_text: 'sent that doc',
      });
      const keys = Object.keys(out.promises_kept_recently[0]).sort();
      expect(keys).toEqual(['promise_id', 'promise_text']);
    });
  });

  describe('overdue boolean', () => {
    it('true when days_overdue > 0', () => {
      const out = distillContinuityForDecision({
        continuity: makeContext({
          promises_owed: [
            { promise_id: 'p', promise_text: 't', due_at: null, days_overdue: 5, decision_id: null },
          ],
        }),
      });
      expect(out.promises_owed[0].overdue).toBe(true);
    });

    it('false when days_overdue is null', () => {
      const out = distillContinuityForDecision({
        continuity: makeContext({
          promises_owed: [
            { promise_id: 'p', promise_text: 't', due_at: null, days_overdue: null, decision_id: null },
          ],
        }),
      });
      expect(out.promises_owed[0].overdue).toBe(false);
    });

    it('false when days_overdue is negative (future-due)', () => {
      const out = distillContinuityForDecision({
        continuity: makeContext({
          promises_owed: [
            { promise_id: 'p', promise_text: 't', due_at: null, days_overdue: -2, decision_id: null },
          ],
        }),
      });
      expect(out.promises_owed[0].overdue).toBe(false);
    });
  });

  describe('truncation', () => {
    it('truncates long topics to 60 chars', () => {
      const long = 'a'.repeat(200);
      const out = distillContinuityForDecision({
        continuity: makeContext({
          open_threads: [
            { thread_id: 't', topic: long, summary: null, last_mentioned_at: '', days_since_last_mention: 0 },
          ],
        }),
      });
      expect(out.open_threads[0].topic.length).toBeLessThanOrEqual(60);
      expect(out.open_threads[0].topic.endsWith('…')).toBe(true);
    });

    it('truncates long summaries to 120 chars', () => {
      const long = 'b'.repeat(500);
      const out = distillContinuityForDecision({
        continuity: makeContext({
          open_threads: [
            { thread_id: 't', topic: 'x', summary: long, last_mentioned_at: '', days_since_last_mention: 0 },
          ],
        }),
      });
      expect((out.open_threads[0].summary ?? '').length).toBeLessThanOrEqual(120);
    });

    it('truncates long promise_text to 120 chars', () => {
      const long = 'c'.repeat(500);
      const out = distillContinuityForDecision({
        continuity: makeContext({
          promises_owed: [
            { promise_id: 'p', promise_text: long, due_at: null, days_overdue: null, decision_id: null },
          ],
        }),
      });
      expect(out.promises_owed[0].promise_text.length).toBeLessThanOrEqual(120);
    });

    it('truncate helper preserves short strings byte-for-byte', () => {
      expect(truncate('abc', 60)).toBe('abc');
      expect(truncate('exactly_60_chars_______________________________________exact', 60)).toBe(
        'exactly_60_chars_______________________________________exact',
      );
    });
  });

  describe('pickRecommendedFollowUp priority', () => {
    it('overdue beats kept beats threads beats none', () => {
      expect(pickRecommendedFollowUp({ overdue: 1, owed: 1, keptRecently: 1, openThreads: 1 })).toBe('address_overdue_promise');
      expect(pickRecommendedFollowUp({ overdue: 0, owed: 0, keptRecently: 1, openThreads: 1 })).toBe('acknowledge_kept_promise');
      expect(pickRecommendedFollowUp({ overdue: 0, owed: 0, keptRecently: 0, openThreads: 1 })).toBe('mention_open_thread');
      expect(pickRecommendedFollowUp({ overdue: 0, owed: 0, keptRecently: 0, openThreads: 0 })).toBe('none');
    });
  });
});
