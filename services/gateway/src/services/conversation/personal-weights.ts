/**
 * VTID-04435 (Plan v1 WS-4.3) — outcomes feed the scoring, per user, within
 * fixed limits.
 *
 * The shared weights (`conversation_scoring_weights`, VTID-04422) are the same
 * for everyone. This derives a per-user copy from that user's own settled
 * offers (`conversation_offer_outcomes`, VTID-04421) and changes only two
 * weights, each inside a fixed band:
 *
 *   outcome    x0.5 .. x2.0   Up when the user's acceptance differs a lot
 *                             between providers (their history tells us which
 *                             kinds of suggestion they take); down when it is
 *                             flat (the outcome feature says nothing for them).
 *   freshness  x1.0 .. x1.5   Up when the user ignores many offers — repetition
 *                             fatigue — so fresh candidates count for more.
 *
 * Nothing changes below MIN_EVIDENCE settled offers, and the adjustment grows
 * linearly to its full size at FULL_EVIDENCE. Every other weight is untouched.
 * Pure: no I/O, no clock.
 */

import type { ScoringWeights } from './candidate-scoring';

export const PERSONAL_WEIGHT_LIMITS = {
  minEvidence: 5,
  fullEvidence: 30,
  /** A provider needs this many settled offers to count toward the spread. */
  minProviderSettled: 2,
  outcomeMultMin: 0.5,
  outcomeMultMax: 2,
  freshnessMultMin: 1,
  freshnessMultMax: 1.5,
  /** Ignored share at which freshness starts to rise, and where it is full. */
  ignoredFloor: 0.3,
  ignoredCeil: 0.8,
} as const;

export interface UserOutcomeCounts {
  accepted: number;
  settled: number;
  declined?: number;
  ignored?: number;
}

export interface PersonalAdjustment {
  applied: boolean;
  evidence: number;
  confidence: number;
  spread: number | null;
  ignored_share: number | null;
  outcome_mult: number;
  freshness_mult: number;
}

const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Whether the live turn ranking (get_next_best_action) uses the personal copy. */
export function isPersonalWeightsLive(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAIN_PERSONAL_WEIGHTS === 'true';
}

export function personalAdjustment(outcomes: Record<string, UserOutcomeCounts> | null | undefined): PersonalAdjustment {
  const L = PERSONAL_WEIGHT_LIMITS;
  const rows = Object.values(outcomes ?? {}).filter((o) => o && Number.isFinite(o.settled) && o.settled > 0);
  const evidence = rows.reduce((s, o) => s + Math.max(0, o.settled), 0);
  const none: PersonalAdjustment = {
    applied: false, evidence, confidence: 0, spread: null, ignored_share: null, outcome_mult: 1, freshness_mult: 1,
  };
  if (evidence < L.minEvidence) return none;

  const confidence = clamp((evidence - L.minEvidence) / (L.fullEvidence - L.minEvidence), 0, 1);

  const rates = rows
    .filter((o) => o.settled >= L.minProviderSettled)
    .map((o) => (Math.max(0, o.accepted) + 1) / (o.settled + 2));
  const spread = rates.length >= 2 ? Math.max(...rates) - Math.min(...rates) : null;
  // No spread measurable (one provider only): leave the outcome weight alone.
  const outcomeMult = spread === null
    ? 1
    : clamp(1 + confidence * (2 * spread - 0.5), L.outcomeMultMin, L.outcomeMultMax);

  const withIgnored = rows.filter((o) => typeof o.ignored === 'number');
  const ignoredShare = withIgnored.length
    ? withIgnored.reduce((s, o) => s + Math.max(0, o.ignored as number), 0) / Math.max(1, withIgnored.reduce((s, o) => s + o.settled, 0))
    : null;
  const fatigue = ignoredShare === null ? 0 : clamp((ignoredShare - L.ignoredFloor) / (L.ignoredCeil - L.ignoredFloor), 0, 1);
  const freshnessMult = clamp(1 + confidence * fatigue * (L.freshnessMultMax - 1), L.freshnessMultMin, L.freshnessMultMax);

  return {
    applied: outcomeMult !== 1 || freshnessMult !== 1,
    evidence,
    confidence: round3(confidence),
    spread: spread === null ? null : round3(spread),
    ignored_share: ignoredShare === null ? null : round3(ignoredShare),
    outcome_mult: round3(outcomeMult),
    freshness_mult: round3(freshnessMult),
  };
}

/** The user's copy of the shared weights. The shared object is never mutated. */
export function personalizeWeights(
  base: ScoringWeights,
  outcomes: Record<string, UserOutcomeCounts> | null | undefined,
): { weights: ScoringWeights; adjustment: PersonalAdjustment } {
  const adjustment = personalAdjustment(outcomes);
  if (!adjustment.applied) return { weights: base, adjustment };
  return {
    weights: {
      ...base,
      weights: {
        ...base.weights,
        outcome: round3(base.weights.outcome * adjustment.outcome_mult),
        freshness: round3(base.weights.freshness * adjustment.freshness_mult),
      },
    },
    adjustment,
  };
}
