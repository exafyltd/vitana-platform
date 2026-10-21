/**
 * VTID-02962 (B6) — interaction-style types.
 *
 * Drives the user's stable preferences for how the assistant talks
 * to them: response verbosity, pace, tone, explanation depth, and a
 * confidence band. Kept deliberately coarse — never raw chat metrics,
 * never psychological labels, never anything that reads as a
 * diagnosis.
 *
 * Source: a single row of `user_assistant_state` with
 * `signal_name = 'interaction_style_v1'`. The JSONB `value` carries
 * the preference fields below. The row may be absent (user has no
 * recorded preference yet) — that is the steady-state default.
 *
 * Wall (B6): pure types. No IO, no mutation. Decision-grade shape
 * is in `orb/context/types.ts` — this richer shape is for the
 * Command Hub operator preview AND as the input the decision
 * adapter narrows.
 */

import type {
  InteractionExplanationDepth,
  InteractionPace,
  InteractionStyleConfidenceBucket,
  PreferredResponseStyle,
  TonePreference,
} from '../../orb/context/types';

/**
 * Allowed sources of the interaction-style signal. Useful in the
 * operator preview to distinguish user-set from inferred state, but
 * dropped from the decision contract — the LLM doesn't need to know.
 */
export type InteractionStyleSource = 'user_set' | 'inferred' | 'admin';

/**
 * Raw JSONB payload stored under
 * `user_assistant_state.value` for `signal_name = 'interaction_style_v1'`.
 *
 * Every field is optional — partial writes are fine, the compiler
 * fills the gaps with 'unknown'. Numbers (`confidence`) are bucketed
 * by the compiler so the decision contract never sees raw floats.
 */
export interface InteractionStyleSignalValue {
  response_style?: Exclude<PreferredResponseStyle, 'unknown'>;
  pace?: Exclude<InteractionPace, 'unknown'>;
  tone?: Exclude<TonePreference, 'unknown'>;
  explanation_depth?: InteractionExplanationDepth;
  /** 0..1 — bucketed by the compiler. */
  confidence?: number;
  source?: InteractionStyleSource;
}

/**
 * Narrowed `user_assistant_state` row. The fetcher returns this shape
 * (not the raw Supabase row) so the compiler is decoupled from the
 * physical table layout.
 */
export interface InteractionStyleSignalRow {
  /** JSONB payload — may be missing fields. */
  value: InteractionStyleSignalValue;
  /** Stored confidence on the row itself (separate from value.confidence). */
  confidence: number | null;
  /** When the row was last touched. Operator-view only; the decision
   *  adapter drops this — the LLM doesn't read raw timestamps. */
  updated_at: string | null;
  /** When the signal was last observed/written. Operator-view only. */
  last_seen_at: string | null;
}

/**
 * Compiled interaction-style context — what the Command Hub preview
 * surface consumes, and what the decision adapter distills further.
 *
 * Compared to `DecisionInteractionStyle`, the compiled shape additionally
 * carries `last_updated_at` for the operator view. The decision adapter
 * DROPS that field — the LLM has no use for a raw timestamp.
 */
export interface InteractionStyleContext {
  /** Preferred verbosity. Enum-only. */
  preferred_response_style: PreferredResponseStyle;
  /** Preferred conversational pace. Enum-only. */
  interaction_pace: InteractionPace;
  /** Preferred tone from the assistant. Enum-only. */
  tone_preference: TonePreference;
  /**
   * Explanation depth hint. Defaults to 'normal' when no signal is
   * available — the renderer treats this as a usable steady-state
   * value, not as a degraded one.
   */
  explanation_depth_hint: InteractionExplanationDepth;
  /** Coarse confidence band. */
  confidence_bucket: InteractionStyleConfidenceBucket;
  /**
   * ISO timestamp of the last preference write. Operator-view only;
   * the decision adapter drops it.
   */
  last_updated_at: string | null;
  /**
   * Source-health view — empty row + a `reason` of
   * 'no_interaction_style_row' is "user has no recorded preference yet",
   * not a failure. Failures (table missing, supabase down) surface here.
   */
  source_health: {
    user_assistant_state: { ok: boolean; reason?: string };
  };
}
