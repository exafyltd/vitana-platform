/**
 * VTID-01123: Response Framing & Delivery Control Engine Types
 *
 * Deterministic Response Framing Engine that controls how intelligence is delivered,
 * independent of what is decided. Ensures right depth, right tone, right moment.
 *
 * Position in Intelligence Stack:
 *   Decision + Safety → D31 Response Framing → Output Generation
 *
 * This is the delivery discipline layer completing Core Intelligence Foundations.
 */

import { z } from 'zod';

// =============================================================================
// VTID-01123: Framing Dimensions (Canonical)
// =============================================================================

/**
 * Depth level for response content
 * Controls how much detail is included
 */
export type DepthLevel = 'summary' | 'moderate' | 'detailed' | 'comprehensive';

/**
 * Tone for response delivery
 * Matches emotional context of user
 */
export type ResponseTone = 'neutral' | 'supportive' | 'energetic' | 'factual' | 'calming';

/**
 * Pacing for response structure
 * Controls how information is presented
 */
export type ResponsePacing = 'short' | 'normal' | 'step-by-step' | 'conversational';

/**
 * Directness level for recommendations
 * Controls how explicitly suggestions are made
 */
export type DirectnessLevel = 'suggestive' | 'balanced' | 'explicit';

/**
 * Confidence expression style
 * Controls how certainty is communicated
 */
export type ConfidenceExpression = 'certain' | 'confident' | 'probabilistic' | 'uncertain';

// =============================================================================
// VTID-01123: Response Profile (Output)
// =============================================================================

/**
 * Response Profile - The canonical output of the framing engine
 * Applied before text/voice generation
 */
export interface ResponseProfile {
  /** How much detail to include */
  depth_level: DepthLevel;
  /** Emotional tone of delivery */
  tone: ResponseTone;
  /** Information structure */
  pacing: ResponsePacing;
  /** How explicitly to make suggestions */
  directness: DirectnessLevel;
  /** How to express certainty */
  confidence_expression: ConfidenceExpression;
}

// =============================================================================
// VTID-01123: Framing Inputs
// =============================================================================

/**
 * Intent bundle from D21 (Intent Classification)
 */
export interface IntentBundle {
  /** Primary intent category */
  intent_type: string;
  /** Confidence score 0-100 */
  intent_confidence: number;
  /** Sub-intent if applicable */
  sub_intent?: string;
  /** Whether user is seeking information vs action */
  seeking_action: boolean;
  /** Urgency level detected */
  urgency?: 'low' | 'normal' | 'high' | 'critical';
}

/**
 * Routing bundle from D22 (Routing Layer)
 */
export interface RoutingBundle {
  /** Target domain for the response */
  domain: 'health' | 'community' | 'offers' | 'general' | 'safety';
  /** Specific capability being invoked */
  capability?: string;
  /** Whether response requires multi-step */
  multi_step: boolean;
  /** Context richness available */
  context_available: 'none' | 'minimal' | 'moderate' | 'rich';
}

/**
 * Emotional and cognitive signals from D28
 */
export interface EmotionalCognitiveSignals {
  /** Detected emotional state */
  emotional_state: 'neutral' | 'positive' | 'anxious' | 'frustrated' | 'confused' | 'distressed';
  /** Cognitive load indicator 0-100 */
  cognitive_load: number;
  /** Engagement level 0-100 */
  engagement_level: number;
  /** Recent stress signals */
  stress_elevated: boolean;
  /** User appears fatigued */
  fatigue_detected: boolean;
}

/**
 * User preferences and constraints from D27
 */
export interface UserPreferencesConstraints {
  /** User's preferred response length */
  preferred_length?: 'brief' | 'normal' | 'detailed';
  /** User's preferred tone */
  preferred_tone?: ResponseTone;
  /** User has indicated time pressure */
  time_constrained: boolean;
  /** Accessibility requirements */
  accessibility_needs?: string[];
  /** Language/communication preferences */
  communication_style?: 'formal' | 'casual' | 'professional';
}

/**
 * Safety outcome from D30 (Safety Layer)
 */
export interface SafetyOutcome {
  /** Safety evaluation passed */
  safe: boolean;
  /** Safety concern level if any */
  concern_level?: 'none' | 'low' | 'moderate' | 'high' | 'critical';
  /** Required safety framing */
  requires_safety_framing: boolean;
  /** Specific safety guidance to include */
  safety_guidance?: string;
  /** Whether to recommend professional help */
  recommend_professional: boolean;
}

/**
 * Complete framing input bundle
 */
export interface FramingInputBundle {
  /** Intent classification from D21 */
  intent: IntentBundle;
  /** Routing info from D22 */
  routing: RoutingBundle;
  /** Emotional/cognitive signals from D28 */
  signals: EmotionalCognitiveSignals;
  /** User preferences from D27 */
  preferences: UserPreferencesConstraints;
  /** Safety outcome from D30 */
  safety: SafetyOutcome;
}

// =============================================================================
// VTID-01123: Framing Decision & Logging
// =============================================================================

/**
 * Rationale code for framing decisions
 * Used for explainability and governance review
 */
export type FramingRationaleCode =
  // Depth decisions
  | 'depth_reduced_cognitive_load'
  | 'depth_reduced_time_constraint'
  | 'depth_increased_engagement'
  | 'depth_increased_explicit_request'
  | 'depth_default_moderate'
  // Tone decisions
  | 'tone_supportive_distress'
  | 'tone_supportive_anxiety'
  | 'tone_calming_stress'
  | 'tone_energetic_positive'
  | 'tone_factual_professional'
  | 'tone_neutral_default'
  | 'tone_user_preference'
  // Pacing decisions
  | 'pacing_short_cognitive_load'
  | 'pacing_short_time_constraint'
  | 'pacing_step_by_step_confused'
  | 'pacing_step_by_step_multi_step'
  | 'pacing_normal_default'
  // Directness decisions
  | 'directness_explicit_action_seeking'
  | 'directness_suggestive_sensitive'
  | 'directness_balanced_default'
  // Confidence decisions
  | 'confidence_probabilistic_low_score'
  | 'confidence_uncertain_minimal_context'
  | 'confidence_confident_high_score'
  | 'confidence_certain_default'
  // Override decisions
  | 'override_user_preference'
  | 'override_safety_constraint';

/**
 * Applied override record
 */
export interface FramingOverride {
  /** Which dimension was overridden */
  dimension: keyof ResponseProfile;
  /** Original computed value */
  original_value: string;
  /** Final applied value */
  applied_value: string;
  /** Why the override was applied */
  reason: FramingRationaleCode;
}

/**
 * Complete framing decision record for logging/traceability
 */
export interface FramingDecisionRecord {
  /** Unique ID for this framing decision */
  decision_id: string;
  /** Timestamp of decision */
  timestamp: string;
  /** The computed response profile */
  response_profile: ResponseProfile;
  /** List of overrides applied */
  applied_overrides: FramingOverride[];
  /** Rationale codes explaining each dimension */
  rationale_codes: FramingRationaleCode[];
  /** Input summary for audit */
  input_summary: {
    intent_type: string;
    intent_confidence: number;
    domain: string;
    emotional_state: string;
    cognitive_load: number;
    engagement_level: number;
    safety_concern_level: string;
    user_preferences_applied: boolean;
  };
}

// =============================================================================
// VTID-01123: Zod Schemas for Validation
// =============================================================================

export const DepthLevelSchema = z.enum(['summary', 'moderate', 'detailed', 'comprehensive']);
export const ResponseToneSchema = z.enum(['neutral', 'supportive', 'energetic', 'factual', 'calming']);
export const ResponsePacingSchema = z.enum(['short', 'normal', 'step-by-step', 'conversational']);
export const DirectnessLevelSchema = z.enum(['suggestive', 'balanced', 'explicit']);
export const ConfidenceExpressionSchema = z.enum(['certain', 'confident', 'probabilistic', 'uncertain']);

export const ResponseProfileSchema = z.object({
  depth_level: DepthLevelSchema,
  tone: ResponseToneSchema,
  pacing: ResponsePacingSchema,
  directness: DirectnessLevelSchema,
  confidence_expression: ConfidenceExpressionSchema,
});

export const IntentBundleSchema = z.object({
  intent_type: z.string(),
  intent_confidence: z.number().min(0).max(100),
  sub_intent: z.string().optional(),
  seeking_action: z.boolean(),
  urgency: z.enum(['low', 'normal', 'high', 'critical']).optional(),
});

export const RoutingBundleSchema = z.object({
  domain: z.enum(['health', 'community', 'offers', 'general', 'safety']),
  capability: z.string().optional(),
  multi_step: z.boolean(),
  context_available: z.enum(['none', 'minimal', 'moderate', 'rich']),
});

export const EmotionalCognitiveSignalsSchema = z.object({
  emotional_state: z.enum(['neutral', 'positive', 'anxious', 'frustrated', 'confused', 'distressed']),
  cognitive_load: z.number().min(0).max(100),
  engagement_level: z.number().min(0).max(100),
  stress_elevated: z.boolean(),
  fatigue_detected: z.boolean(),
});

export const UserPreferencesConstraintsSchema = z.object({
  preferred_length: z.enum(['brief', 'normal', 'detailed']).optional(),
  preferred_tone: ResponseToneSchema.optional(),
  time_constrained: z.boolean(),
  accessibility_needs: z.array(z.string()).optional(),
  communication_style: z.enum(['formal', 'casual', 'professional']).optional(),
});

export const SafetyOutcomeSchema = z.object({
  safe: z.boolean(),
  concern_level: z.enum(['none', 'low', 'moderate', 'high', 'critical']).optional(),
  requires_safety_framing: z.boolean(),
  safety_guidance: z.string().optional(),
  recommend_professional: z.boolean(),
});

export const FramingInputBundleSchema = z.object({
  intent: IntentBundleSchema,
  routing: RoutingBundleSchema,
  signals: EmotionalCognitiveSignalsSchema,
  preferences: UserPreferencesConstraintsSchema,
  safety: SafetyOutcomeSchema,
});

// =============================================================================
// VTID-01123: Default Values
// =============================================================================

/**
 * Default response profile when no special conditions apply
 */
export const DEFAULT_RESPONSE_PROFILE: ResponseProfile = {
  depth_level: 'moderate',
  tone: 'neutral',
  pacing: 'normal',
  directness: 'balanced',
  confidence_expression: 'confident',
};

/**
 * Default framing input bundle for fallback scenarios
 */
export const DEFAULT_FRAMING_INPUT: FramingInputBundle = {
  intent: {
    intent_type: 'general_query',
    intent_confidence: 50,
    seeking_action: false,
  },
  routing: {
    domain: 'general',
    multi_step: false,
    context_available: 'minimal',
  },
  signals: {
    emotional_state: 'neutral',
    cognitive_load: 50,
    engagement_level: 50,
    stress_elevated: false,
    fatigue_detected: false,
  },
  preferences: {
    time_constrained: false,
  },
  safety: {
    safe: true,
    requires_safety_framing: false,
    recommend_professional: false,
  },
};

// =============================================================================
// VTID-01123: Framing Thresholds (Deterministic Constants)
// =============================================================================

/**
 * Cognitive load thresholds for depth/pacing decisions
 */
export const COGNITIVE_LOAD_THRESHOLDS = {
  /** Above this, reduce depth and use short pacing */
  HIGH: 70,
  /** Above this, consider moderate adjustments */
  MODERATE: 50,
  /** Below this, user can handle more detail */
  LOW: 30,
} as const;

/**
 * Engagement level thresholds
 */
export const ENGAGEMENT_THRESHOLDS = {
  /** Above this, user is highly engaged - can provide more depth */
  HIGH: 70,
  /** Above this, normal engagement */
  MODERATE: 40,
  /** Below this, user may be disengaged - keep responses focused */
  LOW: 25,
} as const;

/**
 * Confidence score thresholds for expression adjustment
 */
export const CONFIDENCE_THRESHOLDS = {
  /** Above this, express certainty */
  CERTAIN: 90,
  /** Above this, express confidence */
  CONFIDENT: 70,
  /** Above this, use probabilistic language */
  PROBABILISTIC: 40,
  /** Below this, express uncertainty */
  UNCERTAIN: 40,
} as const;
