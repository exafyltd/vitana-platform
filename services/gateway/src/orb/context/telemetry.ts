/**
 * B0b (orb-live-refactor): central OASIS topic constants for the
 * context layer.
 *
 * **Hard guardrail (match-journey injection acceptance check #7):**
 *
 * All `assistant.context.match_journey.*`, `assistant.continuation.match_journey.*`,
 * and `assistant.match.*` OASIS topic strings MUST come from this module.
 * Any other file referencing those topic strings as raw literals fails the
 * build-time grep guard at `scripts/ci/match-journey-topics-guard.mjs`.
 *
 * Why: when the match concierge ships in a future slice, the 13 reserved
 * names must be emitted consistently across all providers. Scattered
 * string literals create naming drift (`assistant.match_journey.compiled`
 * vs `assistant.context.match_journey.compiled` vs `match.journey.compiled`)
 * that breaks downstream rollups.
 *
 * Naming follows the existing OASIS taxonomy (see CLAUDE.md §6):
 *   - `assistant.context.*` — context-compiler decisions / source health
 *   - `assistant.continuation.*` — continuation contract events (B0d)
 *   - `assistant.match.*` — concierge-product events (future slices)
 */

// ---------------------------------------------------------------------------
// Context-layer events (B0b emits these; concierge does not)
// ---------------------------------------------------------------------------

export const CONTEXT_SOURCE_DEGRADED = 'assistant.context_source_degraded' as const;

// ---------------------------------------------------------------------------
// Match-journey context events (B0b reserves the names; the seam emits
// .compiled on every call, but the concierge populates .suppressed)
// ---------------------------------------------------------------------------

export const MATCH_JOURNEY_CONTEXT_COMPILED   = 'assistant.context.match_journey.compiled' as const;
export const MATCH_JOURNEY_CONTEXT_SUPPRESSED = 'assistant.context.match_journey.suppressed' as const;

// ---------------------------------------------------------------------------
// Match-journey continuation events (B0d wires; this module reserves)
// ---------------------------------------------------------------------------

export const MATCH_JOURNEY_CONTINUATION_SUGGESTED = 'assistant.continuation.match_journey.suggested' as const;
export const MATCH_JOURNEY_CONTINUATION_ACCEPTED  = 'assistant.continuation.match_journey.accepted'  as const;
export const MATCH_JOURNEY_CONTINUATION_DISMISSED = 'assistant.continuation.match_journey.dismissed' as const;
export const MATCH_JOURNEY_CONTINUATION_SUPPRESSED = 'assistant.continuation.match_journey.suppressed' as const;

// ---------------------------------------------------------------------------
// Match concierge product events (future slices emit these — RESERVED ONLY)
// ---------------------------------------------------------------------------

export const MATCH_PRE_WHOIS_OPENED         = 'assistant.match.pre_whois.opened'         as const;
export const MATCH_SHOULD_INTEREST_GENERATED = 'assistant.match.should_interest.generated' as const;
export const MATCH_DRAFT_OPENER_STAGED      = 'assistant.match.draft_opener.staged'      as const;
export const MATCH_ACTIVITY_PLAN_PROPOSED   = 'assistant.match.activity_plan.proposed'   as const;
export const MATCH_ACTIVITY_PLAN_CONFIRMED  = 'assistant.match.activity_plan.confirmed'  as const;
export const MATCH_CHAT_ASSIST_SUGGESTED    = 'assistant.match.chat_assist.suggested'    as const;
export const MATCH_POST_ACTIVITY_PROMPTED   = 'assistant.match.post_activity.prompted'   as const;
export const MATCH_NEXT_REP_PROPOSED        = 'assistant.match.next_rep.proposed'        as const;

// ---------------------------------------------------------------------------
// Aggregate registry — used by the grep guard test (acceptance check #7).
// ---------------------------------------------------------------------------

/**
 * Every reserved match-journey OASIS topic string, exported as a
 * tuple. The build-time guard at scripts/ci/match-journey-topics-guard.mjs
 * verifies every string in this list appears ONLY in this module
 * (and `services/gateway/src/services/assistant-continuation/telemetry.ts`
 * when B0d ships). Any other file referencing one of these strings as
 * a raw literal fails CI.
 */
export const MATCH_JOURNEY_TOPIC_REGISTRY = [
  // context
  MATCH_JOURNEY_CONTEXT_COMPILED,
  MATCH_JOURNEY_CONTEXT_SUPPRESSED,
  // continuation (reserved here; B0d's telemetry module will mirror)
  MATCH_JOURNEY_CONTINUATION_SUGGESTED,
  MATCH_JOURNEY_CONTINUATION_ACCEPTED,
  MATCH_JOURNEY_CONTINUATION_DISMISSED,
  MATCH_JOURNEY_CONTINUATION_SUPPRESSED,
  // product
  MATCH_PRE_WHOIS_OPENED,
  MATCH_SHOULD_INTEREST_GENERATED,
  MATCH_DRAFT_OPENER_STAGED,
  MATCH_ACTIVITY_PLAN_PROPOSED,
  MATCH_ACTIVITY_PLAN_CONFIRMED,
  MATCH_CHAT_ASSIST_SUGGESTED,
  MATCH_POST_ACTIVITY_PROMPTED,
  MATCH_NEXT_REP_PROPOSED,
] as const;
