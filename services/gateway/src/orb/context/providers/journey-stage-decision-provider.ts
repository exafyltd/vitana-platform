/**
 * VTID-02954 (F3) — JourneyStage → AssistantDecisionContext adapter.
 *
 * The B4 read-only inspection slice already produced
 * `JourneyStageContext`, a richer shape designed for the Command Hub
 * operator. The assistant decision layer reads a NARROWER shape
 * (`DecisionJourneyStage`) that strips:
 *   - raw tenure_days integer (kept as tenure_bucket enum)
 *   - raw last_active_date ISO string (kept as activity_recency enum)
 *   - raw usage_days_count integer (kept as usage_volume enum)
 *   - raw vitana_index.score_total 0..999 (kept as tier enum only)
 *   - raw tier_days_held integer (kept as tier_tenure enum)
 *
 * Kept: bucketed forms of all of the above, plus the
 * ExplanationDepthHint pre-derived by B4's compiler and a new
 * stage-aware tone hint.
 *
 * Pure function. No IO. The caller is responsible for invoking the
 * journey-stage compiler + passing its output here.
 */

import type { JourneyStageContext } from '../../../services/journey-stage/types';
import type {
  ActivityRecencyBucket,
  DecisionJourneyStage,
  JourneyConfidenceBucket,
  JourneyStageWarning,
  StageToneHint,
  TenureBucket,
  TierTenureBucket,
  UsageVolumeBucket,
  VitanaIndexTierBucket,
} from '../types';

export interface DistillJourneyStageInputs {
  /**
   * Output of `compileJourneyStageContext` from B4. Read-only.
   */
  journeyStage: JourneyStageContext;
}

/**
 * Distills `JourneyStageContext` into the decision-grade
 * `DecisionJourneyStage`.
 *
 * Always returns a typed shape (never undefined). The caller decides
 * whether to attach it to `AssistantDecisionContext.journey_stage` or
 * set the field to `null` based on source health.
 */
export function distillJourneyStageForDecision(
  input: DistillJourneyStageInputs,
): DecisionJourneyStage {
  const { journeyStage } = input;

  const stage: TenureBucket = journeyStage.onboarding_stage;
  const explanation_depth = journeyStage.explanation_depth_hint;
  const tone_hint = toneFromStage(stage);

  const vitana_index_tier: VitanaIndexTierBucket = journeyStage.vitana_index.tier;
  const tier_tenure = bucketTierTenure(journeyStage.vitana_index.tier_days_held);
  const activity_recency = bucketActivityRecency(journeyStage.days_since_last_active);
  const usage_volume = bucketUsageVolume(journeyStage.usage_days_count);

  const journey_confidence = computeJourneyConfidence(journeyStage);
  const warnings = computeWarnings(journeyStage);

  return {
    stage,
    tenure_bucket: stage,
    explanation_depth,
    tone_hint,
    vitana_index_tier,
    tier_tenure,
    activity_recency,
    usage_volume,
    journey_confidence,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Maps the 5-step onboarding ladder to a coarse tone hint. Derived
 * purely from `stage` — never reads user content.
 */
export function toneFromStage(stage: TenureBucket): StageToneHint {
  switch (stage) {
    case 'first_session':
      return 'warm_welcoming';
    case 'first_days':
      return 'guiding';
    case 'first_week':
    case 'first_month':
      return 'collaborative';
    case 'established':
      return 'concise_familiar';
  }
}

/**
 * Buckets time-held-in-current-tier into a coarse band.
 *   0..6    → new
 *   7..29   → settled
 *   30+     → long_standing
 *   null    → unknown
 */
export function bucketTierTenure(
  daysHeld: number | null,
): TierTenureBucket {
  if (daysHeld === null || !Number.isFinite(daysHeld)) return 'unknown';
  if (daysHeld < 7) return 'new';
  if (daysHeld < 30) return 'settled';
  return 'long_standing';
}

/**
 * Buckets activity recency (days since last active).
 *   0..1    → today
 *   2..7    → recent
 *   8+      → lapsed
 *   null    → unknown
 */
export function bucketActivityRecency(
  daysSince: number | null,
): ActivityRecencyBucket {
  if (daysSince === null || !Number.isFinite(daysSince)) return 'unknown';
  if (daysSince <= 1) return 'today';
  if (daysSince <= 7) return 'recent';
  return 'lapsed';
}

/**
 * Buckets total usage volume (distinct active days).
 *   0      → none
 *   1..7   → light
 *   8..30  → regular
 *   31+    → heavy
 */
export function bucketUsageVolume(count: number): UsageVolumeBucket {
  if (!Number.isFinite(count) || count <= 0) return 'none';
  if (count <= 7) return 'light';
  if (count <= 30) return 'regular';
  return 'heavy';
}

/**
 * Computes coarse confidence in the journey-stage signal based on
 * which underlying sources reported `ok:true` AND had data.
 *
 *   high   — app_users ok AND (active_days ok OR vitana_index ok with data)
 *   medium — app_users ok but no other supporting data
 *   low    — app_users not ok, OR tenure_days is null
 */
export function computeJourneyConfidence(
  ctx: JourneyStageContext,
): JourneyConfidenceBucket {
  const appUsersOk = ctx.source_health.app_users.ok;
  const activeDaysOk = ctx.source_health.user_active_days.ok;
  const indexOk = ctx.source_health.vitana_index_scores.ok;

  if (!appUsersOk || ctx.tenure_days === null) return 'low';

  const supporting =
    (activeDaysOk && ctx.usage_days_count > 0) ||
    (indexOk && ctx.vitana_index.tier !== 'unknown');

  return supporting ? 'high' : 'medium';
}

/**
 * Computes the enum-only warning list. NEVER free-text strings,
 * NEVER raw timestamps, NEVER raw history.
 */
export function computeWarnings(
  ctx: JourneyStageContext,
): ReadonlyArray<JourneyStageWarning> {
  const out: JourneyStageWarning[] = [];

  if (ctx.tenure_days === null) {
    out.push('no_tenure_data');
  }

  // long_inactivity: derive from days_since_last_active bucket.
  if (
    ctx.days_since_last_active !== null &&
    Number.isFinite(ctx.days_since_last_active) &&
    ctx.days_since_last_active > 7
  ) {
    out.push('long_inactivity');
  }

  if (ctx.vitana_index.tier === 'unknown') {
    out.push('unknown_tier');
  }

  return out;
}
