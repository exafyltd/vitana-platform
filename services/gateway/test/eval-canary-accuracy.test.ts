/**
 * Canary readiness — ground-truth accuracy gate (BOOTSTRAP-SHADOW-CORPUS-ACCURACY).
 *
 * The canary-readiness report graduates a candidate model only when the
 * evidence says it's actually RIGHT, not merely that it AGREES with the
 * primary. This pins the accuracy rule: insufficient labeled evidence blocks,
 * a below-floor candidate blocks, a regression vs primary blocks, and a strong
 * candidate over enough labeled turns passes.
 */
process.env.NODE_ENV = 'test';

import { accuracyReason } from '../scripts/eval/canary-readiness-report';

describe('canary readiness — candidate_accuracy gate', () => {
  test('blocks when there are too few corpus-grounded comparisons', () => {
    const r = accuracyReason({ labeled_comparisons: 10, primary_accuracy: 1, candidate_accuracy: 0.95 });
    expect(r.rule).toBe('candidate_accuracy');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/corpus-grounded comparisons/);
  });

  test('blocks when candidate has no labeled accuracy at all (null)', () => {
    const r = accuracyReason({ labeled_comparisons: 80, primary_accuracy: 0.9, candidate_accuracy: null });
    expect(r.ok).toBe(false);
  });

  test('blocks a below-floor candidate', () => {
    const r = accuracyReason({ labeled_comparisons: 80, primary_accuracy: 0.95, candidate_accuracy: 0.80 });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/floor/);
  });

  test('blocks a candidate that regresses materially below primary', () => {
    // candidate 0.88 is above the 0.85 floor but >5pp below primary 0.97
    const r = accuracyReason({ labeled_comparisons: 80, primary_accuracy: 0.97, candidate_accuracy: 0.88 });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/regress/);
  });

  test('passes a strong candidate over enough labeled turns', () => {
    const r = accuracyReason({ labeled_comparisons: 60, primary_accuracy: 0.90, candidate_accuracy: 0.92 });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/92.0%/);
  });

  test('passes when candidate meets the floor and primary is unknown', () => {
    const r = accuracyReason({ labeled_comparisons: 60, primary_accuracy: null, candidate_accuracy: 0.86 });
    expect(r.ok).toBe(true);
  });

  test('null rollup blocks (no shadow feature data)', () => {
    expect(accuracyReason(null).ok).toBe(false);
  });

  test('a candidate exactly at the floor passes', () => {
    const r = accuracyReason({ labeled_comparisons: 50, primary_accuracy: 0.85, candidate_accuracy: 0.85 });
    expect(r.ok).toBe(true);
  });
});
