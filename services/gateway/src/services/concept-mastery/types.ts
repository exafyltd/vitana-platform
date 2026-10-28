/**
 * VTID-02936 (B3) — concept-mastery types.
 *
 * Drives signals 46–50 of the AssistantDecisionContext:
 *   #46 concepts_explained_count
 *   #47 concepts_user_demonstrated_mastery
 *   #48 dyk_cards_seen
 *   #49 explanation_depth_preference   (deferred — needs session-buffer pass)
 *   #50 vocabulary_user_uses           (deferred — needs NLP pass)
 *
 * Wall (B3): pure types. No IO, no mutation. The fetcher is read-
 * only; state advancement (incrementing concept_explained_count,
 * marking mastery, recording dyk_card_seen) is a follow-up slice
 * with its own dedicated event endpoint + OASIS event emission.
 */

/**
 * Source of a `user_assistant_state` row that B3 cares about. We
 * encode the family in the `signal_name` prefix:
 *
 *   concept_explained:<concept_key>   → ConceptExplainedRow
 *   concept_mastery:<concept_key>     → ConceptMasteryRow
 *   dyk_card_seen:<card_key>          → DykCardSeenRow
 *
 * Anything else in `user_assistant_state` is opaque to B3 and stays
 * outside this module.
 */
export type AssistantStateFamily =
  | 'concept_explained'
  | 'concept_mastery'
  | 'dyk_card_seen';

export interface ConceptExplainedRow {
  /** Stable key for the concept, e.g. 'vitana_index', 'life_compass', 'memory_garden'. */
  concept_key: string;
  /** How many times Vitana has explained this concept to this user. */
  count: number;
  /** Last time it was explained (ISO timestamp). */
  last_explained_at: string;
  /** Optional source ('orb_turn', 'autopilot', etc.). */
  source: string | null;
}

export interface ConceptMasteryRow {
  /** Stable key for the concept. */
  concept_key: string;
  /** Confidence 0..1 that the user has internalized this concept. */
  confidence: number | null;
  /** Last time mastery was observed (ISO timestamp). */
  last_observed_at: string;
  /** Where the mastery signal came from. */
  source: string | null;
}

export interface DykCardSeenRow {
  /** Stable key for the card, e.g. 'dyk_index_intro', 'dyk_life_compass'. */
  card_key: string;
  /** Number of times surfaced. */
  count: number;
  /** Last time the card was surfaced (ISO timestamp). */
  last_seen_at: string;
}

/**
 * Compiled concept-mastery context — what the assistant decision
 * layer consumes for repetition suppression. Distilled from raw
 * `user_assistant_state` rows; never carries them verbatim.
 *
 * Mirrors the B0b spirit: the prompt sees the distilled view, never
 * the raw DB rows.
 */
export interface ConceptMasteryContext {
  /** Signal #46 — concepts already explained, most-recent first. */
  concepts_explained: Array<{
    concept_key: string;
    count: number;
    last_explained_at: string;
    days_since_last_explained: number | null;
    /**
     * Suggested action for the decision layer:
     *   - 'first_time'     → never explained; safe to explain fully
     *   - 'one_liner'      → explained once; remind in one line
     *   - 'skip'           → explained 3+ times OR mastery observed
     */
    repetition_hint: 'first_time' | 'one_liner' | 'skip';
  }>;
  /** Signal #47 — concepts the user has demonstrated mastery of. */
  concepts_mastered: Array<{
    concept_key: string;
    confidence: number | null;
    last_observed_at: string;
  }>;
  /** Signal #48 — DYK cards already surfaced. */
  dyk_cards_seen: Array<{
    card_key: string;
    count: number;
    last_seen_at: string;
    days_since_last_seen: number | null;
  }>;
  /** Aggregate counts the cadence layer uses. */
  counts: {
    concepts_explained_total: number;
    concepts_mastered_total: number;
    dyk_cards_seen_total: number;
    concepts_explained_in_last_24h: number;
  };
  /**
   * Source-health view — empty arrays + a `reason` is "user has no
   * concept state yet", not a failure. Failures surface here.
   */
  source_health: {
    user_assistant_state: { ok: boolean; reason?: string };
  };
}
