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
  // Mental health is driven by mindfulness AND community engagement in equal
  // measure. Social connection, joining or creating events, chatting, inviting
  // others, meeting like-minded people, and match-making all lift the mental
  // pillar. The DB-side v3 compute RPC and the contribution_vector trigger
  // are kept in lockstep with this array via the companion migration.
  mental:    [
    'mindfulness', 'mental', 'stress', 'meditation', 'learning', 'journal',
    'social', 'community', 'meetup', 'invite', 'group', 'chat',
    'leadership', 'connection', 'match',
  ],
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

/** Aspirational "Really good" entry — the Day-90 milestone for most users. */
export const REALLY_GOOD_THRESHOLD = 600;

/**
 * Stretch target — a second aspirational anchor deep inside the Elite band
 * (800-999). Shown on the Index Detail goal card as the "stretch" goal.
 * Reaching it takes months of sustained balanced practice, not a 90-day
 * sprint. Voice references it when the user asks what 850 means.
 */
export const STRETCH_TARGET = 850;

/**
 * Project a Day-90 linear forecast from a 7-day trend.
 *
 *   projected = clamp(0, 999, total + trend_7d × days_remaining / 7)
 *
 * Matches the frontend trajectory card's simple linear model. If the
 * trend is zero or history is missing, returns null — voice should fall
 * back to aspirational framing rather than quote a phantom projection.
 *
 * @param total            current Index score
 * @param trend7d          delta vs 7 days ago (positive = rising)
 * @param daysSinceStart   whole days since user's first Index row / registration
 */
export function projectDay90(
  total: number,
  trend7d: number,
  daysSinceStart: number,
): number | null {
  if (!Number.isFinite(total) || !Number.isFinite(trend7d)) return null;
  const daysRemaining = Math.max(0, 90 - daysSinceStart);
  if (daysRemaining === 0) return Math.max(0, Math.min(999, Math.round(total)));
  const projected = total + (trend7d * daysRemaining) / 7;
  return Math.max(0, Math.min(999, Math.round(projected)));
}

/**
 * Pillar-specific action templates — the fallback library the voice plan
 * tool uses when there are no matching autopilot_recommendations for the
 * user's target pillar yet (new accounts, empty queue, or a pillar with
 * no current rec mapping). Each entry is a standalone, self-directed
 * block the user can complete without setup.
 *
 * Keep these ~30 minutes each and framed as invitations, not prescriptions.
 * Duration and wellness_tags are sourced by the calendar plan tool.
 */
export interface PillarActionTemplate {
  readonly title: string;
  readonly description: string;
}

export const PILLAR_ACTION_TEMPLATES: Record<PillarKey, readonly PillarActionTemplate[]> = {
  nutrition: [
    { title: 'Meal planning block', description: '15 minutes to plan balanced meals for the next two days. Focus on one protein source and two colors of vegetables per meal.' },
    { title: 'Mindful eating session', description: 'One slow, phone-free meal. Notice tastes, textures, fullness signals.' },
    { title: 'Nutrition log review', description: '10 minutes to log recent meals and reflect on macro balance.' },
  ],
  hydration: [
    { title: 'Hydration check-in', description: 'Review today\'s water intake target. Top up if behind. Keep a water bottle within reach.' },
    { title: 'Electrolyte reset', description: 'Short hydration + electrolyte block — salt, lemon, or a sports-drink alternative. Especially after exercise or heat.' },
    { title: 'Pre-sleep hydration window', description: 'Last drink at least 90 minutes before bed so sleep isn\'t interrupted. Set a gentle evening cue.' },
  ],
  exercise: [
    { title: '30-minute movement block', description: 'Walk, cycle, or light workout. Any sustained movement that raises your heart rate for the full 30 minutes.' },
    { title: 'Mobility + recovery', description: '15 minutes of gentle mobility: hips, shoulders, spine. Slow, deliberate. Not a workout — a reset.' },
    { title: 'Structured workout session', description: 'Strength or cardio session of your choice. Intensity to taste. Complete, then log how it felt.' },
  ],
  sleep: [
    { title: 'Wind-down block', description: '30 minutes before bed with dim lights, screens off, calm routine. Reading, stretching, breathwork — anything below-the-line arousal.' },
    { title: 'Sleep check-in', description: 'Note bedtime and wake time. Review what shifted compared to the previous night. No judgement, just data.' },
    { title: 'Consistent bedtime', description: 'Anchor a bedtime within 30 minutes of your target window. Regularity matters more than total duration.' },
  ],
  mental: [
    { title: 'Meditation / breathwork', description: '10 minutes of guided breath practice. Box breathing, 4-7-8, or any app-led session. Settles the nervous system.' },
    { title: 'Journal entry', description: '5–10 minutes of free-writing. One sentence about something that surprised you, one intention for tomorrow.' },
    { title: 'Quiet walk (no input)', description: '15-minute walk with no podcast, no phone. Let the mind unclench. Notice what bubbles up.' },
  ],
} as const;

/**
 * Silent alias map from retired 6-pillar names to the closest canonical
 * 5-pillar key. Used by ORB tool executors and the retrieval path so when
 * the model (or the user) slips and says "Physical" / "Prosperity" / etc.,
 * we route them to the right bucket without acknowledging the retired
 * pillar name in voice.
 *
 * Mapping choices mirror the 5-pillar cleanup migration's data-repair
 * COALESCE fallback (score_physical → score_exercise primary, with
 * score_sleep as a secondary split). "Social / environmental / prosperity"
 * all route to Mental as the closest quality-of-life anchor we actually
 * measure in the five-pillar model.
 */
export const RETIRED_PILLAR_ALIASES: Record<string, PillarKey> = {
  physical: 'exercise',
  nutritional: 'nutrition',
  social: 'mental',
  environmental: 'mental',
  prosperity: 'mental',
};

/**
 * Resolve a raw pillar argument (possibly from the model) to a canonical
 * PillarKey, or `undefined` if unknown. Lowercases, checks the retired
 * alias map first, then the canonical set. Callers should fall back to
 * the weakest pillar when this returns undefined.
 */
export function resolvePillarKey(raw: unknown): PillarKey | undefined {
  if (typeof raw !== 'string') return undefined;
  const k = raw.trim().toLowerCase();
  if ((PILLAR_KEYS as readonly string[]).includes(k)) return k as PillarKey;
  if (k in RETIRED_PILLAR_ALIASES) return RETIRED_PILLAR_ALIASES[k];
  return undefined;
}

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
