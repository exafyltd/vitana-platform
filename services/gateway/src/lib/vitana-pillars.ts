/**
 * Vitana Index — single source of truth for the 5 canonical pillars, the
 * tier ladder, balance labels, and Book-of-the-Index chapter paths.
 *
 * The Index is defined over EXACTLY five pillars:
 *   nutrition, hydration, exercise, sleep, mental
 *
 * Importing from this file anywhere (profiler, ORB tools, retrieval-router,
 * awareness-registry) means a future reshape flips one file, not many.
 *
 * Runtime source of ORB-agent integration: `services/pillar-agents/types.ts`
 * already defines `PillarKey` with the exact same union — we re-export from
 * here so consumers never have to reach into the agents package.
 */

import type { PillarKey } from '../services/pillar-agents/types';

export type { PillarKey };

/** Canonical pillar order. Any display/emit should iterate this. */
export const PILLAR_KEYS: readonly PillarKey[] = [
  'nutrition',
  'hydration',
  'exercise',
  'sleep',
  'mental',
] as const;

/** Human-facing label for voice/UI. Keep lowercase; callers Title-Case. */
export function pillarLabel(p: PillarKey): string {
  return p;
}

/**
 * Per-pillar Book chapter path in the `vitana_system` KB namespace. Callers
 * pass these to search_knowledge so the Assistant grounds its answer in the
 * canonical longevity narrative rather than regurgitating prompt text.
 */
export function pillarBookChapter(p: PillarKey): string {
  const map: Record<PillarKey, string> = {
    nutrition: 'kb/vitana-system/index-book/01-nutrition.md',
    hydration: 'kb/vitana-system/index-book/02-hydration.md',
    exercise: 'kb/vitana-system/index-book/03-exercise.md',
    sleep: 'kb/vitana-system/index-book/04-sleep.md',
    mental: 'kb/vitana-system/index-book/05-mental.md',
  };
  return map[p];
}

/**
 * Canonical wellness-tag → pillar map. The compute RPC, pillar agents,
 * calendar completion delta emitter, and ORB tools all key off this.
 * Adding a tag bucket here is the single upstream change needed for a
 * new signal to flow into the Index.
 */
export const PILLAR_TAGS: Record<PillarKey, readonly string[]> = {
  nutrition: ['nutrition', 'meal', 'food-log'],
  hydration: ['hydration', 'water'],
  exercise:  ['movement', 'workout', 'walk', 'steps', 'exercise'],
  sleep:     ['sleep', 'rest', 'recovery'],
  mental:    ['mindfulness', 'mental', 'stress', 'meditation', 'learning', 'journal'],
} as const;

/** Canonical Book chapters referenced by voice when explaining the system. */
export const BOOK_CHAPTERS = {
  overview: 'kb/vitana-system/index-book/00-overview.md',
  nutrition: 'kb/vitana-system/index-book/01-nutrition.md',
  hydration: 'kb/vitana-system/index-book/02-hydration.md',
  exercise: 'kb/vitana-system/index-book/03-exercise.md',
  sleep: 'kb/vitana-system/index-book/04-sleep.md',
  mental: 'kb/vitana-system/index-book/05-mental.md',
  balance: 'kb/vitana-system/index-book/06-balance.md',
  journey: 'kb/vitana-system/index-book/07-the-90-day-journey.md',
  reading: 'kb/vitana-system/index-book/08-reading-your-number.md',
} as const;

/**
 * Tier ladder as shipped in the Book. The compute RPC caps score_total at
 * 999 so 'Elite' covers the real max. Keep bands CONTIGUOUS — gaps would
 * orphan a score.
 */
export interface TierBand {
  readonly min: number;   // inclusive
  readonly max: number;   // inclusive
  readonly name: string;
  readonly framing: string;   // one-line copy the Assistant can speak
}

export const TIER_LADDER: readonly TierBand[] = [
  { min: 0,   max: 99,  name: 'Starting',    framing: "You've begun. Five pillars, 90 days — let's go." },
  { min: 100, max: 299, name: 'Early',       framing: 'Baseline established. Every completion counts now.' },
  { min: 300, max: 499, name: 'Building',    framing: 'Habits are forming. Keep the balance across all five.' },
  { min: 500, max: 599, name: 'Strong',      framing: 'Where most people land after a real 90-day push.' },
  { min: 600, max: 799, name: 'Really good', framing: "Your practice is working. This is the 'thriving' zone." },
  { min: 800, max: 999, name: 'Elite',       framing: 'Sustained excellence across all five pillars. Rare and earned.' },
] as const;

export function tierForScore(total: number): TierBand {
  const t = TIER_LADDER.find(b => total >= b.min && total <= b.max);
  // Fallback: clamp to ends. Real scores are 0-999 so this only triggers on bad input.
  if (!t) return total < 0 ? TIER_LADDER[0] : TIER_LADDER[TIER_LADDER.length - 1];
  return t;
}

/** Aspirational "Really good" entry — used for default 90-day framing. */
export const REALLY_GOOD_THRESHOLD = 600;

/**
 * Balance factor classification. Mirrors the compute RPC:
 *   ratio = min_pillar / max_pillar   (1.0 = perfectly balanced)
 *   factor in {1.00, 0.90, 0.80, 0.70}
 * We ship labels the Assistant can speak directly.
 */
export interface BalanceState {
  readonly factor: number;         // the multiplicative dampener
  readonly label: string;          // short voice-friendly descriptor
  readonly assistantHint: string;  // guidance for the model
}

export function describeBalance(balanceFactor: number | null | undefined): BalanceState {
  const f = typeof balanceFactor === 'number' ? balanceFactor : 1.0;
  if (f >= 1.0)  return { factor: 1.0,  label: 'well balanced',             assistantHint: 'Balance is healthy — your 5 pillars move together.' };
  if (f >= 0.9)  return { factor: 0.9,  label: 'slightly off-balance',      assistantHint: 'A slight imbalance; one pillar is behind the others.' };
  if (f >= 0.8)  return { factor: 0.8,  label: 'off-balance',               assistantHint: 'Noticeably off-balance. Lifting the weakest pillar multiplies your whole score.' };
  return               { factor: 0.7,  label: 'seriously unbalanced',       assistantHint: 'Seriously unbalanced — the balance dampener is holding your total back more than any single pillar.' };
}
