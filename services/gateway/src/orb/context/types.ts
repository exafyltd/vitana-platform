/**
 * VTID-02941 (B0b-min) — AssistantDecisionContext: the decision contract.
 * VTID-02950 (F2)     — adds conceptMastery field.
 *
 * This is the SINGLE typed shape the instruction layer reads to assemble
 * a prompt. Raw rows (memory, threads, messages, promises, profiles,
 * concept rows, scores, transcripts) MUST NOT cross this boundary. The
 * compiler distills; the renderer formats. No exceptions.
 *
 * Wall:
 *   - Forbidden: match journey, feature discovery, wake brief,
 *     continuation contract, greeting decay rewrite, journey stage
 *     modulation, reliability tuning. Each gets its own slice.
 *   - Continuity (B2) + conceptMastery (B3) are wired through this
 *     contract.
 *   - Adding new fields later is fine; pushing raw rows into them is not.
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
 * Per-source health view. Empty/missing rows are not failures — they
 * just mean the user has no state yet. Failures (Supabase down, schema
 * mismatch, etc.) surface here with a `reason`.
 */
export interface DecisionSourceHealth {
  continuity: { ok: boolean; reason?: string };
  /** F2: concept-mastery source health. */
  concept_mastery: { ok: boolean; reason?: string };
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
  /** Per-source health. Always present, even when fields are null. */
  source_health: DecisionSourceHealth;
}
