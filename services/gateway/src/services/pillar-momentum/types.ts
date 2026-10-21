/**
 * VTID-02955 (B5) — pillar-momentum types.
 *
 * Drives signals 56–60 of the AssistantDecisionContext:
 *   #56 vitana_index_delta_7d / delta_30d
 *   #57 weakest_pillar_trend
 *   #58 active_streaks                  (deferred — needs user_diary_streak view)
 *   #59 streak_at_risk_today            (deferred — same)
 *   #60 recent_diary_themes             (deferred — needs NLP pass)
 *
 * B5.0 ships the per-pillar momentum signal (#56 + #57). The other
 * three are reserved by the type shape but compiled as empty until
 * their data sources land.
 *
 * Wall (B5): pure types. No IO, no mutation. The fetcher is read-
 * only; nothing in this slice writes to user-state tables. Decision-
 * grade shape is in `orb/context/types.ts` — this richer shape is
 * for the read-only preview only.
 */

/** Canonical 5-pillar enum (post-Phase E). */
export type PillarKey =
  | 'sleep'
  | 'nutrition'
  | 'exercise'
  | 'hydration'
  | 'mental';

/**
 * Per-pillar momentum band:
 *   - 'improving'  → recent 7d average > prior 7d average by >5
 *   - 'steady'     → -5 ≤ delta ≤ +5
 *   - 'slipping'   → delta < -5
 *   - 'unknown'    → fewer than 7 days of recent data OR no prior window
 */
export type PillarMomentum = 'improving' | 'steady' | 'slipping' | 'unknown';

/**
 * Raw row from `vitana_index_scores`, narrowed to the columns this
 * service reads. NEVER crosses into the decision contract — the
 * compiler distills first.
 */
export interface VitanaIndexScoreRow {
  date: string;
  score_total: number;
  score_sleep: number | null;
  score_nutrition: number | null;
  score_exercise: number | null;
  score_hydration: number | null;
  score_mental: number | null;
}

/**
 * Per-pillar momentum entry — used by the Command Hub preview AND
 * by the decision adapter as the input shape it distills further.
 */
export interface PillarMomentumEntry {
  pillar: PillarKey;
  momentum: PillarMomentum;
  /**
   * Latest-row pillar score (0..200). For the operator preview only.
   * The decision-contract adapter DROPS this — the LLM doesn't need
   * raw numbers, only buckets/enums.
   */
  latest_score: number | null;
  /**
   * Number of distinct days in the recent 7-day window with this
   * pillar score present. Used by the compiler for confidence; the
   * decision adapter drops it.
   */
  recent_window_days: number;
}

/**
 * Compiled pillar-momentum context — what the Command Hub preview
 * surface consumes, and what the decision adapter distills further.
 */
export interface PillarMomentumContext {
  /** Per-pillar momentum, one entry per canonical pillar. */
  per_pillar: ReadonlyArray<PillarMomentumEntry>;
  /** Pillar with the lowest latest score, or null if no data. */
  weakest_pillar: PillarKey | null;
  /** Pillar with the highest latest score, or null if no data. */
  strongest_pillar: PillarKey | null;
  /**
   * Suggested focus pillar — the weakest pillar IF its momentum is
   * 'slipping' or 'unknown', otherwise the weakest one regardless
   * (still useful as guidance). Null when no pillar data exists.
   */
  suggested_focus: PillarKey | null;
  /**
   * Coarse confidence: 'high' when we have ≥7 days in both windows
   * for ≥4 pillars; 'medium' for partial coverage; 'low' otherwise.
   * The decision adapter passes this through unchanged.
   */
  confidence: 'low' | 'medium' | 'high';
  /** Index history sample size used for the compilation. */
  history_days_sampled: number;
  /**
   * Source-health view — empty rows + a `reason` is "user has no
   * Index history yet", not a failure. Failures surface here.
   */
  source_health: {
    vitana_index_scores: { ok: boolean; reason?: string };
  };
}
