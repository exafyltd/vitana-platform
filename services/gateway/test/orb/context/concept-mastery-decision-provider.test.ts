/**
 * VTID-02950 (F2) — concept-mastery-decision-provider adapter tests.
 *
 * Wall: the adapter MUST distill to decision-grade fields and drop:
 *   - raw last_explained_at / last_observed_at / last_seen_at timestamps
 *   - raw 0..1 confidence floats (must bucket to low/medium/high/unknown)
 *   - raw integer counts (must bucket to none/once/twice/many)
 * Kept: stable identifiers (concept_key, card_key), recency hints
 * (days_since_*), and the pre-derived RepetitionHint.
 */

import {
  bucketFrequency,
  bucketMasteryConfidence,
  distillConceptMasteryForDecision,
  pickRecommendedCadence,
} from '../../../src/orb/context/providers/concept-mastery-decision-provider';
import type { ConceptMasteryContext } from '../../../src/services/concept-mastery/types';

function makeContext(over: Partial<ConceptMasteryContext> = {}): ConceptMasteryContext {
  return {
    concepts_explained: [],
    concepts_mastered: [],
    dyk_cards_seen: [],
    counts: {
      concepts_explained_total: 0,
      concepts_mastered_total: 0,
      dyk_cards_seen_total: 0,
      concepts_explained_in_last_24h: 0,
    },
    source_health: {
      user_assistant_state: { ok: true },
    },
    ...over,
  };
}

describe('F2 — distillConceptMasteryForDecision', () => {
  describe('forbidden raw fields are NOT surfaced', () => {
    it('drops last_explained_at from concepts_explained', () => {
      const out = distillConceptMasteryForDecision({
        conceptMastery: makeContext({
          concepts_explained: [{
            concept_key: 'vitana_index',
            count: 2,
            last_explained_at: '2026-05-12T12:00:00Z',
            days_since_last_explained: 1,
            repetition_hint: 'one_liner',
          }],
        }),
      });
      const keys = Object.keys(out.concepts_explained[0]).sort();
      expect(keys).toEqual([
        'concept_key',
        'days_since_last_explained',
        'frequency',
        'repetition_hint',
      ]);
      // count is replaced by frequency bucket
      expect((out.concepts_explained[0] as any).count).toBeUndefined();
      expect((out.concepts_explained[0] as any).last_explained_at).toBeUndefined();
    });

    it('drops last_observed_at + raw confidence float from concepts_mastered', () => {
      const out = distillConceptMasteryForDecision({
        conceptMastery: makeContext({
          concepts_mastered: [{
            concept_key: 'vitana_index',
            confidence: 0.85,
            last_observed_at: '2026-05-12T08:00:00Z',
            source: 'inferred',
          }],
        }),
      });
      const keys = Object.keys(out.concepts_mastered[0]).sort();
      expect(keys).toEqual(['concept_key', 'confidence']);
      expect((out.concepts_mastered[0] as any).last_observed_at).toBeUndefined();
      expect((out.concepts_mastered[0] as any).source).toBeUndefined();
      // confidence is a bucket string, never a float
      expect(typeof out.concepts_mastered[0].confidence).toBe('string');
    });

    it('drops last_seen_at from dyk_cards_seen', () => {
      const out = distillConceptMasteryForDecision({
        conceptMastery: makeContext({
          dyk_cards_seen: [{
            card_key: 'dyk_index_intro',
            count: 3,
            last_seen_at: '2026-05-10T20:00:00Z',
            days_since_last_seen: 2,
          }],
        }),
      });
      const keys = Object.keys(out.dyk_cards_seen[0]).sort();
      expect(keys).toEqual(['card_key', 'days_since_last_seen', 'frequency']);
      expect((out.dyk_cards_seen[0] as any).last_seen_at).toBeUndefined();
      expect((out.dyk_cards_seen[0] as any).count).toBeUndefined();
    });
  });

  describe('bucketFrequency', () => {
    it('0 / negative → none', () => {
      expect(bucketFrequency(0)).toBe('none');
      expect(bucketFrequency(-5)).toBe('none');
      expect(bucketFrequency(NaN)).toBe('none');
    });

    it('1 → once', () => {
      expect(bucketFrequency(1)).toBe('once');
    });

    it('2 → twice', () => {
      expect(bucketFrequency(2)).toBe('twice');
    });

    it('3+ → many', () => {
      expect(bucketFrequency(3)).toBe('many');
      expect(bucketFrequency(50)).toBe('many');
    });
  });

  describe('bucketMasteryConfidence', () => {
    it('null / NaN → unknown', () => {
      expect(bucketMasteryConfidence(null)).toBe('unknown');
      expect(bucketMasteryConfidence(NaN)).toBe('unknown');
    });

    it.each([
      [0,    'low'],
      [0.39, 'low'],
      [0.4,  'medium'],
      [0.69, 'medium'],
      [0.7,  'high'],
      [1,    'high'],
    ])('%f → %s', (c, expected) => {
      expect(bucketMasteryConfidence(c)).toBe(expected);
    });
  });

  describe('pickRecommendedCadence priority', () => {
    it('empty → none', () => {
      expect(pickRecommendedCadence([])).toBe('none');
    });

    it('any "skip" → suppress_over_explained', () => {
      expect(pickRecommendedCadence([
        { repetition_hint: 'first_time' },
        { repetition_hint: 'skip' },
        { repetition_hint: 'one_liner' },
      ])).toBe('suppress_over_explained');
    });

    it('any "one_liner" + no "skip" → use_one_liner', () => {
      expect(pickRecommendedCadence([
        { repetition_hint: 'first_time' },
        { repetition_hint: 'one_liner' },
      ])).toBe('use_one_liner');
    });

    it('all "first_time" → introduce_fresh', () => {
      expect(pickRecommendedCadence([
        { repetition_hint: 'first_time' },
        { repetition_hint: 'first_time' },
      ])).toBe('introduce_fresh');
    });
  });

  describe('counts pass through (totals, not raw rows)', () => {
    it('preserves the four aggregate counts', () => {
      const out = distillConceptMasteryForDecision({
        conceptMastery: makeContext({
          counts: {
            concepts_explained_total: 12,
            concepts_mastered_total: 3,
            dyk_cards_seen_total: 7,
            concepts_explained_in_last_24h: 2,
          },
        }),
      });
      expect(out.counts).toEqual({
        concepts_explained_total: 12,
        concepts_mastered_total: 3,
        dyk_cards_seen_total: 7,
        concepts_explained_in_last_24h: 2,
      });
    });
  });
});
