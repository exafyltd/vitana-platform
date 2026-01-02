/**
 * VTID-01123: Response Framing & Delivery Control Engine
 *
 * Deterministic Response Framing Engine that controls how intelligence is delivered,
 * independent of what is decided. Ensures right depth, right tone, right moment.
 *
 * Core Principles:
 * - Same inputs → same response profile (determinism)
 * - No stylistic randomness
 * - Framing is rule-based, not creative
 *
 * Hard Constraints:
 * - ❌ No mismatch with safety outcome (D30)
 * - ❌ No overconfidence when confidence_score is low
 * - ❌ No verbose output when cognitive load is high
 * - ✅ Preferences always override defaults
 *
 * Position in Intelligence Stack:
 *   Decision + Safety → D31 Response Framing → Output Generation
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { CicdEventType } from '../types/cicd';
import {
  ResponseProfile,
  FramingInputBundle,
  FramingDecisionRecord,
  FramingOverride,
  FramingRationaleCode,
  DepthLevel,
  ResponseTone,
  ResponsePacing,
  DirectnessLevel,
  ConfidenceExpression,
  DEFAULT_RESPONSE_PROFILE,
  COGNITIVE_LOAD_THRESHOLDS,
  ENGAGEMENT_THRESHOLDS,
  CONFIDENCE_THRESHOLDS,
} from '../types/response-framing';

// =============================================================================
// VTID-01123: Core Framing Engine
// =============================================================================

/**
 * Compute depth level based on inputs.
 * Deterministic rules:
 * - High cognitive load → reduce depth
 * - Time constraint → reduce depth
 * - High engagement → increase depth
 * - Explicit preference → override
 */
function computeDepth(input: FramingInputBundle): { depth: DepthLevel; rationale: FramingRationaleCode } {
  // Hard constraint: High cognitive load forces summary/moderate
  if (input.signals.cognitive_load >= COGNITIVE_LOAD_THRESHOLDS.HIGH) {
    return { depth: 'summary', rationale: 'depth_reduced_cognitive_load' };
  }

  // Time constraint reduces depth
  if (input.preferences.time_constrained) {
    return { depth: 'summary', rationale: 'depth_reduced_time_constraint' };
  }

  // High engagement allows more depth
  if (input.signals.engagement_level >= ENGAGEMENT_THRESHOLDS.HIGH) {
    // If intent is clear and confidence is high, provide detailed response
    if (input.intent.intent_confidence >= CONFIDENCE_THRESHOLDS.CONFIDENT) {
      return { depth: 'detailed', rationale: 'depth_increased_engagement' };
    }
    return { depth: 'moderate', rationale: 'depth_default_moderate' };
  }

  // User preference for detailed responses
  if (input.preferences.preferred_length === 'detailed') {
    return { depth: 'detailed', rationale: 'depth_increased_explicit_request' };
  }

  // User preference for brief responses
  if (input.preferences.preferred_length === 'brief') {
    return { depth: 'summary', rationale: 'depth_reduced_time_constraint' };
  }

  // Default: moderate depth
  return { depth: 'moderate', rationale: 'depth_default_moderate' };
}

/**
 * Compute tone based on emotional signals and safety.
 * Deterministic rules:
 * - Distressed user → supportive
 * - Anxious user → supportive/calming
 * - High stress → calming
 * - Positive user → can be energetic
 * - Professional context → factual
 * - User preference overrides
 */
function computeTone(input: FramingInputBundle): { tone: ResponseTone; rationale: FramingRationaleCode } {
  // Safety-first: distressed users get supportive tone
  if (input.signals.emotional_state === 'distressed') {
    return { tone: 'supportive', rationale: 'tone_supportive_distress' };
  }

  // Anxious users get supportive tone
  if (input.signals.emotional_state === 'anxious') {
    return { tone: 'supportive', rationale: 'tone_supportive_anxiety' };
  }

  // Elevated stress gets calming tone
  if (input.signals.stress_elevated) {
    return { tone: 'calming', rationale: 'tone_calming_stress' };
  }

  // Positive emotional state can receive energetic tone
  if (input.signals.emotional_state === 'positive' && input.signals.engagement_level >= ENGAGEMENT_THRESHOLDS.HIGH) {
    return { tone: 'energetic', rationale: 'tone_energetic_positive' };
  }

  // Professional communication style gets factual tone
  if (input.preferences.communication_style === 'professional') {
    return { tone: 'factual', rationale: 'tone_factual_professional' };
  }

  // User preference override
  if (input.preferences.preferred_tone) {
    return { tone: input.preferences.preferred_tone, rationale: 'tone_user_preference' };
  }

  // Default: neutral tone
  return { tone: 'neutral', rationale: 'tone_neutral_default' };
}

/**
 * Compute pacing based on cognitive state and task complexity.
 * Deterministic rules:
 * - High cognitive load → short
 * - Time constrained → short
 * - Confused user → step-by-step
 * - Multi-step task → step-by-step
 * - Default → normal
 */
function computePacing(input: FramingInputBundle): { pacing: ResponsePacing; rationale: FramingRationaleCode } {
  // High cognitive load needs short, digestible responses
  if (input.signals.cognitive_load >= COGNITIVE_LOAD_THRESHOLDS.HIGH) {
    return { pacing: 'short', rationale: 'pacing_short_cognitive_load' };
  }

  // Time constraint needs short responses
  if (input.preferences.time_constrained) {
    return { pacing: 'short', rationale: 'pacing_short_time_constraint' };
  }

  // Confused users benefit from step-by-step guidance
  if (input.signals.emotional_state === 'confused') {
    return { pacing: 'step-by-step', rationale: 'pacing_step_by_step_confused' };
  }

  // Multi-step tasks benefit from step-by-step structure
  if (input.routing.multi_step) {
    return { pacing: 'step-by-step', rationale: 'pacing_step_by_step_multi_step' };
  }

  // Default: normal pacing
  return { pacing: 'normal', rationale: 'pacing_normal_default' };
}

/**
 * Compute directness based on intent and context.
 * Deterministic rules:
 * - Seeking action → explicit
 * - Sensitive domain (safety) → suggestive
 * - Default → balanced
 */
function computeDirectness(input: FramingInputBundle): { directness: DirectnessLevel; rationale: FramingRationaleCode } {
  // User seeking action gets explicit recommendations
  if (input.intent.seeking_action && input.intent.intent_confidence >= CONFIDENCE_THRESHOLDS.CONFIDENT) {
    return { directness: 'explicit', rationale: 'directness_explicit_action_seeking' };
  }

  // Safety domain requires more careful, suggestive approach
  if (input.routing.domain === 'safety' || input.safety.requires_safety_framing) {
    return { directness: 'suggestive', rationale: 'directness_suggestive_sensitive' };
  }

  // Health domain with professional recommendations should be suggestive
  if (input.routing.domain === 'health' && input.safety.recommend_professional) {
    return { directness: 'suggestive', rationale: 'directness_suggestive_sensitive' };
  }

  // Default: balanced directness
  return { directness: 'balanced', rationale: 'directness_balanced_default' };
}

/**
 * Compute confidence expression based on intent confidence and context.
 * Deterministic rules:
 * - Low confidence score → probabilistic/uncertain
 * - Minimal context → uncertain
 * - High confidence → confident/certain
 * - HARD CONSTRAINT: Never express overconfidence with low scores
 */
function computeConfidenceExpression(
  input: FramingInputBundle
): { confidence: ConfidenceExpression; rationale: FramingRationaleCode } {
  const intentConfidence = input.intent.intent_confidence;
  const contextAvailable = input.routing.context_available;

  // HARD CONSTRAINT: Low confidence must not be expressed as certain
  if (intentConfidence < CONFIDENCE_THRESHOLDS.UNCERTAIN) {
    return { confidence: 'uncertain', rationale: 'confidence_uncertain_minimal_context' };
  }

  // Minimal context requires probabilistic expression
  if (contextAvailable === 'none' || contextAvailable === 'minimal') {
    if (intentConfidence < CONFIDENCE_THRESHOLDS.PROBABILISTIC) {
      return { confidence: 'uncertain', rationale: 'confidence_uncertain_minimal_context' };
    }
    return { confidence: 'probabilistic', rationale: 'confidence_probabilistic_low_score' };
  }

  // High confidence with good context can be certain
  if (intentConfidence >= CONFIDENCE_THRESHOLDS.CERTAIN && contextAvailable === 'rich') {
    return { confidence: 'certain', rationale: 'confidence_certain_default' };
  }

  // Good confidence with moderate+ context
  if (intentConfidence >= CONFIDENCE_THRESHOLDS.CONFIDENT) {
    return { confidence: 'confident', rationale: 'confidence_confident_high_score' };
  }

  // Moderate confidence
  return { confidence: 'probabilistic', rationale: 'confidence_probabilistic_low_score' };
}

/**
 * Apply safety constraints to the profile.
 * Safety overrides all other considerations.
 */
function applySafetyConstraints(
  profile: ResponseProfile,
  input: FramingInputBundle,
  overrides: FramingOverride[],
  rationales: FramingRationaleCode[]
): void {
  // Safety-critical situations require supportive/calming tone
  if (input.safety.concern_level === 'high' || input.safety.concern_level === 'critical') {
    if (profile.tone !== 'supportive' && profile.tone !== 'calming') {
      overrides.push({
        dimension: 'tone',
        original_value: profile.tone,
        applied_value: 'supportive',
        reason: 'override_safety_constraint',
      });
      profile.tone = 'supportive';
      rationales.push('override_safety_constraint');
    }
  }

  // Safety framing required means suggestive directness
  if (input.safety.requires_safety_framing && profile.directness === 'explicit') {
    overrides.push({
      dimension: 'directness',
      original_value: profile.directness,
      applied_value: 'suggestive',
      reason: 'override_safety_constraint',
    });
    profile.directness = 'suggestive';
    rationales.push('override_safety_constraint');
  }
}

/**
 * Apply user preference overrides.
 * Preferences override computed values (except safety constraints).
 */
function applyUserPreferences(
  profile: ResponseProfile,
  input: FramingInputBundle,
  overrides: FramingOverride[],
  rationales: FramingRationaleCode[]
): void {
  // Preferred tone override
  if (input.preferences.preferred_tone && profile.tone !== input.preferences.preferred_tone) {
    // Only override if not a safety-critical situation
    if (!input.safety.requires_safety_framing && input.safety.concern_level !== 'high' && input.safety.concern_level !== 'critical') {
      overrides.push({
        dimension: 'tone',
        original_value: profile.tone,
        applied_value: input.preferences.preferred_tone,
        reason: 'override_user_preference',
      });
      profile.tone = input.preferences.preferred_tone;
      rationales.push('override_user_preference');
    }
  }

  // Preferred length affects depth
  if (input.preferences.preferred_length === 'brief' && profile.depth_level !== 'summary') {
    // Only reduce, never increase against cognitive load
    if (input.signals.cognitive_load < COGNITIVE_LOAD_THRESHOLDS.HIGH) {
      overrides.push({
        dimension: 'depth_level',
        original_value: profile.depth_level,
        applied_value: 'summary',
        reason: 'override_user_preference',
      });
      profile.depth_level = 'summary';
      rationales.push('override_user_preference');
    }
  }
}

// =============================================================================
// VTID-01123: Main Framing Function
// =============================================================================

/**
 * Compute the response profile for a given set of framing inputs.
 * This is the main entry point for the Response Framing Engine.
 *
 * Guarantees:
 * - Deterministic: Same inputs always produce same outputs
 * - Rule-based: No randomness or creativity
 * - Traceable: Full decision record for explainability
 *
 * @param input - The complete framing input bundle
 * @returns FramingDecisionRecord with profile, overrides, and rationale
 */
export function computeResponseProfile(input: FramingInputBundle): FramingDecisionRecord {
  const decisionId = `framing_${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const overrides: FramingOverride[] = [];
  const rationales: FramingRationaleCode[] = [];

  // Step 1: Compute each dimension independently
  const { depth, rationale: depthRationale } = computeDepth(input);
  const { tone, rationale: toneRationale } = computeTone(input);
  const { pacing, rationale: pacingRationale } = computePacing(input);
  const { directness, rationale: directnessRationale } = computeDirectness(input);
  const { confidence, rationale: confidenceRationale } = computeConfidenceExpression(input);

  // Collect initial rationales
  rationales.push(depthRationale, toneRationale, pacingRationale, directnessRationale, confidenceRationale);

  // Step 2: Build initial profile
  const profile: ResponseProfile = {
    depth_level: depth,
    tone: tone,
    pacing: pacing,
    directness: directness,
    confidence_expression: confidence,
  };

  // Step 3: Apply safety constraints (highest priority)
  applySafetyConstraints(profile, input, overrides, rationales);

  // Step 4: Apply user preferences (can override except for safety)
  applyUserPreferences(profile, input, overrides, rationales);

  // Step 5: Build decision record
  const decisionRecord: FramingDecisionRecord = {
    decision_id: decisionId,
    timestamp,
    response_profile: profile,
    applied_overrides: overrides,
    rationale_codes: [...new Set(rationales)], // Deduplicate
    input_summary: {
      intent_type: input.intent.intent_type,
      intent_confidence: input.intent.intent_confidence,
      domain: input.routing.domain,
      emotional_state: input.signals.emotional_state,
      cognitive_load: input.signals.cognitive_load,
      engagement_level: input.signals.engagement_level,
      safety_concern_level: input.safety.concern_level || 'none',
      user_preferences_applied: overrides.some(o => o.reason === 'override_user_preference'),
    },
  };

  return decisionRecord;
}

// =============================================================================
// VTID-01123: Simplified Framing for Common Cases
// =============================================================================

/**
 * Quick framing for simple queries with minimal input.
 * Uses sensible defaults for missing signals.
 */
export function computeSimpleResponseProfile(params: {
  intent_type: string;
  intent_confidence: number;
  domain?: 'health' | 'community' | 'offers' | 'general' | 'safety';
  emotional_state?: 'neutral' | 'positive' | 'anxious' | 'frustrated' | 'confused' | 'distressed';
  cognitive_load?: number;
  time_constrained?: boolean;
}): FramingDecisionRecord {
  const input: FramingInputBundle = {
    intent: {
      intent_type: params.intent_type,
      intent_confidence: params.intent_confidence,
      seeking_action: false,
    },
    routing: {
      domain: params.domain || 'general',
      multi_step: false,
      context_available: 'moderate',
    },
    signals: {
      emotional_state: params.emotional_state || 'neutral',
      cognitive_load: params.cognitive_load ?? 50,
      engagement_level: 50,
      stress_elevated: false,
      fatigue_detected: false,
    },
    preferences: {
      time_constrained: params.time_constrained || false,
    },
    safety: {
      safe: true,
      requires_safety_framing: false,
      recommend_professional: false,
    },
  };

  return computeResponseProfile(input);
}

// =============================================================================
// VTID-01123: Profile Description Helpers
// =============================================================================

/**
 * Generate human-readable description of the response profile.
 * Useful for logging and debugging.
 */
export function describeProfile(profile: ResponseProfile): string {
  const parts: string[] = [];

  // Depth description
  switch (profile.depth_level) {
    case 'summary':
      parts.push('Keep response brief and focused');
      break;
    case 'moderate':
      parts.push('Provide balanced detail');
      break;
    case 'detailed':
      parts.push('Include comprehensive information');
      break;
    case 'comprehensive':
      parts.push('Provide exhaustive coverage');
      break;
  }

  // Tone description
  switch (profile.tone) {
    case 'supportive':
      parts.push('Use supportive and empathetic language');
      break;
    case 'calming':
      parts.push('Use calm and reassuring tone');
      break;
    case 'energetic':
      parts.push('Use positive and energetic language');
      break;
    case 'factual':
      parts.push('Keep tone professional and factual');
      break;
    case 'neutral':
      parts.push('Maintain neutral tone');
      break;
  }

  // Pacing description
  switch (profile.pacing) {
    case 'short':
      parts.push('Use short, direct sentences');
      break;
    case 'step-by-step':
      parts.push('Present information step by step');
      break;
    case 'conversational':
      parts.push('Use conversational flow');
      break;
    case 'normal':
      parts.push('Use standard pacing');
      break;
  }

  // Confidence expression
  switch (profile.confidence_expression) {
    case 'uncertain':
      parts.push('Express uncertainty where applicable');
      break;
    case 'probabilistic':
      parts.push('Use probabilistic language (e.g., "likely", "may")');
      break;
    case 'confident':
      parts.push('Express reasonable confidence');
      break;
    case 'certain':
      parts.push('Express high confidence');
      break;
  }

  return parts.join('. ') + '.';
}

/**
 * Generate system instruction prefix based on response profile.
 * Can be prepended to prompts to guide response generation.
 */
export function generateFramingInstruction(profile: ResponseProfile): string {
  const instructions: string[] = ['Response Framing Guidelines:'];

  // Depth instruction
  switch (profile.depth_level) {
    case 'summary':
      instructions.push('- Provide a concise summary, avoiding unnecessary details');
      break;
    case 'moderate':
      instructions.push('- Include relevant details while staying focused');
      break;
    case 'detailed':
      instructions.push('- Provide thorough explanations with examples where helpful');
      break;
    case 'comprehensive':
      instructions.push('- Cover all aspects comprehensively with full context');
      break;
  }

  // Tone instruction
  switch (profile.tone) {
    case 'supportive':
      instructions.push('- Use warm, empathetic, and supportive language');
      break;
    case 'calming':
      instructions.push('- Use calm, measured, and reassuring language');
      break;
    case 'energetic':
      instructions.push('- Use positive, encouraging, and upbeat language');
      break;
    case 'factual':
      instructions.push('- Use clear, professional, and objective language');
      break;
    case 'neutral':
      instructions.push('- Use balanced, neutral language');
      break;
  }

  // Pacing instruction
  switch (profile.pacing) {
    case 'short':
      instructions.push('- Keep sentences short and direct');
      break;
    case 'step-by-step':
      instructions.push('- Break down information into clear, numbered steps');
      break;
    case 'conversational':
      instructions.push('- Use a natural, conversational flow');
      break;
    case 'normal':
      // No special instruction needed
      break;
  }

  // Directness instruction
  switch (profile.directness) {
    case 'suggestive':
      instructions.push('- Frame recommendations as suggestions, not directives');
      break;
    case 'explicit':
      instructions.push('- Be direct with recommendations and next steps');
      break;
    case 'balanced':
      // No special instruction needed
      break;
  }

  // Confidence instruction
  switch (profile.confidence_expression) {
    case 'uncertain':
      instructions.push('- Acknowledge uncertainty explicitly');
      break;
    case 'probabilistic':
      instructions.push('- Use probabilistic language (e.g., "likely", "suggests", "may")');
      break;
    case 'confident':
    case 'certain':
      // No special hedging needed
      break;
  }

  return instructions.join('\n');
}

// =============================================================================
// VTID-01123: OASIS Event Emission
// =============================================================================

/**
 * Emit framing decision event to OASIS for traceability.
 */
export async function emitFramingEvent(
  type: 'response.framing.computed' | 'response.framing.applied' | 'response.framing.override',
  status: 'info' | 'success' | 'warning',
  message: string,
  decisionRecord: FramingDecisionRecord,
  additionalPayload?: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: 'VTID-01123',
      type: type as CicdEventType,
      source: 'response-framing-engine',
      status,
      message,
      payload: {
        decision_id: decisionRecord.decision_id,
        response_profile: decisionRecord.response_profile,
        overrides_count: decisionRecord.applied_overrides.length,
        rationale_codes: decisionRecord.rationale_codes,
        input_summary: decisionRecord.input_summary,
        ...additionalPayload,
      },
    });
  } catch (err) {
    console.warn('[VTID-01123] Failed to emit framing event:', err);
  }
}

/**
 * Log and emit a complete framing decision.
 * Convenience function combining compute + emit.
 */
export async function computeAndLogResponseProfile(
  input: FramingInputBundle,
  context?: { conversation_id?: string; user_id?: string; tenant_id?: string }
): Promise<FramingDecisionRecord> {
  const decision = computeResponseProfile(input);

  // Log locally
  console.log(
    `[VTID-01123] Response framing computed: depth=${decision.response_profile.depth_level}, ` +
    `tone=${decision.response_profile.tone}, pacing=${decision.response_profile.pacing}, ` +
    `overrides=${decision.applied_overrides.length}`
  );

  // Emit to OASIS (fire-and-forget)
  emitFramingEvent(
    'response.framing.computed',
    'success',
    `Response profile computed: ${decision.response_profile.tone} tone, ${decision.response_profile.depth_level} depth`,
    decision,
    context
  ).catch(() => {
    // Silently ignore emission failures
  });

  return decision;
}

// =============================================================================
// VTID-01123: Export Default
// =============================================================================

export default {
  computeResponseProfile,
  computeSimpleResponseProfile,
  computeAndLogResponseProfile,
  describeProfile,
  generateFramingInstruction,
  emitFramingEvent,
  DEFAULT_RESPONSE_PROFILE,
  COGNITIVE_LOAD_THRESHOLDS,
  ENGAGEMENT_THRESHOLDS,
  CONFIDENCE_THRESHOLDS,
};
