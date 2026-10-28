/**
 * VTID-02937 (B4) — tenure & journey-stage types.
 *
 * Drives signals 25–32 of the AssistantDecisionContext:
 *   #25 tenure_bucket
 *   #26 usage_days_count
 *   #27 lifetime_session_count           (deferred — needs oasis-event derivation)
 *   #28 lifetime_voice_minutes           (deferred — needs voice-duration aggregation)
 *   #29 feature_discovery_progress       (deferred — derives from B0c capability awareness)
 *   #30 vitana_index_tier + tier_days_held
 *   #31 last_milestone_celebrated        (deferred — needs oasis topic=*.celebrated rollup)
 *   #32 onboarding_steps_outstanding     (deferred — driven by onboarding RPC)
 *
 * B4.0 ships the three signals that have authoritative data sources
 * today (tenure_bucket, usage_days_count, vitana_index_tier). The
 * other five reserve the contract shape but return null until their
 * data sources land.
 *
 * Wall (B4): pure types. No IO, no mutation. The fetcher is read-
 * only; nothing in this slice writes to user-state tables. The MV
 * optimisation called out in the plan is deferred — B4.0 uses
 * inline queries against the existing read paths (app_users,
 * user_active_days, vitana_index_scores).
 */

/**
 * 5-step onboarding ladder mirroring the B0e ranker.
 * Boundaries (in days since app_users.created_at):
 *   first_session  → tenure_days == 0
 *   first_days     → 1..6
 *   first_week     → 7..13
 *   first_month    → 14..59
 *   established    → 60+
 */
export type OnboardingStage =
  | 'first_session'
  | 'first_days'
  | 'first_week'
  | 'first_month'
  | 'established';

/** Coarse explanation-depth hint that the decision layer can read. */
export type ExplanationDepthHint = 'deep' | 'standard' | 'terse';

/** Vitana Index tier ladder (5-tier canonical post-Phase E). */
export type VitanaIndexTier =
  | 'foundation'
  | 'building'
  | 'momentum'
  | 'resonance'
  | 'flourishing'
  | 'unknown';

export interface AppUserRow {
  user_id: string;
  created_at: string;
}

export interface UserActiveDaysAggregate {
  usage_days_count: number;
  last_active_date: string | null;
}

export interface VitanaIndexLatestRow {
  date: string;
  score_total: number;
}

/**
 * Compiled journey-stage context — what the assistant decision layer
 * consumes for depth modulation. Distilled from raw rows; never
 * carries them verbatim.
 */
export interface JourneyStageContext {
  /** Signal #25 — coarse bucket the ranker reads. */
  onboarding_stage: OnboardingStage;
  /** Days since app_users.created_at (UTC), null when user not found. */
  tenure_days: number | null;
  /** Signal #26 — distinct UTC dates with at least one authenticated request. */
  usage_days_count: number;
  /** Most recent active date (ISO YYYY-MM-DD) and freshness in days. */
  last_active_date: string | null;
  days_since_last_active: number | null;
  /** Signal #30 — current Vitana Index score + derived tier, plus optional days held. */
  vitana_index: {
    score_total: number | null;
    tier: VitanaIndexTier;
    /**
     * Days the user has held the current tier — counted by walking the
     * vitana_index_scores history. NULL when only a single observation
     * exists or history is missing.
     */
    tier_days_held: number | null;
  };
  /** Decision-layer hint — derived purely from `onboarding_stage`. */
  explanation_depth_hint: ExplanationDepthHint;
  /**
   * Source-health view — empty rows + a `reason` is "user not yet on
   * platform", not a failure. Failures surface here.
   */
  source_health: {
    app_users: { ok: boolean; reason?: string };
    user_active_days: { ok: boolean; reason?: string };
    vitana_index_scores: { ok: boolean; reason?: string };
  };
}
