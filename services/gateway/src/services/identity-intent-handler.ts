/**
 * VTID-01952 — Identity Mutation Intent Handler
 *
 * Pre-LLM intercept: when the user explicitly asks to change an identity-class
 * fact (name, DOB, gender, email, phone, address, locale), this handler
 * returns the sanctioned refusal-and-redirect response so the brain doesn't
 * have to handle it. Cheaper, more deterministic, and impossible to drift.
 *
 * Callers (orb-live.ts, conversation-client.ts) check the result BEFORE
 * invoking the LLM. If detected, they short-circuit: emit the refusal text
 * + redirect_target metadata for the frontend to fire the deep-link event.
 *
 * Plan: /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md  Part 1.5
 */

import { emitOasisEvent } from './oasis-event-service';
import { composeIdentityRefusal, type SupportedLocale, type RedirectTarget } from './memory-identity-lock';
import { detectIdentityMutationIntent } from './identity-intent-detector';

export interface IdentityIntentHandlerInput {
  utterance: string;
  user_id: string;
  tenant_id: string;
  /** Preferred locale (e.g. from user_preferences); defaults to 'en'. */
  user_locale?: SupportedLocale;
  /** Source for the OASIS audit event (e.g. 'orb-live', 'conversation-client'). */
  source: string;
  /** Optional: thread/session id for trace continuity. */
  conversation_turn_id?: string;
}

export type IdentityIntentHandlerResult =
  | { handled: false }
  | {
      handled: true;
      /** Sanctioned message the brain should speak/write back. */
      message: string;
      /** Frontend deep-link event the brain emits alongside the message. */
      redirect_target: RedirectTarget;
      /** Telemetry only. */
      detected_fact_key: string;
      detected_confidence: number;
      detected_pattern: string;
    };

/**
 * Run the intent detector and, if a mutation intent is found, build the
 * sanctioned response + emit a memory.identity.write_attempted audit event
 * (allowed=false, reason='intent_intercepted_pre_llm').
 *
 * Returns { handled: false } on the common path so callers can proceed with
 * the normal LLM turn.
 */
export async function handleIdentityIntent(
  input: IdentityIntentHandlerInput
): Promise<IdentityIntentHandlerResult> {
  const intent = detectIdentityMutationIntent(input.utterance, input.user_locale);
  if (!intent.detected) {
    return { handled: false };
  }

  const refusal = composeIdentityRefusal(intent.fact_key, input.user_locale ?? intent.locale);

  // Audit: this counts as an attempted identity write that we caught BEFORE
  // it reached the broker / LLM tool / Cognee path. Mirrors the audit event
  // shape from memory-audit.ts so dashboards work uniformly.
  await emitOasisEvent({
    vtid: 'VTID-01952',
    type: 'memory.identity.write_attempted',
    source: 'identity-intent-handler',
    status: 'warning',
    message: `identity-mutation intent intercepted pre-LLM: ${intent.fact_key} (pattern: "${intent.matched_pattern}")`,
    payload: {
      fact_key: intent.fact_key,
      detected_locale: intent.locale,
      user_locale: input.user_locale ?? null,
      detected_pattern: intent.matched_pattern,
      detected_confidence: intent.confidence,
      utterance_preview: intent.utterance.slice(0, 120),
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      allowed: false,
      rejection_reason: 'intent_intercepted_pre_llm',
      redirect_target: refusal.redirect_target,
      origin_source: input.source,
      policy_version: 'mem-2026.04',
    },
    actor_id: input.user_id,
    actor_role: 'user',
    surface: input.source === 'orb-live' ? 'orb' : 'system',
    conversation_turn_id: input.conversation_turn_id,
  }).catch((err: unknown) => {
    console.warn('[VTID-01952] failed to emit identity-intent audit:', err);
  });

  return {
    handled: true,
    message: refusal.message,
    redirect_target: refusal.redirect_target,
    detected_fact_key: intent.fact_key,
    detected_confidence: intent.confidence,
    detected_pattern: intent.matched_pattern,
  };
}
