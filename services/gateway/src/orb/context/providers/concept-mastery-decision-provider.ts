/**
 * VTID-02950 (F2) — ConceptMastery → AssistantDecisionContext adapter.
 *
 * The B3 read-only inspection slice already produced
 * `ConceptMasteryContext`, a richer shape designed for the Command Hub
 * operator. The assistant decision layer reads a NARROWER shape
 * (`DecisionConceptMastery`) that strips:
 *   - raw last_explained_at / last_observed_at / last_seen_at timestamps
 *   - raw 0..1 confidence floats (bucketed to low / medium / high)
 *   - raw integer counts (bucketed via FrequencyBucket)
 *
 * Kept: stable identifiers (concept_key, card_key) so the LLM can
 * refer back, plus pre-derived RepetitionHint and days_since_*
 * recency hints.
 *
 * Pure function. No IO. The caller is responsible for invoking the
 * concept-mastery compiler + passing its output here.
 */

import type { ConceptMasteryContext } from '../../../services/concept-mastery/types';
import type {
  DecisionConceptMastery,
  FrequencyBucket,
  MasteryConfidenceBucket,
} from '../types';

export interface DistillConceptMasteryInputs {
  /**
   * Output of `compileConceptMasteryContext` from B3. Read-only.
   */
  conceptMastery: ConceptMasteryContext;
}

/**
 * Distills `ConceptMasteryContext` into the decision-grade
 * `DecisionConceptMastery`.
 *
 * Always returns a typed shape (never undefined). The caller decides
 * whether to attach it to `AssistantDecisionContext.concept_mastery` or
 * set the field to `null` based on source health.
 */
export function distillConceptMasteryForDecision(
  input: DistillConceptMasteryInputs,
): DecisionConceptMastery {
  const { conceptMastery } = input;

  const concepts_explained = conceptMastery.concepts_explained.map((c) => ({
    concept_key: c.concept_key,
    frequency: bucketFrequency(c.count),
    days_since_last_explained: c.days_since_last_explained,
    repetition_hint: c.repetition_hint,
  }));

  const concepts_mastered = conceptMastery.concepts_mastered.map((c) => ({
    concept_key: c.concept_key,
    confidence: bucketMasteryConfidence(c.confidence),
  }));

  const dyk_cards_seen = conceptMastery.dyk_cards_seen.map((d) => ({
    card_key: d.card_key,
    frequency: bucketFrequency(d.count),
    days_since_last_seen: d.days_since_last_seen,
  }));

  const counts = {
    concepts_explained_total: conceptMastery.counts.concepts_explained_total,
    concepts_mastered_total: conceptMastery.counts.concepts_mastered_total,
    dyk_cards_seen_total: conceptMastery.counts.dyk_cards_seen_total,
    concepts_explained_in_last_24h:
      conceptMastery.counts.concepts_explained_in_last_24h,
  };

  const recommended_cadence = pickRecommendedCadence(concepts_explained);

  return {
    concepts_explained,
    concepts_mastered,
    dyk_cards_seen,
    counts,
    recommended_cadence,
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Buckets a raw integer count into a coarse frequency band. The LLM
 * doesn't need to know "5 times" vs "8 times" — only the band that
 * drives cadence policy.
 */
export function bucketFrequency(count: number): FrequencyBucket {
  if (!Number.isFinite(count) || count <= 0) return 'none';
  if (count === 1) return 'once';
  if (count === 2) return 'twice';
  return 'many';
}

/**
 * Buckets a raw 0..1 confidence float into a coarse band. The LLM
 * doesn't need to know "0.72" vs "0.81" — only "high" vs "medium".
 */
export function bucketMasteryConfidence(
  confidence: number | null,
): MasteryConfidenceBucket | 'unknown' {
  if (confidence === null || !Number.isFinite(confidence)) return 'unknown';
  if (confidence < 0.4) return 'low';
  if (confidence < 0.7) return 'medium';
  return 'high';
}

/**
 * Picks the single recommended cadence action from the distilled set
 * of explained concepts.
 *
 * Priority: suppress_over_explained > use_one_liner > introduce_fresh > none.
 */
export function pickRecommendedCadence(
  concepts_explained: ReadonlyArray<{ repetition_hint: 'first_time' | 'one_liner' | 'skip' }>,
): DecisionConceptMastery['recommended_cadence'] {
  if (concepts_explained.length === 0) return 'none';
  const hints = concepts_explained.map((c) => c.repetition_hint);
  if (hints.includes('skip')) return 'suppress_over_explained';
  if (hints.includes('one_liner')) return 'use_one_liner';
  if (hints.every((h) => h === 'first_time')) return 'introduce_fresh';
  return 'none';
}
