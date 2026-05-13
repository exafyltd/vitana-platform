/**
 * VTID-02962 (B6) — InteractionStyle → AssistantDecisionContext adapter.
 *
 * The B6 read-only compile slice produced `InteractionStyleContext`,
 * a richer shape designed for the Command Hub operator. The assistant
 * decision layer reads a NARROWER shape (`DecisionInteractionStyle`)
 * that strips:
 *   - raw `last_updated_at` ISO timestamp
 *   - operator-only `source_health` envelope (the orchestrator
 *     re-builds source-health at the AssistantDecisionContext level)
 *   - anything that could leak chat-message bodies, raw transcripts,
 *     raw memory rows, route history, or free-text psychological
 *     summary into the prompt
 *
 * Kept: bucketed enum preferences, explanation-depth hint already
 * decision-grade, coarse confidence band, and enum-only warnings.
 *
 * NEVER carries:
 *   - medical interpretation
 *   - mental-health inference
 *   - diagnostic-feeling personality labels
 *   - free-text psychological summaries
 *
 * Pure function. No IO. The caller is responsible for invoking the
 * interaction-style compiler + passing its output here.
 */

import type { InteractionStyleContext } from '../../../services/interaction-style/types';
import type {
  DecisionInteractionStyle,
  InteractionStyleWarning,
} from '../types';

export interface DistillInteractionStyleInputs {
  /**
   * Output of `compileInteractionStyleContext` from B6. Read-only.
   */
  interactionStyle: InteractionStyleContext;
}

/**
 * Distills `InteractionStyleContext` into the decision-grade
 * `DecisionInteractionStyle`.
 *
 * Always returns a typed shape (never undefined). The caller decides
 * whether to attach it to `AssistantDecisionContext.interaction_style`
 * or set the field to `null` based on source health.
 */
export function distillInteractionStyleForDecision(
  input: DistillInteractionStyleInputs,
): DecisionInteractionStyle {
  const { interactionStyle } = input;

  const warnings = computeDecisionWarnings(interactionStyle);

  return {
    preferred_response_style: interactionStyle.preferred_response_style,
    interaction_pace: interactionStyle.interaction_pace,
    tone_preference: interactionStyle.tone_preference,
    explanation_depth_hint: interactionStyle.explanation_depth_hint,
    confidence_bucket: interactionStyle.confidence_bucket,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Computes the enum-only warning list. NEVER free-text strings,
 * NEVER diagnostic labels, NEVER medical interpretation.
 *
 * `no_recorded_preferences` fires when EVERY preference enum
 *  resolves to 'unknown' — i.e., the user has no stored signal.
 *  Note that `explanation_depth_hint` is excluded from this check
 *  because the compiler defaults it to 'normal' even with no input.
 *
 * `low_signal_confidence` fires when the bucketed confidence is
 *  'low' or 'unknown'.
 */
export function computeDecisionWarnings(
  ctx: InteractionStyleContext,
): ReadonlyArray<InteractionStyleWarning> {
  const out: InteractionStyleWarning[] = [];

  const allUnknown =
    ctx.preferred_response_style === 'unknown' &&
    ctx.interaction_pace === 'unknown' &&
    ctx.tone_preference === 'unknown';
  if (allUnknown) {
    out.push('no_recorded_preferences');
  }

  if (ctx.confidence_bucket === 'low' || ctx.confidence_bucket === 'unknown') {
    out.push('low_signal_confidence');
  }

  return out;
}
