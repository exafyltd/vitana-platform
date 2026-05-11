/**
 * B0b (orb-live-refactor): match-journey context provider SEAM.
 *
 * **This is a placeholder — NOT an implementation of the match concierge.**
 *
 * Returns a typed `MatchJourneyContext` with `journeyStage: 'none'` for
 * every call until the activity-match concierge ships in a future slice.
 * The seam exists so:
 *   - The context compiler wires `CompiledContext.matchJourney` from day one.
 *   - The truth-policy + source-health surfaces can already account for
 *     match-journey context.
 *   - When the concierge ships, only this one file changes — the compiler,
 *     decision-context schema, continuation contract, and screen panels
 *     all stay put.
 *
 * Hard guardrails (match-journey injection):
 *   - NO raw match rows, raw chat text, raw profile payloads cross out
 *     of this provider.
 *   - NO direct memory queries — when the concierge ships, reads go
 *     through `orb/context/adapters/*` like every other context source.
 *   - NO match logic in `orb/live/instruction/` (enforced separately).
 */

import type { ClientContextEnvelope } from '../client-context-envelope';

// ---------------------------------------------------------------------------
// Output type — the distilled match-journey snapshot.
// ---------------------------------------------------------------------------

/**
 * Distilled match-journey state for the current session.
 *
 * **The compiler propagates this into `CompiledContext.matchJourney` and
 * filters down to the strict `AssistantDecisionContext.matchJourney` shape
 * (see assistant-decision-context.ts).**
 *
 * Per acceptance check #3, the strict schema rejects raw chat text, raw
 * profile payloads, etc. This shape carries ONLY distilled fields.
 */
export interface MatchJourneyContext {
  /**
   * Current journey stage. **The seam returns `'none'` for every call**
   * until the concierge ships. Tests assert this default.
   */
  journeyStage:
    | 'none'
    | 'browsing'
    | 'pre_interest'
    | 'interest_sent'
    | 'mutual_match'
    | 'planning'
    | 'plan_confirmed'
    | 'day_of_activity'
    | 'post_activity'
    | 'next_rep_due';

  matchId?: string;
  intentId?: string;
  activityKind?: string;
  partyShape?: 'one_to_one' | 'group';

  pendingUserDecision?:
    | 'show_interest'
    | 'send_opener'
    | 'confirm_activity_plan'
    | 'reply_to_match'
    | 'reschedule'
    | 'mark_activity_completed'
    | 'plan_next_rep';

  planStatus?:
    | 'none'
    | 'draft'
    | 'proposed'
    | 'confirmed'
    | 'completed'
    | 'cancelled';

  unreadMatchMessage?: boolean;

  /** ISO timestamp of the most recent match event (message, plan update, etc). */
  lastMatchEventAt?: string;

  /** Milliseconds since `lastMatchEventAt`. */
  silenceDuration?: number;

  /** ISO timestamp when the next rep activity is due. */
  nextRepDueAt?: string;

  privacyGate?: 'safe' | 'shared_device' | 'sensitive_subject';

  warnings?: string[];

  recommendedNextMove?:
    | 'ask_should_i_show_interest'
    | 'stage_opener'
    | 'generate_activity_plan'
    | 'nudge_reply'
    | 'confirm_plan'
    | 'suggest_reschedule'
    | 'ask_rep_completed'
    | 'propose_next_rep';
}

// ---------------------------------------------------------------------------
// Provider input
// ---------------------------------------------------------------------------

export interface MatchJourneyContextProviderInput {
  userId: string | null;
  tenantId: string | null;
  envelope: ClientContextEnvelope | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile match-journey context for the current session.
 *
 * **Today (B0b seam):** returns `{ journeyStage: 'none' }` for every
 * call regardless of input. The compiler wires this into
 * `CompiledContext.matchJourney` immediately so downstream consumers
 * (assistant-decision-context, command-hub panels, future B0d
 * continuation provider) can already key off the type.
 *
 * **Future (concierge slice):** this function will:
 *   - read user_matches / user_intents / activity_plans through context
 *     adapters (NOT directly)
 *   - distill state into `MatchJourneyContext`
 *   - emit the MATCH_JOURNEY_CONTEXT_COMPILED constant from
 *     `services/gateway/src/orb/context/telemetry.ts` (never as a raw
 *     string literal — the grep guard at
 *     `scripts/ci/match-journey-topics-guard.mjs` enforces this).
 *
 * The function signature is intentionally async — future implementation
 * will need awaits for memory-broker reads.
 */
export async function compileMatchJourneyContext(
  _input: MatchJourneyContextProviderInput,
): Promise<MatchJourneyContext> {
  return { journeyStage: 'none' };
}
