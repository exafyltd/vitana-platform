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

import {
  accuracyReason,
  computeConsecutiveCleanDays,
  prevUtcDay,
} from '../scripts/eval/canary-readiness-report';

describe('canary readiness — candidate_accuracy gate', () => {
  test('blocks when there are too few corpus-grounded comparisons', () => {
    const r = accuracyReason({ real_labeled_comparisons: 10, real_primary_accuracy: 1, real_candidate_accuracy: 0.95 });
    expect(r.rule).toBe('candidate_accuracy');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/corpus-grounded comparisons/);
  });

  test('blocks when candidate has no labeled accuracy at all (null)', () => {
    const r = accuracyReason({ real_labeled_comparisons: 80, real_primary_accuracy: 0.9, real_candidate_accuracy: null });
    expect(r.ok).toBe(false);
  });

  test('blocks a below-floor candidate', () => {
    const r = accuracyReason({ real_labeled_comparisons: 80, real_primary_accuracy: 0.95, real_candidate_accuracy: 0.80 });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/floor/);
  });

  test('blocks a candidate that regresses materially below primary', () => {
    // candidate 0.88 is above the 0.85 floor but >5pp below primary 0.97
    const r = accuracyReason({ real_labeled_comparisons: 80, real_primary_accuracy: 0.97, real_candidate_accuracy: 0.88 });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/regress/);
  });

  test('passes a strong candidate over enough labeled turns', () => {
    const r = accuracyReason({ real_labeled_comparisons: 60, real_primary_accuracy: 0.90, real_candidate_accuracy: 0.92 });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/92.0%/);
  });

  test('passes when candidate meets the floor and primary is unknown', () => {
    const r = accuracyReason({ real_labeled_comparisons: 60, real_primary_accuracy: null, real_candidate_accuracy: 0.86 });
    expect(r.ok).toBe(true);
  });

  test('null rollup blocks (no shadow feature data)', () => {
    expect(accuracyReason(null).ok).toBe(false);
  });

  test('a candidate exactly at the floor passes', () => {
    const r = accuracyReason({ real_labeled_comparisons: 50, real_primary_accuracy: 0.85, real_candidate_accuracy: 0.85 });
    expect(r.ok).toBe(true);
  });
});

describe('consecutive_clean_days streak (G5b)', () => {
  test('prevUtcDay steps back one day, across month/year boundaries', () => {
    expect(prevUtcDay('2026-06-04')).toBe('2026-06-03');
    expect(prevUtcDay('2026-06-01')).toBe('2026-05-31');
    expect(prevUtcDay('2026-01-01')).toBe('2025-12-31');
  });

  test('today not clean → streak 0 regardless of history', () => {
    const hist = [{ date: '2026-06-03', clean: true }, { date: '2026-06-02', clean: true }];
    expect(computeConsecutiveCleanDays(hist, false, '2026-06-04')).toBe(0);
  });

  test('today clean, no history → 1', () => {
    expect(computeConsecutiveCleanDays([], true, '2026-06-04')).toBe(1);
  });

  test('today + two prior clean days → 3', () => {
    const hist = [{ date: '2026-06-03', clean: true }, { date: '2026-06-02', clean: true }];
    expect(computeConsecutiveCleanDays(hist, true, '2026-06-04')).toBe(3);
  });

  test('a missing calendar day breaks the streak', () => {
    // 06-03 missing → only today counts
    const hist = [{ date: '2026-06-02', clean: true }, { date: '2026-06-01', clean: true }];
    expect(computeConsecutiveCleanDays(hist, true, '2026-06-04')).toBe(1);
  });

  test('a not-clean prior day stops the streak', () => {
    const hist = [{ date: '2026-06-03', clean: true }, { date: '2026-06-02', clean: false }, { date: '2026-06-01', clean: true }];
    expect(computeConsecutiveCleanDays(hist, true, '2026-06-04')).toBe(2);
  });

  test('a full 5-day streak meets the threshold', () => {
    const hist = [
      { date: '2026-06-03', clean: true },
      { date: '2026-06-02', clean: true },
      { date: '2026-06-01', clean: true },
      { date: '2026-05-31', clean: true },
    ];
    expect(computeConsecutiveCleanDays(hist, true, '2026-06-04')).toBe(5);
  });

  test('newest snapshot per date wins (history is newest-first)', () => {
    // 06-03 has a later clean=false then an earlier clean=true; newest (false) wins → streak stops at today
    const hist = [
      { date: '2026-06-03', clean: false },
      { date: '2026-06-03', clean: true },
      { date: '2026-06-02', clean: true },
    ];
    expect(computeConsecutiveCleanDays(hist, true, '2026-06-04')).toBe(1);
  });
});
