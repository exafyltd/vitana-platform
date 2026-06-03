/**
 * Shadow ground-truth scoring — Phase 1 (BOOTSTRAP-SHADOW-CORPUS-ACCURACY).
 *
 * The shadow harness (llm-router-shadow.ts) records, per comparison, what the
 * primary and candidate models each produced. Until now the only signal was
 * primary↔candidate *agreement* — "did the two models pick the same tool?"
 * Agreement says nothing about whether either was *right*: two models can
 * agree on the wrong tool.
 *
 * When the input is a LABELED golden-corpus turn we also know the
 * ground-truth answer (`expected_tool`). This module scores each model
 * against that label and rolls per-event correctness into a feature-level
 * ACCURACY — the number the canary-readiness gate actually needs before
 * graduating a candidate to live traffic.
 *
 * Pure + dependency-free so it's shared by both the shadow primitive (scoring
 * one comparison) and the staging aggregator (rolling many up), and unit-
 * tested directly without express / supabase / network.
 */

export interface GroundTruthScore {
  /** The labeled correct key, or null when the turn is unlabeled. */
  expected_key: string | null;
  /** primary === expected. null when there's no label or no primary key. */
  primary_correct: boolean | null;
  /** candidate === expected. null when there's no label, or the candidate errored / produced no key. */
  candidate_correct: boolean | null;
}

/**
 * Score one shadow comparison against a ground-truth key. Returns all-null
 * correctness when no `expectedKey` is supplied, so unlabeled shadow traffic
 * (the common case) is unaffected and carries no accuracy fields.
 */
export function scoreGroundTruth(
  expectedKey: string | null | undefined,
  primaryKey: string | null | undefined,
  candidateKey: string | null | undefined,
): GroundTruthScore {
  const expected = expectedKey != null ? expectedKey : null;
  if (expected === null) {
    return { expected_key: null, primary_correct: null, candidate_correct: null };
  }
  return {
    expected_key: expected,
    primary_correct: primaryKey != null ? primaryKey === expected : null,
    candidate_correct: candidateKey != null ? candidateKey === expected : null,
  };
}

export interface AccuracyRollup {
  /** Events that carried a boolean primary_correct (i.e. labeled comparisons). */
  labeled_comparisons: number;
  /** Share of labeled comparisons where primary matched ground truth. null when none. */
  primary_accuracy: number | null;
  /** Share of labeled comparisons (with a non-null candidate_correct) where the candidate matched. null when none. */
  candidate_accuracy: number | null;
}

/** Minimal row shape — just the two correctness flags from event metadata. */
export interface ScoredRow {
  primary_correct?: unknown;
  candidate_correct?: unknown;
}

/**
 * Roll a set of scored events into a feature-level accuracy. Rows without a
 * boolean `primary_correct` are ignored (unlabeled shadow traffic), so this is
 * safe to run over a mixed stream of labeled + unlabeled comparisons.
 */
export function accuracyRollup(rows: ScoredRow[]): AccuracyRollup {
  let labeled = 0;
  let primaryHits = 0;
  let candidateLabeled = 0;
  let candidateHits = 0;

  for (const r of rows) {
    if (typeof r.primary_correct === 'boolean') {
      labeled++;
      if (r.primary_correct) primaryHits++;
    }
    if (typeof r.candidate_correct === 'boolean') {
      candidateLabeled++;
      if (r.candidate_correct) candidateHits++;
    }
  }

  return {
    labeled_comparisons: labeled,
    primary_accuracy: labeled > 0 ? primaryHits / labeled : null,
    candidate_accuracy: candidateLabeled > 0 ? candidateHits / candidateLabeled : null,
  };
}
