/**
 * VTID-02941 (B0b-min) — AssistantDecisionContext: the decision contract.
 *
 * This is the SINGLE typed shape the instruction layer reads to assemble
 * a prompt. Raw rows (memory, threads, messages, promises, profiles)
 * MUST NOT cross this boundary. The compiler distills; the renderer
 * formats. No exceptions.
 *
 * Wall (B0b-min):
 *   - Forbidden in this slice: match journey, feature discovery, wake
 *     brief, continuation contract, greeting decay rewrite, repetition
 *     suppression, journey stage modulation, reliability tuning.
 *   - Only `continuity` is wired through this contract in this PR.
 *   - Adding new fields later is fine; pushing raw rows into them is not.
 *
 * Why this file is in `services/gateway/src/orb/context/`:
 *   The plan's target module layout puts the context spine under
 *   `services/gateway/src/orb/context/`. We honor that path so future
 *   slices land in the same place rather than creating a parallel tree.
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
 * Per-source health view. Empty/missing rows are not failures — they
 * just mean the user has no continuity state yet. Failures (Supabase
 * down, schema mismatch, etc.) surface here with a `reason`.
 */
export interface DecisionSourceHealth {
  continuity: { ok: boolean; reason?: string };
}

/**
 * The single typed contract the instruction layer reads.
 *
 * Future slices add fields (matchJourney, conceptMastery, journeyStage,
 * etc.) — they MUST land here as distilled shapes, never raw rows.
 *
 * `additionalProperties=false` semantics are enforced by tests + the
 * renderer's behavior: any unrecognized field is silently dropped.
 */
export interface AssistantDecisionContext {
  /**
   * Continuity decision view. `null` when the compiler had no input or
   * source-health is degraded — the renderer must emit no continuity
   * section in that case (acceptance #1 + #6).
   */
  continuity: DecisionContinuity | null;
  /** Per-source health. Always present, even when fields are null. */
  source_health: DecisionSourceHealth;
}
