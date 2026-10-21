/**
 * VTID-02955 (B5) — compilePillarMomentumContext tests.
 *
 * Pure function. Verifies:
 *   - Momentum classification across the 3 thresholds
 *   - Insufficient data → 'unknown'
 *   - Weakest / strongest picks based on latest row
 *   - Suggested-focus tie-break (prefers slipping pillar over an
 *     'improving' weakest)
 *   - Confidence bucket boundaries
 *   - Empty / degraded input
 */

import {
  compilePillarMomentumContext,
  computeMomentum,
  pickStrongest,
  pickWeakest,
} from '../../../src/services/pillar-momentum/compile-pillar-momentum-context';
import type { VitanaIndexScoreRow } from '../../../src/services/pillar-momentum/types';

function row(over: Partial<VitanaIndexScoreRow>): VitanaIndexScoreRow {
  return {
    date: '2026-05-13',
    score_total: 400,
    score_sleep: 80,
    score_nutrition: 80,
    score_exercise: 80,
    score_hydration: 80,
    score_mental: 80,
    ...over,
  };
}

// Generates a contiguous date sequence (DESC) for testing 14-day windows.
function days(n: number): string[] {
  const out: string[] = [];
  const start = Date.parse('2026-05-13T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const d = new Date(start - i * 24 * 60 * 60 * 1000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

describe('B5 — compilePillarMomentumContext', () => {
  describe('momentum classification', () => {
    it.each([
      [[100, 100, 100, 100, 100, 100, 100], [80, 80, 80, 80, 80, 80, 80], 'improving'],
      [[80, 80, 80, 80, 80, 80, 80], [100, 100, 100, 100, 100, 100, 100], 'slipping'],
      [[80, 80, 80, 80, 80, 80, 80], [82, 82, 82, 82, 82, 82, 82], 'steady'],
      [[80, 80], [80, 80, 80, 80, 80, 80, 80], 'unknown'], // <3 in recent
      [[80, 80, 80, 80, 80, 80, 80], [80], 'unknown'],     // <3 in prior
    ] as const)('recent=%s prior=%s → %s', (recent, prior, expected) => {
      expect(computeMomentum([...recent], [...prior])).toBe(expected);
    });
  });

  describe('weakest / strongest pick', () => {
    it('picks weakest by lowest score', () => {
      expect(pickWeakest(row({
        score_sleep: 30,
        score_nutrition: 80,
        score_exercise: 90,
        score_hydration: 100,
        score_mental: 120,
      }))).toBe('sleep');
    });

    it('picks strongest by highest score', () => {
      expect(pickStrongest(row({
        score_sleep: 30,
        score_nutrition: 80,
        score_exercise: 90,
        score_hydration: 100,
        score_mental: 120,
      }))).toBe('mental');
    });

    it('returns null when all pillar scores are null', () => {
      expect(pickWeakest(row({
        score_sleep: null,
        score_nutrition: null,
        score_exercise: null,
        score_hydration: null,
        score_mental: null,
      }))).toBeNull();
    });
  });

  describe('full compile — empty input', () => {
    it('returns safe-empty context when fetch failed', () => {
      const ctx = compilePillarMomentumContext({
        fetchResult: { ok: false, rows: [], reason: 'supabase_unconfigured' },
      });
      expect(ctx.per_pillar).toHaveLength(5);
      expect(ctx.per_pillar.every((p) => p.momentum === 'unknown')).toBe(true);
      expect(ctx.weakest_pillar).toBeNull();
      expect(ctx.strongest_pillar).toBeNull();
      expect(ctx.suggested_focus).toBeNull();
      expect(ctx.confidence).toBe('low');
      expect(ctx.source_health.vitana_index_scores.ok).toBe(false);
      expect(ctx.source_health.vitana_index_scores.reason).toBe('supabase_unconfigured');
    });

    it('returns safe-empty context when fetch ok but no rows', () => {
      const ctx = compilePillarMomentumContext({
        fetchResult: { ok: true, rows: [] },
      });
      expect(ctx.per_pillar.every((p) => p.momentum === 'unknown')).toBe(true);
      expect(ctx.weakest_pillar).toBeNull();
      expect(ctx.confidence).toBe('low');
      expect(ctx.source_health.vitana_index_scores.ok).toBe(true);
    });
  });

  describe('full compile — improving sleep', () => {
    it('per_pillar.sleep = improving when recent avg > prior avg by >5', () => {
      const dates = days(14);
      const rows: VitanaIndexScoreRow[] = dates.map((d, i) => {
        // Days 0..6 (recent) sleep=100; days 7..13 (prior) sleep=80.
        const sleep = i < 7 ? 100 : 80;
        return row({ date: d, score_sleep: sleep });
      });
      const ctx = compilePillarMomentumContext({
        fetchResult: { ok: true, rows },
      });
      const sleepEntry = ctx.per_pillar.find((p) => p.pillar === 'sleep');
      expect(sleepEntry?.momentum).toBe('improving');
      // Other pillars are flat (80 vs 80) → steady or unknown depending on coverage.
      // With 14 days of data at score 80, prior and recent averages match → steady.
      const exerciseEntry = ctx.per_pillar.find((p) => p.pillar === 'exercise');
      expect(exerciseEntry?.momentum).toBe('steady');
    });
  });

  describe('suggested-focus tie-break', () => {
    it('switches focus from improving weakest to a slipping pillar', () => {
      // 14 days. Latest row: sleep=30 (weakest), others=100.
      // Sleep recent=100 prior=20 → improving.
      // Exercise recent=70 prior=100 → slipping.
      // Suggested focus should switch from sleep (weakest) to exercise (slipping).
      const dates = days(14);
      const rows: VitanaIndexScoreRow[] = dates.map((d, i) => {
        const isRecent = i < 7;
        return row({
          date: d,
          score_sleep:     i === 0 ? 30 : (isRecent ? 100 : 20),
          score_nutrition: 100,
          score_exercise:  isRecent ? 70 : 100,
          score_hydration: 100,
          score_mental:    100,
        });
      });
      const ctx = compilePillarMomentumContext({
        fetchResult: { ok: true, rows },
      });
      expect(ctx.weakest_pillar).toBe('sleep');
      const sleepEntry = ctx.per_pillar.find((p) => p.pillar === 'sleep');
      expect(sleepEntry?.momentum).toBe('improving');
      expect(ctx.suggested_focus).toBe('exercise');
    });

    it('keeps focus on weakest when its momentum is not improving', () => {
      const dates = days(14);
      const rows: VitanaIndexScoreRow[] = dates.map((d) => row({
        date: d,
        score_sleep: 50,
        score_nutrition: 80,
        score_exercise: 80,
        score_hydration: 80,
        score_mental: 80,
      }));
      const ctx = compilePillarMomentumContext({
        fetchResult: { ok: true, rows },
      });
      expect(ctx.weakest_pillar).toBe('sleep');
      expect(ctx.suggested_focus).toBe('sleep');
    });
  });

  describe('confidence bucket', () => {
    it('high when ≥4 pillars are well-covered', () => {
      const dates = days(14);
      const rows = dates.map((d) => row({
        date: d,
        score_sleep: 80,
        score_nutrition: 80,
        score_exercise: 80,
        score_hydration: 80,
        score_mental: 80,
      }));
      const ctx = compilePillarMomentumContext({
        fetchResult: { ok: true, rows },
      });
      expect(ctx.confidence).toBe('high');
    });

    it('medium when 2-3 pillars are well-covered', () => {
      // 14 days of data, but only 2 pillars have non-null in BOTH windows.
      const dates = days(14);
      const rows: VitanaIndexScoreRow[] = dates.map((d) => row({
        date: d,
        score_sleep: 80,
        score_nutrition: 80,
        score_exercise: null,
        score_hydration: null,
        score_mental: null,
      }));
      const ctx = compilePillarMomentumContext({
        fetchResult: { ok: true, rows },
      });
      expect(ctx.confidence).toBe('medium');
    });

    it('low when 0-1 pillars are well-covered', () => {
      const ctx = compilePillarMomentumContext({
        fetchResult: { ok: true, rows: [] },
      });
      expect(ctx.confidence).toBe('low');
    });
  });
});
