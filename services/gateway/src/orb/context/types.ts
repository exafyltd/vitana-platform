/**
 * VTID-02941 (B0b-min) — AssistantDecisionContext: the decision contract.
 * VTID-02950 (F2)     — adds conceptMastery field.
 * VTID-02954 (F3)     — adds journeyStage field.
 * VTID-02955 (B5)     — adds pillarMomentum field.
 *
 * This is the SINGLE typed shape the instruction layer reads to assemble
 * a prompt. Raw rows (memory, threads, messages, promises, profiles,
 * concept rows, scores, transcripts, journey rows, route history,
 * behavioral history, biomarkers, trend arrays) MUST NOT cross this
 * boundary. The compiler distills; the renderer formats. No exceptions.
 *
 * Wall:
 *   - Forbidden: match journey, feature discovery, wake brief,
 *     continuation contract, greeting decay rewrite, reliability tuning.
 *     Each gets its own slice.
 *   - Continuity (B2) + conceptMastery (B3) + journeyStage (B4) +
 *     pillarMomentum (B5) are wired through this contract.
 *   - Adding new fields later is fine; pushing raw rows into them is not.
 *   - No medical interpretation. No diagnoses. No treatment advice.
 */

/**
 * Distilled continuity view that the assistant decision layer reads.
 *
 * Mirrors `ContinuityContext` from `services/continuity/types.ts` but
 * narrower — only the fields the LLM needs to make a "should I bring
 * this up?" decision. NEVER includes raw thread rows, raw promise rows,
 * raw memory items, message bodies, or profile payloads.
 */
export interface DecisionContinuity {
  /** Top-N open threads, most-recently-mentioned first (capped at 5). */
  open_threads: ReadonlyArray<{
    /** Stable thread id (so the LLM can refer to the same thread later). */
    thread_id: string;
    /** Short label — already truncated by the compiler. */
    topic: string;
    /** Optional one-line summary. NEVER the original message text. */
    summary: string | null;
    /** Recency hint. */
    days_since_last_mention: number | null;
  }>;
  /** Owed promises, oldest-due first (capped at 5). */
  promises_owed: ReadonlyArray<{
    promise_id: string;
    /** Short label — already truncated by the compiler. */
    promise_text: string;
    /** Boolean is enough for the decision layer; raw timestamps stay out. */
    overdue: boolean;
    /** Decision-id linkage when the promise traces back to a ranker decision. */
    decision_id: string | null;
  }>;
  /** Recently-kept promises (capped at 3) — for credit acknowledgement. */
  promises_kept_recently: ReadonlyArray<{
    promise_id: string;
    promise_text: string;
  }>;
  /** Aggregate counts the cadence layer uses. */
  counts: {
    open_threads_total: number;
    promises_owed_total: number;
    promises_overdue: number;
    threads_mentioned_today: number;
  };
  /** Single recommended follow-up KIND (not copy). The renderer formats it. */
  recommended_follow_up:
    | 'mention_open_thread'
    | 'acknowledge_kept_promise'
    | 'address_overdue_promise'
    | 'none';
}

/**
 * Frequency bucket — bucketed integer counts. The decision layer reads
 * the bucket name, never the raw count value.
 */
export type FrequencyBucket = 'none' | 'once' | 'twice' | 'many';

/**
 * Mastery confidence bucket — bucketed mastery-confidence score. We
 * deliberately do NOT pass the raw 0..1 score through the contract:
 * the LLM doesn't need to know "0.72" vs "0.81", only the band.
 */
export type MasteryConfidenceBucket = 'low' | 'medium' | 'high';

/**
 * Repetition hint that the assistant decision layer reads to suppress
 * over-explanation. Identical to B3's `compileConceptMasteryContext`
 * output — that enum is already decision-grade, no need to re-derive.
 */
export type RepetitionHint = 'first_time' | 'one_liner' | 'skip';

/**
 * Distilled concept-mastery view. Mirrors `ConceptMasteryContext` from
 * `services/concept-mastery/types.ts` but strips:
 *   - raw last_explained_at / last_observed_at / last_seen_at timestamps
 *   - raw 0..1 confidence floats (bucketed to low / medium / high)
 *   - raw integer counts (bucketed via FrequencyBucket)
 *
 * Kept: concept_key and card_key (stable identifiers the LLM can refer
 * to), repetition_hint (already decision-grade), and days_since_*
 * recency hints.
 */
export interface DecisionConceptMastery {
  /** Concepts the assistant has explained (capped at 10), recency first. */
  concepts_explained: ReadonlyArray<{
    /** Stable key for the concept, e.g. 'vitana_index'. */
    concept_key: string;
    /** Bucketed explanation frequency. Replaces raw count. */
    frequency: FrequencyBucket;
    /** Recency hint. Days are coarse enough to share. */
    days_since_last_explained: number | null;
    /** Pre-computed repetition hint from B3's compiler. */
    repetition_hint: RepetitionHint;
  }>;
  /** Concepts the user has demonstrated mastery of (capped at 10). */
  concepts_mastered: ReadonlyArray<{
    concept_key: string;
    /** Bucketed confidence. Replaces raw 0..1 score. */
    confidence: MasteryConfidenceBucket | 'unknown';
  }>;
  /** DYK cards already surfaced (capped at 10). */
  dyk_cards_seen: ReadonlyArray<{
    /** Stable card key. */
    card_key: string;
    /** Bucketed surface frequency. */
    frequency: FrequencyBucket;
    days_since_last_seen: number | null;
  }>;
  /** Aggregate counts the cadence layer uses (integers — these are totals, not raw rows). */
  counts: {
    concepts_explained_total: number;
    concepts_mastered_total: number;
    dyk_cards_seen_total: number;
    concepts_explained_in_last_24h: number;
  };
  /**
   * Single recommended cadence action.
   *   - 'suppress_over_explained' → at least one explained concept has hint=skip
   *   - 'use_one_liner'           → at least one has hint=one_liner, none skip
   *   - 'introduce_fresh'         → only first_time hints OR no explained concepts
   *   - 'none'                    → no actionable concept-mastery state
   */
  recommended_cadence:
    | 'suppress_over_explained'
    | 'use_one_liner'
    | 'introduce_fresh'
    | 'none';
}

/**
 * Coarse explanation-depth hint that the decision layer reads. Same
 * enum as B4's compiler — re-declared here so the decision-contract
 * type surface stays self-contained (no imports from `services/`).
 */
export type ExplanationDepthHint = 'deep' | 'standard' | 'terse';

/**
 * Tenure bucket — coarse onboarding stage. Identical to B4's
 * OnboardingStage; re-aliased here so the decision-contract type
 * surface stays self-contained.
 */
export type TenureBucket =
  | 'first_session'
  | 'first_days'
  | 'first_week'
  | 'first_month'
  | 'established';

/**
 * Vitana Index tier bucket. Replaces the raw 0..999 score — the LLM
 * never sees the underlying number.
 */
export type VitanaIndexTierBucket =
  | 'foundation'
  | 'building'
  | 'momentum'
  | 'resonance'
  | 'flourishing'
  | 'unknown';

/**
 * Bucketed time held in current Index tier. Replaces the raw day
 * count.
 */
export type TierTenureBucket = 'new' | 'settled' | 'long_standing' | 'unknown';

/**
 * Bucketed recency of the user's last authenticated activity.
 * Replaces the raw `last_active_date` ISO string.
 */
export type ActivityRecencyBucket = 'today' | 'recent' | 'lapsed' | 'unknown';

/**
 * Bucketed total usage-days volume. Replaces the raw `usage_days_count`
 * integer.
 */
export type UsageVolumeBucket = 'none' | 'light' | 'regular' | 'heavy';

/**
 * Coarse confidence in the journey-stage signal. Driven by how many
 * underlying sources reported `ok:true` AND had data.
 */
export type JourneyConfidenceBucket = 'low' | 'medium' | 'high';

/**
 * Stage-aware tone hint the decision layer can read. Derived purely
 * from tenure_bucket.
 */
export type StageToneHint =
  | 'warm_welcoming'   // first_session
  | 'guiding'          // first_days
  | 'collaborative'    // first_week + first_month
  | 'concise_familiar'; // established

/**
 * Allowed warnings on the journey-stage signal. Enums only — NEVER
 * free-text strings, NEVER raw timestamps, NEVER raw history.
 */
export type JourneyStageWarning =
  | 'no_tenure_data'
  | 'long_inactivity'
  | 'unknown_tier';

/**
 * Distilled journey-stage view. Mirrors `JourneyStageContext` from
 * `services/journey-stage/types.ts` but strips:
 *   - raw tenure_days integer (kept as tenure_bucket enum)
 *   - raw last_active_date ISO string (kept as activity_recency enum)
 *   - raw usage_days_count integer (kept as usage_volume enum)
 *   - raw vitana_index.score_total (kept as tier enum only)
 *   - raw tier_days_held integer (kept as tier_tenure enum)
 *
 * Kept: bucketed forms of everything above + the existing
 * ExplanationDepthHint + a derived stage-aware tone hint.
 */
export interface DecisionJourneyStage {
  /** 5-step onboarding ladder. Same enum as B4's compiler. */
  stage: TenureBucket;
  /** Bucketed tenure — alias of `stage` for clarity. */
  tenure_bucket: TenureBucket;
  /**
   * Coarse depth hint already derived by B4's compiler:
   *   first_session + first_days → 'deep'
   *   first_week + first_month    → 'standard'
   *   established                  → 'terse'
   */
  explanation_depth: ExplanationDepthHint;
  /** Stage-aware tone hint. Derived purely from `stage`. */
  tone_hint: StageToneHint;
  /** Bucketed Vitana Index tier. NEVER the raw 0..999 score. */
  vitana_index_tier: VitanaIndexTierBucket;
  /** Bucketed time held in current tier. NEVER the raw day count. */
  tier_tenure: TierTenureBucket;
  /** Bucketed recency. NEVER a raw timestamp. */
  activity_recency: ActivityRecencyBucket;
  /** Bucketed usage volume. NEVER the raw integer. */
  usage_volume: UsageVolumeBucket;
  /** Coarse confidence the LLM can use to weight the signal. */
  journey_confidence: JourneyConfidenceBucket;
  /** Warnings as enums. NEVER free-text. */
  warnings: ReadonlyArray<JourneyStageWarning>;
}

/**
 * Canonical 5-pillar enum (post-Phase E). Re-declared here so the
 * decision-contract types stay self-contained (no imports from
 * `services/`).
 */
export type PillarKey =
  | 'sleep'
  | 'nutrition'
  | 'exercise'
  | 'hydration'
  | 'mental';

/**
 * Per-pillar momentum band — same enum as the underlying B5 compiler;
 * already decision-grade.
 */
export type PillarMomentumBand =
  | 'improving'
  | 'steady'
  | 'slipping'
  | 'unknown';

/**
 * Coarse confidence in the pillar-momentum signal. The decision
 * adapter passes this through unchanged from the B5 compiler.
 */
export type PillarMomentumConfidence = 'low' | 'medium' | 'high';

/**
 * Allowed warnings on the pillar-momentum signal. Enums only —
 * NEVER free-text. NEVER medical interpretation. NEVER diagnosis.
 */
export type PillarMomentumWarning =
  | 'low_pillar_confidence'
  | 'no_recent_pillar_data';

/**
 * Distilled pillar-momentum view. Mirrors `PillarMomentumContext`
 * from `services/pillar-momentum/types.ts` but strips:
 *   - raw pillar scores (0..200 per pillar)
 *   - raw history dates / timestamps
 *   - raw trend arrays
 *   - raw window-coverage integers
 *
 * Kept: stable pillar enums (which one is weakest / strongest /
 * suggested-focus), per-pillar momentum band, coarse confidence,
 * and enum-only warnings.
 *
 * NEVER carries medical interpretation, diagnoses, or treatment
 * advice. The pillars are coaching axes, not clinical categories.
 */
export interface DecisionPillarMomentum {
  /**
   * Per-pillar momentum band, one entry per canonical pillar.
   * Order is deterministic (sleep / nutrition / exercise / hydration
   * / mental) so the renderer output is stable.
   */
  per_pillar: ReadonlyArray<{
    pillar: PillarKey;
    momentum: PillarMomentumBand;
  }>;
  /** Pillar with the lowest latest score, or null if no data. */
  weakest_pillar: PillarKey | null;
  /** Pillar with the highest latest score, or null if no data. */
  strongest_pillar: PillarKey | null;
  /**
   * Suggested focus pillar — typically the weakest, with a tie-break
   * preference for pillars whose momentum is 'slipping' or 'unknown'.
   * Null when no pillar data exists.
   */
  suggested_focus: PillarKey | null;
  /** Coarse confidence the LLM can use to weight the signal. */
  confidence: PillarMomentumConfidence;
  /** Warnings as enums. NEVER free-text, NEVER medical. */
  warnings: ReadonlyArray<PillarMomentumWarning>;
}

/**
 * Per-source health view. Empty/missing rows are not failures — they
 * just mean the user has no state yet. Failures (Supabase down, schema
 * mismatch, etc.) surface here with a `reason`.
 */
export interface DecisionSourceHealth {
  continuity: { ok: boolean; reason?: string };
  /** F2: concept-mastery source health. */
  concept_mastery: { ok: boolean; reason?: string };
  /** F3: journey-stage source health. */
  journey_stage: { ok: boolean; reason?: string };
  /** B5: pillar-momentum source health. */
  pillar_momentum: { ok: boolean; reason?: string };
}

/**
 * The single typed contract the instruction layer reads.
 *
 * Future slices add fields (matchJourney, journeyStage, etc.) — they
 * MUST land here as distilled shapes, never raw rows.
 *
 * `additionalProperties=false` semantics are enforced by tests + the
 * renderer's behavior: any unrecognized field is silently dropped.
 */
export interface AssistantDecisionContext {
  /**
   * Continuity decision view. `null` when the compiler had no input or
   * source-health is degraded — the renderer must emit no continuity
   * section in that case.
   */
  continuity: DecisionContinuity | null;
  /**
   * F2: Concept-mastery decision view. `null` when the compiler had no
   * input or source-health is degraded — the renderer must emit no
   * concept-mastery section in that case.
   */
  concept_mastery: DecisionConceptMastery | null;
  /**
   * F3: Journey-stage decision view. `null` when the compiler had no
   * input or source-health is degraded — the renderer must emit no
   * journey-stage section in that case.
   */
  journey_stage: DecisionJourneyStage | null;
  /**
   * B5: Pillar-momentum decision view. `null` when the compiler had
   * no input or source-health is degraded — the renderer must emit
   * no pillar-momentum section in that case.
   */
  pillar_momentum: DecisionPillarMomentum | null;
  /** Per-source health. Always present, even when fields are null. */
  source_health: DecisionSourceHealth;
}
