/**
 * VTID-02936 (B3) — compileConceptMasteryContext tests.
 *
 * Pure function. Verifies:
 *   - Repetition hint policy: first_time / one_liner / skip
 *   - Mastery overrides count: a mastered concept is always 'skip'
 *   - Sorting (most-recent first) + caps for all three surfaces
 *   - days_since_last_explained / days_since_last_seen math
 *   - concepts_explained_in_last_24h counting
 *   - source_health passes through from fetch result
 *   - !ok fetchResult is treated as empty arrays
 */

import { compileConceptMasteryContext, repetitionHint } from '../../../src/services/concept-mastery/compile-concept-mastery-context';
import type {
  ConceptExplainedRow,
  ConceptMasteryRow,
  DykCardSeenRow,
} from '../../../src/services/concept-mastery/types';

const NOW = Date.parse('2026-05-11T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function explained(over: Partial<ConceptExplainedRow>): ConceptExplainedRow {
  return {
    concept_key: 'vitana_index',
    count: 1,
    last_explained_at: '2026-05-11T00:00:00Z',
    source: null,
    ...over,
  };
}

function mastery(over: Partial<ConceptMasteryRow>): ConceptMasteryRow {
  return {
    concept_key: 'vitana_index',
    confidence: 0.8,
    last_observed_at: '2026-05-11T00:00:00Z',
    source: null,
    ...over,
  };
}

function dyk(over: Partial<DykCardSeenRow>): DykCardSeenRow {
  return {
    card_key: 'dyk_index_intro',
    count: 1,
    last_seen_at: '2026-05-11T00:00:00Z',
    ...over,
  };
}

describe('B3 — compileConceptMasteryContext', () => {
  describe('repetition hint', () => {
    it('first_time when count is 0 and no mastery', () => {
      expect(repetitionHint(0, false)).toBe('first_time');
    });

    it('one_liner when explained 1–2 times and no mastery', () => {
      expect(repetitionHint(1, false)).toBe('one_liner');
      expect(repetitionHint(2, false)).toBe('one_liner');
    });

    it('skip when explained 3+ times (over-explained)', () => {
      expect(repetitionHint(3, false)).toBe('skip');
      expect(repetitionHint(7, false)).toBe('skip');
    });

    it('skip when mastery is observed, regardless of count', () => {
      expect(repetitionHint(0, true)).toBe('skip');
      expect(repetitionHint(1, true)).toBe('skip');
      expect(repetitionHint(50, true)).toBe('skip');
    });
  });

  describe('concepts_explained surface', () => {
    it('sorts by last_explained_at DESC (newest first)', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: {
          ok: true,
          concepts_explained: [
            explained({ concept_key: 'a', last_explained_at: '2026-05-09T00:00:00Z' }),
            explained({ concept_key: 'b', last_explained_at: '2026-05-11T00:00:00Z' }),
            explained({ concept_key: 'c', last_explained_at: '2026-05-10T00:00:00Z' }),
          ],
          concepts_mastered: [],
          dyk_cards_seen: [],
        },
        nowMs: NOW,
      });
      expect(ctx.concepts_explained.map(c => c.concept_key)).toEqual(['b', 'c', 'a']);
    });

    it('caps to conceptsExplainedLimit (default 10)', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: {
          ok: true,
          concepts_explained: Array.from({ length: 15 }, (_, i) =>
            explained({
              concept_key: 'c' + i,
              last_explained_at: new Date(NOW - i * 1000).toISOString(),
            }),
          ),
          concepts_mastered: [],
          dyk_cards_seen: [],
        },
        nowMs: NOW,
      });
      expect(ctx.concepts_explained).toHaveLength(10);
    });

    it('computes days_since_last_explained from now', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: {
          ok: true,
          concepts_explained: [
            explained({ concept_key: 'x', last_explained_at: new Date(NOW - 3 * DAY).toISOString() }),
          ],
          concepts_mastered: [],
          dyk_cards_seen: [],
        },
        nowMs: NOW,
      });
      expect(ctx.concepts_explained[0].days_since_last_explained).toBe(3);
    });

    it('attaches repetition_hint reflecting count + mastery', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: {
          ok: true,
          concepts_explained: [
            explained({ concept_key: 'a', count: 1 }),
            explained({ concept_key: 'b', count: 5 }),
            explained({ concept_key: 'mastered_one', count: 1 }),
          ],
          concepts_mastered: [mastery({ concept_key: 'mastered_one' })],
          dyk_cards_seen: [],
        },
        nowMs: NOW,
      });
      const hintFor = (key: string) =>
        (ctx.concepts_explained.find(c => c.concept_key === key) || {} as any).repetition_hint;
      expect(hintFor('a')).toBe('one_liner');
      expect(hintFor('b')).toBe('skip');
      expect(hintFor('mastered_one')).toBe('skip');
    });
  });

  describe('concepts_mastered surface', () => {
    it('sorts by last_observed_at DESC + caps', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: {
          ok: true,
          concepts_explained: [],
          concepts_mastered: Array.from({ length: 12 }, (_, i) =>
            mastery({
              concept_key: 'm' + i,
              last_observed_at: new Date(NOW - i * 1000).toISOString(),
            }),
          ),
          dyk_cards_seen: [],
        },
        nowMs: NOW,
      });
      expect(ctx.concepts_mastered).toHaveLength(10);
      expect(ctx.concepts_mastered[0].concept_key).toBe('m0');
    });
  });

  describe('dyk_cards_seen surface', () => {
    it('sorts by last_seen_at DESC + caps + computes days_since_last_seen', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: {
          ok: true,
          concepts_explained: [],
          concepts_mastered: [],
          dyk_cards_seen: [
            dyk({ card_key: 'old',    last_seen_at: new Date(NOW - 5 * DAY).toISOString() }),
            dyk({ card_key: 'recent', last_seen_at: new Date(NOW - 1 * DAY).toISOString() }),
          ],
        },
        nowMs: NOW,
      });
      expect(ctx.dyk_cards_seen.map(c => c.card_key)).toEqual(['recent', 'old']);
      expect(ctx.dyk_cards_seen[0].days_since_last_seen).toBe(1);
      expect(ctx.dyk_cards_seen[1].days_since_last_seen).toBe(5);
    });
  });

  describe('counts', () => {
    it('totals reflect raw rows, not the capped surfaces', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: {
          ok: true,
          concepts_explained: Array.from({ length: 15 }, (_, i) => explained({ concept_key: 'e' + i })),
          concepts_mastered: Array.from({ length: 12 }, (_, i) => mastery({ concept_key: 'm' + i })),
          dyk_cards_seen: Array.from({ length: 14 }, (_, i) => dyk({ card_key: 'd' + i })),
        },
        nowMs: NOW,
      });
      expect(ctx.counts.concepts_explained_total).toBe(15);
      expect(ctx.counts.concepts_mastered_total).toBe(12);
      expect(ctx.counts.dyk_cards_seen_total).toBe(14);
    });

    it('concepts_explained_in_last_24h counts only recent rows', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: {
          ok: true,
          concepts_explained: [
            explained({ concept_key: 'fresh',  last_explained_at: new Date(NOW - 2 * HOUR).toISOString() }),
            explained({ concept_key: 'edge',   last_explained_at: new Date(NOW - 23 * HOUR).toISOString() }),
            explained({ concept_key: 'old',    last_explained_at: new Date(NOW - 48 * HOUR).toISOString() }),
            explained({ concept_key: 'future', last_explained_at: new Date(NOW + 1 * HOUR).toISOString() }),
          ],
          concepts_mastered: [],
          dyk_cards_seen: [],
        },
        nowMs: NOW,
      });
      // fresh + edge + future (future has |now-then| <= 24h since (now - then) is negative but
      // the check is `now - t <= 24h` — future passes only if now-t <= 24h which is true (-1h <= 24h).
      expect(ctx.counts.concepts_explained_in_last_24h).toBe(3);
    });
  });

  describe('source_health', () => {
    it('passes through ok:true on successful fetch', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: { ok: true, concepts_explained: [], concepts_mastered: [], dyk_cards_seen: [] },
        nowMs: NOW,
      });
      expect(ctx.source_health.user_assistant_state.ok).toBe(true);
    });

    it('reflects failure with reason', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: {
          ok: false,
          concepts_explained: [],
          concepts_mastered: [],
          dyk_cards_seen: [],
          reason: 'supabase_unconfigured',
        },
        nowMs: NOW,
      });
      expect(ctx.source_health.user_assistant_state.ok).toBe(false);
      expect(ctx.source_health.user_assistant_state.reason).toBe('supabase_unconfigured');
    });

    it('treats !ok inputs as empty for all surfaces + counts', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: {
          ok: false,
          concepts_explained: [explained({})],
          concepts_mastered: [mastery({})],
          dyk_cards_seen: [dyk({})],
          reason: 'boom',
        },
        nowMs: NOW,
      });
      expect(ctx.concepts_explained).toEqual([]);
      expect(ctx.concepts_mastered).toEqual([]);
      expect(ctx.dyk_cards_seen).toEqual([]);
      expect(ctx.counts.concepts_explained_total).toBe(0);
    });

    it('defaults reason to "unknown_failure" when an !ok result omits one', () => {
      const ctx = compileConceptMasteryContext({
        fetchResult: { ok: false, concepts_explained: [], concepts_mastered: [], dyk_cards_seen: [] },
        nowMs: NOW,
      });
      expect(ctx.source_health.user_assistant_state.reason).toBe('unknown_failure');
    });
  });
});
