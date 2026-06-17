/**
 * Journey Conversation V2 — maturity model (Phase 2).
 *
 * Two derived concepts, both pure and deterministic so the conversation
 * shape is unit-testable:
 *
 *   - ExtendedTenureStage   — calendar age only (extends TenureStage past 30d)
 *   - JourneyExperienceLevel — capped additive engagement score with
 *     calendar guards in BOTH directions (no over-promotion from a single
 *     strong signal, no beginner treatment for long-tenured users).
 *
 * Spec: docs/SPEC-journey-conversation-v2.md §4 (clarification B).
 */

export type ExtendedTenureStage =
  | 'day0'
  | 'day1'
  | 'day3'
  | 'day7'
  | 'day14'
  | 'day30plus'
  | 'day60plus'
  | 'day90plus'
  | 'day180plus';

export type JourneyExperienceLevel =
  | 'first_time'
  | 'orientation'
  | 'learning'
  | 'building'
  | 'active'
  | 'advanced'
  | 'mature'
  | 'returning_low_data';

export type VitanaIndexMaturity = 'none' | 'baseline' | 'emerging' | 'stable' | 'rich';

export function deriveExtendedTenureStage(daysSinceSignup: number): ExtendedTenureStage {
  const d = Math.max(0, Math.floor(daysSinceSignup));
  if (d === 0) return 'day0';
  if (d < 3) return 'day1';
  if (d < 7) return 'day3';
  if (d < 14) return 'day7';
  if (d < 30) return 'day14';
  if (d < 60) return 'day30plus';
  if (d < 90) return 'day60plus';
  if (d < 180) return 'day90plus';
  return 'day180plus';
}

export interface IndexMaturityInput {
  /** A Vitana Index snapshot exists for the user (any pillar data at all). */
  has_index_snapshot: boolean;
  active_usage_days: number;
  diary_streak_days: number;
}

/**
 * No index data yet → 'none'. Otherwise richness is a proxy for how much
 * lived data feeds the index: distinct active days + double-weighted diary
 * streak (the diary is the densest index input).
 */
export function deriveVitanaIndexMaturity(input: IndexMaturityInput): VitanaIndexMaturity {
  if (!input.has_index_snapshot) return 'none';
  const richness =
    Math.max(0, input.active_usage_days) + 2 * Math.max(0, input.diary_streak_days);
  if (richness < 7) return 'baseline';
  if (richness < 20) return 'emerging';
  if (richness < 45) return 'stable';
  return 'rich';
}

export interface ExperienceSignals {
  days_since_signup: number;
  active_usage_days: number;
  completed_journey_topics: number;
  completed_journey_sessions: number;
  diary_streak_days: number;
  autopilot_activations: number;
  connection_count: number;
  group_count: number;
  /** 0–4 of: life_compass_defined, profile_completed, diary_started, autopilot_used */
  completed_priority_tasks: number;
  vitana_index_maturity: VitanaIndexMaturity;
}

const INDEX_MATURITY_POINTS: Record<VitanaIndexMaturity, number> = {
  none: 0,
  baseline: 5,
  emerging: 10,
  stable: 20,
  rich: 30,
};

/**
 * Capped additive engagement score. Every signal contributes bounded points
 * so no single signal can promote a user past the next band on its own
 * (max-signal over-promotion guard, spec clarification B).
 */
export function computeEngagementScore(s: ExperienceSignals): number {
  const cap = (v: number, max: number) => Math.min(Math.max(0, v), max);
  return (
    cap(s.active_usage_days, 60) +
    cap(s.completed_journey_topics * 4, 40) +
    cap(s.completed_journey_sessions * 3, 30) +
    cap(s.diary_streak_days * 2, 30) +
    cap(s.autopilot_activations * 5, 25) +
    cap(s.connection_count * 2, 10) +
    cap(s.group_count * 3, 9) +
    cap(s.completed_priority_tasks * 10, 40) +
    INDEX_MATURITY_POINTS[s.vitana_index_maturity]
  );
}

type Band = Exclude<JourneyExperienceLevel, 'returning_low_data'>;

const BAND_ORDER: Band[] = [
  'first_time',
  'orientation',
  'learning',
  'building',
  'active',
  'advanced',
  'mature',
];

function bandForScore(score: number): Band {
  if (score < 10) return 'first_time';
  if (score < 30) return 'orientation';
  if (score < 60) return 'learning';
  if (score < 100) return 'building';
  if (score < 150) return 'active';
  if (score < 220) return 'advanced';
  return 'mature';
}

/** Minimum calendar days required before a band may be assigned. */
const BAND_CALENDAR_MINIMUM: Partial<Record<Band, number>> = {
  building: 14,
  active: 30,
  advanced: 90,
  mature: 180,
};

export function deriveJourneyExperienceLevel(s: ExperienceSignals): JourneyExperienceLevel {
  const days = Math.max(0, Math.floor(s.days_since_signup));
  let band = bandForScore(computeEngagementScore(s));

  // Calendar cap: engagement alone cannot outrun tenure. Demote to the
  // highest band the calendar permits.
  let idx = BAND_ORDER.indexOf(band);
  while (idx > 0) {
    const min = BAND_CALENDAR_MINIMUM[BAND_ORDER[idx]];
    if (min === undefined || days >= min) break;
    idx -= 1;
  }
  band = BAND_ORDER[idx];

  // Backfill floor: a long-tenured user with little/no engagement data is a
  // returning user, never a beginner — re-entry language, not onboarding.
  if (days >= 90 && (band === 'first_time' || band === 'orientation')) {
    return 'returning_low_data';
  }

  // first_time is strictly the first 3 calendar days.
  if (band === 'first_time' && days >= 3) {
    return 'orientation';
  }

  return band;
}

/**
 * Per-level conversation style guidance injected into the V2 prompt block.
 * These describe HOW to speak — they are LLM instructions, intentionally
 * English (system instructions stay English; the language directive makes
 * the OUTPUT match the user's locale).
 */
export const EXPERIENCE_STYLE_GUIDANCE: Record<JourneyExperienceLevel, string> = {
  first_time:
    'FIRST-TIME user: inspirational welcome. Explain the journey and your purpose warmly. Full orientation is appropriate.',
  orientation:
    'ORIENTATION stage: teacher mode. Simple language, more explanation, one small step at a time.',
  learning:
    'LEARNING stage: guide mode. Connect lessons to concrete actions (Diary, Life Compass, Autopilot).',
  building:
    'BUILDING stage: coach mode. More personal and data-aware — reference their streaks, goal and progress.',
  active:
    'ACTIVE stage: shorter teaching. Lead with Autopilot actions, Diary momentum and community — not basics.',
  advanced:
    'ADVANCED stage: strategic guidance. Skip basic explanations entirely unless asked.',
  mature:
    'MATURE companion: peer-level strategist. NEVER explain platform basics unless explicitly requested.',
  returning_low_data:
    'RETURNING user with little recorded data: respectful re-entry. Do NOT use beginner wording; acknowledge they have been around and ask to rebuild context together.',
};
