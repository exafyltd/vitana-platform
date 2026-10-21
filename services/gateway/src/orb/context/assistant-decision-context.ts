/**
 * B0b (orb-live-refactor): AssistantDecisionContext — the distilled,
 * decision-grade view of compiled context that the instruction layer
 * renders into the system prompt.
 *
 * **Acceptance check #3 (match-journey injection):** the `matchJourney`
 * field strictly conforms to the declared shape. Raw match rows, raw
 * chat text, raw profile payloads, and other private side-channel
 * content CANNOT pass through this schema — the zod parser uses
 * `.strict()` everywhere.
 *
 * Per the approved plan:
 *   "The instruction builder reads structured `AssistantDecisionContext`,
 *    not concatenated strings from callers."
 *   "No raw private side-channel content in compiled context."
 *
 * The B0d Continuation Contract adds `continuation?: AssistantContinuation`
 * to this shape when it ships — for now the field is reserved as optional.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

export const situationalFitSchema = z.object({
  timeAppropriateness: z.enum(['good', 'borderline', 'avoid_chirpy']),
  locationConfidence: z.enum(['high', 'low', 'unknown']),
  daylightPhase: z.enum([
    'pre_dawn', 'morning', 'midday', 'afternoon', 'golden_hour',
    'dusk', 'night', 'late_night',
  ]),
}).strict();

export const opportunityToMentionSchema = z.object({
  capability: z.string(),
  relevance: z.number(),
}).strict();

/**
 * Match-journey sub-schema — strict, additional-properties=false.
 *
 * Per acceptance check #3: any payload containing extra fields (raw
 * chat message, raw match row, profile bio, intent body, etc.) is
 * REJECTED at the compiler boundary. The compiler can read raw data
 * to *infer* state, but only the distilled fields below cross into
 * `AssistantDecisionContext`.
 */
export const decisionMatchJourneySchema = z.object({
  stage: z.enum([
    'none',
    'browsing',
    'pre_interest',
    'interest_sent',
    'mutual_match',
    'planning',
    'plan_confirmed',
    'day_of_activity',
    'post_activity',
    'next_rep_due',
  ]),
  activityKind: z.string().optional(),
  partyShape: z.enum(['one_to_one', 'group']).optional(),
  pendingUserDecision: z.enum([
    'show_interest',
    'send_opener',
    'confirm_activity_plan',
    'reply_to_match',
    'reschedule',
    'mark_activity_completed',
    'plan_next_rep',
  ]).optional(),
  recommendedNextMove: z.enum([
    'ask_should_i_show_interest',
    'stage_opener',
    'generate_activity_plan',
    'nudge_reply',
    'confirm_plan',
    'suggest_reschedule',
    'ask_rep_completed',
    'propose_next_rep',
  ]).optional(),
  warnings: z.array(z.string()).optional(),
}).strict();

// ---------------------------------------------------------------------------
// AssistantDecisionContext schema
// ---------------------------------------------------------------------------

export const assistantDecisionContextSchema = z.object({
  greetingPolicy: z.enum(['skip', 'brief_resume', 'warm_return', 'fresh_intro']),
  explanationDepth: z.enum(['terse', 'standard', 'deep']),
  privacyMode: z.enum(['private', 'shared_device', 'unknown']),
  situationalFit: situationalFitSchema,
  recommendedNextMove: z.string().optional(),
  opportunitiesToMention: z.array(opportunityToMentionSchema),
  warnings: z.array(z.string()),
  // B0d will add `continuation` here when it ships.
  matchJourney: decisionMatchJourneySchema.optional(),
}).strict();

export type AssistantDecisionContext = z.infer<typeof assistantDecisionContextSchema>;
export type DecisionMatchJourney = z.infer<typeof decisionMatchJourneySchema>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an `AssistantDecisionContext` candidate.
 *
 * Returns `{ ok: true, decision }` when the input strictly conforms to
 * the schema, or `{ ok: false, error }` when extra/forbidden fields are
 * present.
 *
 * The compiler MUST run input through this guard before forwarding to
 * the instruction layer. **This is the enforcement point for acceptance
 * check #3** — raw match rows / chat text / profiles cannot pass.
 */
export function parseAssistantDecisionContext(
  input: unknown,
): { ok: true; decision: AssistantDecisionContext } | { ok: false; error: string } {
  const result = assistantDecisionContextSchema.safeParse(input);
  if (result.success) {
    return { ok: true, decision: result.data };
  }
  return { ok: false, error: result.error.message };
}
