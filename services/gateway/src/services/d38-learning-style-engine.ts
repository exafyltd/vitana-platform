/**
 * VTID-01132: D38 Learning Style, Adaptation & Knowledge Absorption Engine
 *
 * Deterministic engine that understands how the user best absorbs information
 * and guidance, adapting explanations, recommendations, and pacing accordingly.
 *
 * D38 ensures intelligence is not only *correct* but **learnable, digestible,
 * and personally aligned**.
 *
 * Core Principles (per spec):
 * - Same inputs → same learning style output (deterministic)
 * - Rule-based inference only, no ML randomness
 * - Explicit preferences override inferred
 * - Adapt continuously, not statically
 * - Learning inference must be reversible
 *
 * Hard Constraints (Behavioral Rules):
 * - ❌ Never patronize
 * - ❌ Never overwhelm
 * - ✅ Respect explicit preferences immediately
 * - ✅ Offer "more detail" / "short version" on uncertainty
 *
 * Position in Intelligence Stack:
 *   D27 Preferences + D28 Signals + D33 Availability → D38 Learning Style → D31 Response Framing
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { CicdEventType } from '../types/cicd';
import {
  LearningStyleProfile,
  LearningStyleConfidence,
  LearningStyleBundle,
  LearningStyleInputBundle,
  LearningResponsePlan,
  LearningStyleEvidence,
  LearningTag,
  BrevityPreference,
  StructurePreference,
  ExampleOrientation,
  ExplorationTolerance,
  RepetitionTolerance,
  AbsorptionRate,
  TerminologyComfort,
  FramingStyle,
  PacingRecommendation,
  ComputeLearningStyleResponse,
  DEFAULT_LEARNING_STYLE_PROFILE,
  DEFAULT_LEARNING_STYLE_CONFIDENCE,
  DEFAULT_LEARNING_RESPONSE_PLAN,
  BREVITY_THRESHOLDS,
  ABSORPTION_THRESHOLDS,
  TERMINOLOGY_THRESHOLDS,
  INFERENCE_CONFIDENCE_CAP,
  MIN_TAG_CONFIDENCE,
} from '../types/learning-style';

// =============================================================================
// VTID-01132: Constants
// =============================================================================

export const VTID = 'VTID-01132';
const LOG_PREFIX = '[D38-Engine]';

const DISCLAIMER = 'Learning style inference is based on observed patterns and may not fully represent user preferences. User corrections override all inferences.';

// =============================================================================
// VTID-01132: Inference Rules - Brevity Preference
// =============================================================================

interface InferenceResult<T> {
  value: T;
  confidence: number;
  evidence: LearningStyleEvidence[];
  rules: string[];
}

function inferBrevityPreference(input: LearningStyleInputBundle): InferenceResult<BrevityPreference> {
  const evidence: LearningStyleEvidence[] = [];
  const rules: string[] = [];
  let value: BrevityPreference = 'moderate';
  let confidence = 30;

  // Explicit preference always wins
  if (input.explicit_preferences?.preferred_length) {
    const explicit = input.explicit_preferences.preferred_length;
    value = explicit === 'brief' ? 'concise' : explicit === 'detailed' ? 'detailed' : 'moderate';
    confidence = 100;
    evidence.push({ signal: 'explicit_preferred_length', value: explicit, weight: 1.0, affected_dimension: 'brevity_preference' });
    rules.push('explicit_preference_override');
    return { value, confidence, evidence, rules };
  }

  // Time constraint forces concise
  if (input.availability?.time_constrained) {
    value = 'concise';
    confidence = Math.min(confidence + 30, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'time_constrained', value: true, weight: 0.8, affected_dimension: 'brevity_preference' });
    rules.push('time_constraint_brevity');
  }

  // High cognitive load forces concise
  if (input.availability?.cognitive_load && input.availability.cognitive_load > 70) {
    value = 'concise';
    confidence = Math.min(confidence + 25, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'cognitive_load', value: input.availability.cognitive_load, weight: 0.7, affected_dimension: 'brevity_preference' });
    rules.push('cognitive_load_brevity');
  }

  // Message length patterns
  if (input.conversation.avg_message_length !== undefined) {
    const avgLen = input.conversation.avg_message_length;
    if (avgLen < BREVITY_THRESHOLDS.CONCISE_MAX_LENGTH) {
      value = 'concise';
      confidence = Math.min(confidence + 20, INFERENCE_CONFIDENCE_CAP);
      rules.push('short_messages_infer_concise');
    } else if (avgLen > BREVITY_THRESHOLDS.COMPREHENSIVE_MIN_LENGTH) {
      value = 'comprehensive';
      confidence = Math.min(confidence + 20, INFERENCE_CONFIDENCE_CAP);
      rules.push('long_messages_infer_comprehensive');
    } else if (avgLen > BREVITY_THRESHOLDS.DETAILED_MIN_LENGTH) {
      value = 'detailed';
      confidence = Math.min(confidence + 15, INFERENCE_CONFIDENCE_CAP);
      rules.push('medium_long_messages_infer_detailed');
    }
    evidence.push({ signal: 'avg_message_length', value: avgLen, weight: 0.5, affected_dimension: 'brevity_preference' });
  }

  // Explicit brevity feedback
  if (input.conversation.brevity_feedback_count && input.conversation.brevity_feedback_count > 0) {
    value = 'concise';
    confidence = Math.min(confidence + 30, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'brevity_feedback_count', value: input.conversation.brevity_feedback_count, weight: 0.9, affected_dimension: 'brevity_preference' });
    rules.push('brevity_feedback_detected');
  }

  // Detail requests
  if (input.conversation.detail_request_count && input.conversation.detail_request_count > 1) {
    value = 'detailed';
    confidence = Math.min(confidence + 25, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'detail_request_count', value: input.conversation.detail_request_count, weight: 0.8, affected_dimension: 'brevity_preference' });
    rules.push('detail_requests_detected');
  }

  return { value, confidence: Math.min(confidence, INFERENCE_CONFIDENCE_CAP), evidence, rules };
}

// =============================================================================
// VTID-01132: Inference Rules - Structure Preference
// =============================================================================

function inferStructurePreference(input: LearningStyleInputBundle): InferenceResult<StructurePreference> {
  const evidence: LearningStyleEvidence[] = [];
  const rules: string[] = [];
  let value: StructurePreference = 'mixed';
  let confidence = 30;

  // Explicit preference
  if (input.explicit_preferences?.preferred_structure) {
    const explicit = input.explicit_preferences.preferred_structure;
    value = explicit === 'bullets' ? 'bullet_points' : explicit === 'steps' ? 'step_by_step' : 'narrative';
    confidence = 100;
    evidence.push({ signal: 'explicit_preferred_structure', value: explicit, weight: 1.0, affected_dimension: 'structure_preference' });
    rules.push('explicit_preference_override');
    return { value, confidence, evidence, rules };
  }

  // High cognitive load prefers step-by-step
  if (input.availability?.cognitive_load && input.availability.cognitive_load > 60) {
    value = 'step_by_step';
    confidence = Math.min(confidence + 20, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'cognitive_load', value: input.availability.cognitive_load, weight: 0.6, affected_dimension: 'structure_preference' });
    rules.push('cognitive_load_step_by_step');
  }

  // Many follow-up questions suggest step-by-step
  if (input.conversation.follow_up_question_count && input.conversation.follow_up_question_count > 3) {
    value = 'step_by_step';
    confidence = Math.min(confidence + 15, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'follow_up_question_count', value: input.conversation.follow_up_question_count, weight: 0.5, affected_dimension: 'structure_preference' });
    rules.push('many_followups_step_by_step');
  }

  // Short messages with high interaction count suggests bullet_points
  if (input.conversation.avg_message_length && input.conversation.avg_message_length < 100 &&
      input.conversation.interaction_count && input.conversation.interaction_count > 5) {
    value = 'bullet_points';
    confidence = Math.min(confidence + 15, INFERENCE_CONFIDENCE_CAP);
    rules.push('quick_exchanges_bullet_points');
  }

  return { value, confidence: Math.min(confidence, INFERENCE_CONFIDENCE_CAP), evidence, rules };
}

// =============================================================================
// VTID-01132: Inference Rules - Example Orientation
// =============================================================================

function inferExampleOrientation(input: LearningStyleInputBundle): InferenceResult<ExampleOrientation> {
  const evidence: LearningStyleEvidence[] = [];
  const rules: string[] = [];
  let value: ExampleOrientation = 'balanced';
  let confidence = 30;

  // Explicit preference
  if (input.explicit_preferences?.prefers_examples !== undefined) {
    value = input.explicit_preferences.prefers_examples ? 'examples_first' : 'principles_first';
    confidence = 100;
    evidence.push({ signal: 'explicit_prefers_examples', value: input.explicit_preferences.prefers_examples, weight: 1.0, affected_dimension: 'example_orientation' });
    rules.push('explicit_preference_override');
    return { value, confidence, evidence, rules };
  }

  // Example requests
  if (input.conversation.example_request_count && input.conversation.example_request_count > 0) {
    value = 'examples_first';
    confidence = Math.min(confidence + 25 + (input.conversation.example_request_count * 5), INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'example_request_count', value: input.conversation.example_request_count, weight: 0.8, affected_dimension: 'example_orientation' });
    rules.push('example_requests_detected');
  }

  // Beginners prefer examples
  if (input.explicit_preferences?.expertise_level === 'beginner') {
    value = 'examples_first';
    confidence = Math.min(confidence + 20, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'expertise_level', value: 'beginner', weight: 0.6, affected_dimension: 'example_orientation' });
    rules.push('beginner_prefers_examples');
  }

  // Experts may prefer principles
  if (input.explicit_preferences?.expertise_level === 'expert') {
    value = 'principles_first';
    confidence = Math.min(confidence + 15, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'expertise_level', value: 'expert', weight: 0.5, affected_dimension: 'example_orientation' });
    rules.push('expert_prefers_principles');
  }

  // High clarification count suggests examples help
  if (input.conversation.clarification_request_count && input.conversation.clarification_request_count > 2) {
    value = 'examples_first';
    confidence = Math.min(confidence + 15, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'clarification_request_count', value: input.conversation.clarification_request_count, weight: 0.5, affected_dimension: 'example_orientation' });
    rules.push('clarifications_suggest_examples');
  }

  return { value, confidence: Math.min(confidence, INFERENCE_CONFIDENCE_CAP), evidence, rules };
}

// =============================================================================
// VTID-01132: Inference Rules - Exploration Tolerance
// =============================================================================

function inferExplorationTolerance(input: LearningStyleInputBundle): InferenceResult<ExplorationTolerance> {
  const evidence: LearningStyleEvidence[] = [];
  const rules: string[] = [];
  let value: ExplorationTolerance = 'moderate_exploration';
  let confidence = 30;

  // Time constraint forces focused
  if (input.availability?.time_constrained) {
    value = 'focused';
    confidence = Math.min(confidence + 35, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'time_constrained', value: true, weight: 0.9, affected_dimension: 'exploration_tolerance' });
    rules.push('time_constraint_focused');
    return { value, confidence, evidence, rules };
  }

  // Topic breadth score
  if (input.conversation.topic_breadth_score !== undefined) {
    const breadth = input.conversation.topic_breadth_score;
    if (breadth > 70) {
      value = 'highly_exploratory';
      confidence = Math.min(confidence + 25, INFERENCE_CONFIDENCE_CAP);
      rules.push('high_topic_breadth');
    } else if (breadth < 30) {
      value = 'focused';
      confidence = Math.min(confidence + 20, INFERENCE_CONFIDENCE_CAP);
      rules.push('low_topic_breadth');
    }
    evidence.push({ signal: 'topic_breadth_score', value: breadth, weight: 0.6, affected_dimension: 'exploration_tolerance' });
  }

  // High engagement allows exploration
  if (input.availability?.engagement_level && input.availability.engagement_level > 70) {
    if (value !== 'focused') {
      value = 'highly_exploratory';
      confidence = Math.min(confidence + 15, INFERENCE_CONFIDENCE_CAP);
      evidence.push({ signal: 'engagement_level', value: input.availability.engagement_level, weight: 0.4, affected_dimension: 'exploration_tolerance' });
      rules.push('high_engagement_exploration');
    }
  }

  return { value, confidence: Math.min(confidence, INFERENCE_CONFIDENCE_CAP), evidence, rules };
}

// =============================================================================
// VTID-01132: Inference Rules - Repetition Tolerance
// =============================================================================

function inferRepetitionTolerance(input: LearningStyleInputBundle): InferenceResult<RepetitionTolerance> {
  const evidence: LearningStyleEvidence[] = [];
  const rules: string[] = [];
  let value: RepetitionTolerance = 'moderate';
  let confidence = 30;

  // High confirmation count suggests comfort with reinforcement
  if (input.conversation.confirmation_count && input.conversation.confirmation_count > 3) {
    value = 'high';
    confidence = Math.min(confidence + 20, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'confirmation_count', value: input.conversation.confirmation_count, weight: 0.5, affected_dimension: 'repetition_tolerance' });
    rules.push('confirmations_suggest_reinforcement');
  }

  // Fast absorbers need minimal repetition
  if (input.historical?.historical_absorption_rate === 'fast') {
    value = 'minimal';
    confidence = Math.min(confidence + 25, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'historical_absorption_rate', value: 'fast', weight: 0.7, affected_dimension: 'repetition_tolerance' });
    rules.push('fast_absorber_minimal_repetition');
  }

  // Slow absorbers benefit from repetition
  if (input.historical?.historical_absorption_rate === 'slow') {
    value = 'high';
    confidence = Math.min(confidence + 25, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'historical_absorption_rate', value: 'slow', weight: 0.7, affected_dimension: 'repetition_tolerance' });
    rules.push('slow_absorber_high_repetition');
  }

  // Many corrections suggest need for reinforcement
  if (input.conversation.correction_count && input.conversation.correction_count > 2) {
    value = 'high';
    confidence = Math.min(confidence + 15, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'correction_count', value: input.conversation.correction_count, weight: 0.4, affected_dimension: 'repetition_tolerance' });
    rules.push('corrections_suggest_reinforcement');
  }

  return { value, confidence: Math.min(confidence, INFERENCE_CONFIDENCE_CAP), evidence, rules };
}

// =============================================================================
// VTID-01132: Inference Rules - Absorption Rate
// =============================================================================

function inferAbsorptionRate(input: LearningStyleInputBundle): InferenceResult<AbsorptionRate> {
  const evidence: LearningStyleEvidence[] = [];
  const rules: string[] = [];
  let value: AbsorptionRate = 'unknown';
  let confidence = 0;

  // Historical rate is most reliable
  if (input.historical?.historical_absorption_rate && input.historical.historical_absorption_rate !== 'unknown') {
    value = input.historical.historical_absorption_rate;
    confidence = Math.min(60, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'historical_absorption_rate', value, weight: 0.8, affected_dimension: 'absorption_rate' });
    rules.push('historical_rate_applied');
  }

  // Guidance uptake rate
  if (input.historical?.guidance_uptake_rate !== undefined) {
    const uptake = input.historical.guidance_uptake_rate;
    if (uptake > 0.8) {
      value = 'fast';
      confidence = Math.min(confidence + 25, INFERENCE_CONFIDENCE_CAP);
      rules.push('high_uptake_fast');
    } else if (uptake < 0.4) {
      value = 'slow';
      confidence = Math.min(confidence + 20, INFERENCE_CONFIDENCE_CAP);
      rules.push('low_uptake_slow');
    } else {
      value = 'moderate';
      confidence = Math.min(confidence + 15, INFERENCE_CONFIDENCE_CAP);
    }
    evidence.push({ signal: 'guidance_uptake_rate', value: uptake, weight: 0.7, affected_dimension: 'absorption_rate' });
  }

  // Follow-up patterns
  const followups = input.conversation.follow_up_question_count ?? 0;
  const interactions = input.conversation.interaction_count ?? 1;
  if (interactions >= 3) {
    const followupRatio = followups / interactions;
    if (followupRatio < 0.2 && followups <= ABSORPTION_THRESHOLDS.FAST_MAX_FOLLOWUPS) {
      value = value === 'unknown' ? 'fast' : value;
      confidence = Math.min(confidence + 15, INFERENCE_CONFIDENCE_CAP);
      rules.push('low_followup_ratio_fast');
    } else if (followups >= ABSORPTION_THRESHOLDS.SLOW_MIN_FOLLOWUPS) {
      value = 'slow';
      confidence = Math.min(confidence + 20, INFERENCE_CONFIDENCE_CAP);
      rules.push('high_followups_slow');
    }
    evidence.push({ signal: 'followup_ratio', value: followupRatio, weight: 0.5, affected_dimension: 'absorption_rate' });
  }

  // Response time patterns
  if (input.conversation.avg_response_time_seconds !== undefined) {
    const responseTime = input.conversation.avg_response_time_seconds;
    if (responseTime < ABSORPTION_THRESHOLDS.FAST_RESPONSE_TIME) {
      value = value === 'unknown' ? 'fast' : value;
      confidence = Math.min(confidence + 10, INFERENCE_CONFIDENCE_CAP);
      rules.push('quick_responses_fast');
    } else if (responseTime > ABSORPTION_THRESHOLDS.SLOW_RESPONSE_TIME) {
      value = value === 'slow' || value === 'unknown' ? 'slow' : 'moderate';
      confidence = Math.min(confidence + 10, INFERENCE_CONFIDENCE_CAP);
      rules.push('slow_responses_deliberate');
    }
    evidence.push({ signal: 'avg_response_time_seconds', value: responseTime, weight: 0.3, affected_dimension: 'absorption_rate' });
  }

  // Default to moderate if we have some data but still unknown
  if (value === 'unknown' && confidence > 0) {
    value = 'moderate';
  }

  return { value, confidence: Math.min(confidence, INFERENCE_CONFIDENCE_CAP), evidence, rules };
}

// =============================================================================
// VTID-01132: Inference Rules - Terminology Comfort
// =============================================================================

function inferTerminologyComfort(input: LearningStyleInputBundle): InferenceResult<TerminologyComfort> {
  const evidence: LearningStyleEvidence[] = [];
  const rules: string[] = [];
  let value: TerminologyComfort = 'basic_terms';
  let confidence = 30;

  // Explicit expertise level
  if (input.explicit_preferences?.expertise_level) {
    const level = input.explicit_preferences.expertise_level;
    value = level === 'expert' ? 'expert' : level === 'intermediate' ? 'intermediate' : 'basic_terms';
    confidence = 90;
    evidence.push({ signal: 'expertise_level', value: level, weight: 1.0, affected_dimension: 'terminology_comfort' });
    rules.push('explicit_expertise_level');
    return { value, confidence, evidence, rules };
  }

  // Uses technical vocabulary
  if (input.conversation.uses_technical_vocabulary) {
    value = 'intermediate';
    confidence = Math.min(confidence + 25, INFERENCE_CONFIDENCE_CAP);
    evidence.push({ signal: 'uses_technical_vocabulary', value: true, weight: 0.7, affected_dimension: 'terminology_comfort' });
    rules.push('technical_vocabulary_detected');
  }

  // Clarification requests suggest jargon discomfort
  const interactions = input.conversation.interaction_count ?? 0;
  const clarifications = input.conversation.clarification_request_count ?? 0;
  if (interactions >= TERMINOLOGY_THRESHOLDS.MIN_INTERACTIONS_FOR_INFERENCE) {
    if (clarifications > TERMINOLOGY_THRESHOLDS.JARGON_CLARIFICATION_THRESHOLD) {
      value = 'avoid_jargon';
      confidence = Math.min(confidence + 20, INFERENCE_CONFIDENCE_CAP);
      evidence.push({ signal: 'clarification_request_count', value: clarifications, weight: 0.6, affected_dimension: 'terminology_comfort' });
      rules.push('clarifications_avoid_jargon');
    }
  }

  // Historical domain preferences suggest familiarity
  if (input.historical?.preferred_domains && input.historical.preferred_domains.length > 0) {
    if (input.historical.total_interaction_count && input.historical.total_interaction_count > 20) {
      value = value === 'avoid_jargon' ? 'basic_terms' : 'intermediate';
      confidence = Math.min(confidence + 10, INFERENCE_CONFIDENCE_CAP);
      rules.push('domain_familiarity_intermediate');
    }
  }

  return { value, confidence: Math.min(confidence, INFERENCE_CONFIDENCE_CAP), evidence, rules };
}

// =============================================================================
// VTID-01132: Response Plan Generation
// =============================================================================

function generateResponsePlan(
  profile: LearningStyleProfile,
  confidence: LearningStyleConfidence,
  input: LearningStyleInputBundle
): LearningResponsePlan {
  const tags: LearningTag[] = [];

  // Explanation depth based on brevity preference
  let explanation_depth: LearningResponsePlan['explanation_depth'] = 'moderate';
  switch (profile.brevity_preference) {
    case 'concise': explanation_depth = 'concise'; break;
    case 'moderate': explanation_depth = 'moderate'; break;
    case 'detailed': explanation_depth = 'thorough'; break;
    case 'comprehensive': explanation_depth = 'comprehensive'; break;
  }

  // Override for cognitive load
  if (input.availability?.cognitive_load && input.availability.cognitive_load > 70) {
    explanation_depth = 'concise';
  }

  // Framing style
  let framing_style: FramingStyle = 'direct';
  if (profile.structure_preference === 'step_by_step') {
    framing_style = 'scaffolded';
  } else if (profile.example_orientation === 'examples_first') {
    framing_style = 'comparative';
  } else if (profile.structure_preference === 'narrative') {
    framing_style = 'narrative';
  }

  // Pacing
  let pacing: PacingRecommendation = 'normal';
  if (profile.absorption_rate === 'fast' && profile.repetition_tolerance === 'minimal') {
    pacing = 'accelerated';
  } else if (profile.absorption_rate === 'slow' || profile.repetition_tolerance === 'high') {
    pacing = 'checkpoint_heavy';
  } else if (input.availability?.cognitive_load && input.availability.cognitive_load > 60) {
    pacing = 'deliberate';
  }

  // Reinforcement needed
  const reinforcement_needed = profile.repetition_tolerance === 'high' || profile.absorption_rate === 'slow';

  // Learning tags based on profile and confidence
  if (profile.brevity_preference === 'concise' && confidence.brevity_preference >= MIN_TAG_CONFIDENCE) {
    tags.push('explain_briefly');
  }
  if (profile.structure_preference === 'step_by_step' && confidence.structure_preference >= MIN_TAG_CONFIDENCE) {
    tags.push('step_by_step');
  }
  if (profile.example_orientation === 'examples_first' && confidence.example_orientation >= MIN_TAG_CONFIDENCE) {
    tags.push('use_examples');
    tags.push('use_analogies');
  }
  if (profile.terminology_comfort === 'avoid_jargon' && confidence.terminology_comfort >= MIN_TAG_CONFIDENCE) {
    tags.push('avoid_jargon');
  }
  if (reinforcement_needed) {
    tags.push('summarize_often');
    tags.push('reinforce_key_points');
  }
  if (profile.absorption_rate === 'slow') {
    tags.push('check_understanding');
    tags.push('single_concept');
  }

  // Offer deep dive for exploratory users
  const offer_deep_dive = profile.exploration_tolerance !== 'focused' && profile.brevity_preference !== 'concise';

  // Check understanding for slow absorbers or high cognitive load
  const check_understanding = profile.absorption_rate === 'slow' ||
    (input.availability?.cognitive_load && input.availability.cognitive_load > 60);

  // Suggested max length
  let suggested_max_length: number | undefined;
  switch (profile.brevity_preference) {
    case 'concise': suggested_max_length = 500; break;
    case 'moderate': suggested_max_length = 1200; break;
    case 'detailed': suggested_max_length = 2500; break;
    case 'comprehensive': suggested_max_length = undefined; break;
  }

  return {
    explanation_depth,
    framing_style,
    pacing,
    reinforcement_needed,
    learning_tags: tags,
    offer_deep_dive,
    check_understanding,
    suggested_max_length,
  };
}

// =============================================================================
// VTID-01132: Main Engine Function
// =============================================================================

/**
 * Compute learning style from input signals
 *
 * Deterministic: Same inputs always produce same outputs
 * Rule-based: No ML or randomness
 * Traceable: Full evidence trail for explainability
 *
 * @param input - Learning style input bundle
 * @returns Complete learning style bundle
 */
export function computeLearningStyle(input: LearningStyleInputBundle): LearningStyleBundle {
  const startTime = Date.now();
  const bundleId = `ls_${randomUUID()}`;

  // Run all inference rules
  const brevity = inferBrevityPreference(input);
  const structure = inferStructurePreference(input);
  const example = inferExampleOrientation(input);
  const exploration = inferExplorationTolerance(input);
  const repetition = inferRepetitionTolerance(input);
  const absorption = inferAbsorptionRate(input);
  const terminology = inferTerminologyComfort(input);

  // Build profile
  const profile: LearningStyleProfile = {
    brevity_preference: brevity.value,
    structure_preference: structure.value,
    example_orientation: example.value,
    exploration_tolerance: exploration.value,
    repetition_tolerance: repetition.value,
    absorption_rate: absorption.value,
    terminology_comfort: terminology.value,
  };

  // Build confidence scores
  const confidence: LearningStyleConfidence = {
    brevity_preference: brevity.confidence,
    structure_preference: structure.confidence,
    example_orientation: example.confidence,
    exploration_tolerance: exploration.confidence,
    repetition_tolerance: repetition.confidence,
    absorption_rate: absorption.confidence,
    terminology_comfort: terminology.confidence,
  };

  // Calculate overall confidence
  const confidenceValues = Object.values(confidence);
  const overall_confidence = Math.round(
    confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length
  );

  // Collect all evidence
  const evidence: LearningStyleEvidence[] = [
    ...brevity.evidence,
    ...structure.evidence,
    ...example.evidence,
    ...exploration.evidence,
    ...repetition.evidence,
    ...absorption.evidence,
    ...terminology.evidence,
  ];

  // Collect all rules
  const rules_applied = [
    ...brevity.rules,
    ...structure.rules,
    ...example.rules,
    ...exploration.rules,
    ...repetition.rules,
    ...absorption.rules,
    ...terminology.rules,
  ];

  // Generate response plan
  const response_plan = generateResponsePlan(profile, confidence, input);

  const bundle: LearningStyleBundle = {
    bundle_id: bundleId,
    generated_at: new Date().toISOString(),
    profile,
    confidence,
    overall_confidence,
    response_plan,
    evidence,
    rules_applied,
    disclaimer: DISCLAIMER,
  };

  const duration = Date.now() - startTime;
  console.log(`${LOG_PREFIX} Computed learning style in ${duration}ms, rules=${rules_applied.length}, confidence=${overall_confidence}`);

  return bundle;
}

/**
 * Compute learning style with OASIS event emission
 */
export async function computeLearningStyleWithEvents(
  input: LearningStyleInputBundle
): Promise<ComputeLearningStyleResponse> {
  const startTime = Date.now();

  try {
    const bundle = computeLearningStyle(input);
    const duration = Date.now() - startTime;

    // Emit success event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd38.style.computed' as CicdEventType,
      source: 'gateway-d38',
      status: 'success',
      message: `Learning style computed for session ${input.session_id || 'N/A'}`,
      payload: {
        vtid: VTID,
        session_id: input.session_id,
        user_id: input.user_id,
        tenant_id: input.tenant_id,
        bundle_id: bundle.bundle_id,
        absorption_rate: bundle.profile.absorption_rate,
        overall_confidence: bundle.overall_confidence,
        rules_applied_count: bundle.rules_applied.length,
        duration_ms: duration,
      },
    });

    return { ok: true, bundle };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing learning style:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd38.inference.failed' as CicdEventType,
      source: 'gateway-d38',
      status: 'error',
      message: `Learning style computation failed: ${errorMessage}`,
      payload: {
        vtid: VTID,
        session_id: input.session_id,
        error: errorMessage,
      },
    });

    return { ok: false, error: 'COMPUTATION_ERROR', message: errorMessage };
  }
}

// =============================================================================
// VTID-01132: Convenience Functions
// =============================================================================

/**
 * Get default learning style profile
 */
export function getDefaultLearningStyle(): LearningStyleBundle {
  return {
    bundle_id: `ls_default_${randomUUID()}`,
    generated_at: new Date().toISOString(),
    profile: { ...DEFAULT_LEARNING_STYLE_PROFILE },
    confidence: { ...DEFAULT_LEARNING_STYLE_CONFIDENCE },
    overall_confidence: 30,
    response_plan: { ...DEFAULT_LEARNING_RESPONSE_PLAN },
    evidence: [],
    rules_applied: ['default_profile_applied'],
    disclaimer: DISCLAIMER,
  };
}

/**
 * Format learning style for prompt injection
 */
export function formatLearningStyleForPrompt(bundle: LearningStyleBundle): string {
  const lines: string[] = ['Learning Style Adaptation Guidelines:'];

  // Only include high-confidence recommendations
  if (bundle.confidence.brevity_preference >= MIN_TAG_CONFIDENCE) {
    switch (bundle.profile.brevity_preference) {
      case 'concise':
        lines.push('- Keep responses brief and focused (under 500 chars when possible)');
        break;
      case 'detailed':
        lines.push('- Provide thorough explanations with relevant details');
        break;
      case 'comprehensive':
        lines.push('- Include comprehensive coverage with full context');
        break;
    }
  }

  if (bundle.confidence.structure_preference >= MIN_TAG_CONFIDENCE) {
    switch (bundle.profile.structure_preference) {
      case 'bullet_points':
        lines.push('- Use bullet points for key information');
        break;
      case 'step_by_step':
        lines.push('- Present information in clear, numbered steps');
        break;
      case 'narrative':
        lines.push('- Use a flowing narrative style');
        break;
    }
  }

  if (bundle.confidence.example_orientation >= MIN_TAG_CONFIDENCE) {
    if (bundle.profile.example_orientation === 'examples_first') {
      lines.push('- Lead with concrete examples before explaining principles');
    } else if (bundle.profile.example_orientation === 'principles_first') {
      lines.push('- Explain principles first, then provide supporting examples');
    }
  }

  if (bundle.confidence.terminology_comfort >= MIN_TAG_CONFIDENCE) {
    if (bundle.profile.terminology_comfort === 'avoid_jargon') {
      lines.push('- Avoid technical jargon; use plain language');
    } else if (bundle.profile.terminology_comfort === 'expert') {
      lines.push('- Technical terminology is acceptable');
    }
  }

  if (bundle.response_plan.reinforcement_needed) {
    lines.push('- Summarize key points at the end');
  }

  if (bundle.response_plan.check_understanding) {
    lines.push('- Check for understanding before moving to new topics');
  }

  if (bundle.response_plan.offer_deep_dive) {
    lines.push('- Offer to explore topics in more depth if interested');
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Describe learning style profile in human-readable format
 */
export function describeLearningStyle(profile: LearningStyleProfile): string {
  const parts: string[] = [];

  parts.push(`Prefers ${profile.brevity_preference} responses`);
  parts.push(`Learns best with ${profile.structure_preference.replace('_', ' ')} structure`);
  parts.push(`${profile.example_orientation.replace('_', ' ')} learning approach`);
  parts.push(`${profile.exploration_tolerance.replace('_', ' ')} exploration style`);
  parts.push(`${profile.absorption_rate} absorption rate`);
  parts.push(`Comfortable with ${profile.terminology_comfort.replace('_', ' ')} terminology`);

  return parts.join('. ') + '.';
}

// =============================================================================
// VTID-01132: Named Exports for Constants
// =============================================================================

export { INFERENCE_CONFIDENCE_CAP, MIN_TAG_CONFIDENCE };

// =============================================================================
// VTID-01132: Export Default
// =============================================================================

export default {
  VTID,
  computeLearningStyle,
  computeLearningStyleWithEvents,
  getDefaultLearningStyle,
  formatLearningStyleForPrompt,
  describeLearningStyle,
  DEFAULT_LEARNING_STYLE_PROFILE,
  DEFAULT_LEARNING_STYLE_CONFIDENCE,
  DEFAULT_LEARNING_RESPONSE_PLAN,
  INFERENCE_CONFIDENCE_CAP,
  MIN_TAG_CONFIDENCE,
};
