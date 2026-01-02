/**
 * VTID-01132: D38 Learning Style, Adaptation & Knowledge Absorption Engine Types
 *
 * Type definitions for the Deep Context Intelligence engine that understands
 * how the user best absorbs information and guidance, adapting explanations,
 * recommendations, and pacing accordingly.
 *
 * D38 ensures intelligence is not only *correct* but **learnable, digestible,
 * and personally aligned**.
 *
 * It answers: "How should I explain or guide this person so it actually lands?"
 *
 * Position in Intelligence Stack:
 *   D27 Preferences + D28 Signals + D33 Availability → D38 Learning Style → D31 Response Framing
 */

import { z } from 'zod';

// =============================================================================
// VTID-01132: Learning Style Dimensions (Canonical)
// =============================================================================

/**
 * Brevity preference - concise vs detailed responses
 * Inferred from message lengths, follow-up patterns, explicit feedback
 */
export type BrevityPreference = 'concise' | 'moderate' | 'detailed' | 'comprehensive';

/**
 * Structure preference - how information should be organized
 * Inferred from question patterns, response engagement
 */
export type StructurePreference = 'bullet_points' | 'narrative' | 'step_by_step' | 'mixed';

/**
 * Example orientation - preference for examples vs principles
 * Inferred from clarification requests, successful uptake patterns
 */
export type ExampleOrientation = 'examples_first' | 'principles_first' | 'balanced' | 'minimal_examples';

/**
 * Exploration tolerance - willingness to explore tangential topics
 * Inferred from follow-up patterns, topic breadth in conversations
 */
export type ExplorationTolerance = 'focused' | 'moderate_exploration' | 'highly_exploratory';

/**
 * Repetition tolerance - how much reinforcement is helpful
 * Inferred from repeat questions, correction patterns
 */
export type RepetitionTolerance = 'minimal' | 'moderate' | 'high';

/**
 * Knowledge absorption rate - how quickly user absorbs and applies information
 * Inferred from follow-up questions, correction frequency, action latency
 */
export type AbsorptionRate = 'slow' | 'moderate' | 'fast' | 'unknown';

/**
 * Terminology comfort level - how comfortable user is with technical terms
 * Inferred from vocabulary usage, clarification requests for jargon
 */
export type TerminologyComfort = 'avoid_jargon' | 'basic_terms' | 'intermediate' | 'expert';

// =============================================================================
// VTID-01132: Learning Style Profile (Canonical Output)
// =============================================================================

/**
 * Learning Style Profile - The canonical representation of how a user learns
 * Used by D31 Response Framing to adapt delivery
 */
export interface LearningStyleProfile {
  /** Preference for response length */
  brevity_preference: BrevityPreference;
  /** Preference for information structure */
  structure_preference: StructurePreference;
  /** Preference for examples vs principles */
  example_orientation: ExampleOrientation;
  /** Tolerance for exploratory tangents */
  exploration_tolerance: ExplorationTolerance;
  /** Tolerance for repetition/reinforcement */
  repetition_tolerance: RepetitionTolerance;
  /** How quickly user absorbs new information */
  absorption_rate: AbsorptionRate;
  /** Comfort level with technical terminology */
  terminology_comfort: TerminologyComfort;
}

/**
 * Confidence scores for each learning style dimension
 * All values 0-100, capped at 85 for inferred values per D27 pattern
 */
export interface LearningStyleConfidence {
  brevity_preference: number;
  structure_preference: number;
  example_orientation: number;
  exploration_tolerance: number;
  repetition_tolerance: number;
  absorption_rate: number;
  terminology_comfort: number;
}

// =============================================================================
// VTID-01132: Learning Signals (Inputs)
// =============================================================================

/**
 * Conversation signals used to infer learning style
 */
export interface ConversationSignals {
  /** Average message length from user (characters) */
  avg_message_length?: number;
  /** Variance in message length */
  message_length_variance?: number;
  /** Count of clarification requests */
  clarification_request_count?: number;
  /** Count of follow-up questions */
  follow_up_question_count?: number;
  /** Total interaction count for this session */
  interaction_count?: number;
  /** Count of corrections user made */
  correction_count?: number;
  /** Count of confirmations ("got it", "makes sense") */
  confirmation_count?: number;
  /** Average response time (seconds) */
  avg_response_time_seconds?: number;
  /** Whether user uses technical vocabulary */
  uses_technical_vocabulary?: boolean;
  /** Count of "too long" / "shorter" requests */
  brevity_feedback_count?: number;
  /** Count of "more detail" requests */
  detail_request_count?: number;
  /** Count of "example please" requests */
  example_request_count?: number;
  /** Topic breadth score (0-100) */
  topic_breadth_score?: number;
}

/**
 * Historical patterns from past conversations
 */
export interface HistoricalPatterns {
  /** Successful guidance uptake rate (0-1) */
  guidance_uptake_rate?: number;
  /** Average turns to comprehension */
  avg_turns_to_comprehension?: number;
  /** Preferred content domains */
  preferred_domains?: string[];
  /** Historical absorption rate if known */
  historical_absorption_rate?: AbsorptionRate;
  /** Count of past interactions */
  total_interaction_count?: number;
  /** Count of sessions with user */
  session_count?: number;
}

/**
 * Explicit preferences from D27
 */
export interface ExplicitLearningPreferences {
  /** User-set brevity preference */
  preferred_length?: 'brief' | 'normal' | 'detailed';
  /** User-set structure preference */
  preferred_structure?: 'bullets' | 'paragraphs' | 'steps';
  /** User explicitly requested examples */
  prefers_examples?: boolean;
  /** User's self-reported expertise level */
  expertise_level?: 'beginner' | 'intermediate' | 'expert';
}

/**
 * Availability and readiness signals from D33
 */
export interface AvailabilitySignals {
  /** User has indicated time pressure */
  time_constrained?: boolean;
  /** Estimated available time (minutes) */
  available_time_minutes?: number;
  /** Current cognitive load (0-100) from D28 */
  cognitive_load?: number;
  /** Current engagement level (0-100) from D28 */
  engagement_level?: number;
  /** Current emotional state from D28 */
  emotional_state?: string;
}

/**
 * Complete input bundle for learning style computation
 */
export interface LearningStyleInputBundle {
  /** Current conversation signals */
  conversation: ConversationSignals;
  /** Historical patterns if available */
  historical?: HistoricalPatterns;
  /** Explicit preferences from D27 */
  explicit_preferences?: ExplicitLearningPreferences;
  /** Availability signals from D33 */
  availability?: AvailabilitySignals;
  /** Session ID for tracking */
  session_id?: string;
  /** User ID */
  user_id?: string;
  /** Tenant ID */
  tenant_id?: string;
}

// =============================================================================
// VTID-01132: Response Plan (Output for D31)
// =============================================================================

/**
 * Learning tags that can be applied to responses
 * Used by D31 and output generation
 */
export type LearningTag =
  | 'explain_briefly'
  | 'step_by_step'
  | 'use_examples'
  | 'summarize_often'
  | 'avoid_jargon'
  | 'use_analogies'
  | 'check_understanding'
  | 'offer_deep_dive'
  | 'reinforce_key_points'
  | 'single_concept';

/**
 * Framing style for explanations
 */
export type FramingStyle = 'direct' | 'scaffolded' | 'socratic' | 'narrative' | 'comparative';

/**
 * Pacing recommendation
 */
export type PacingRecommendation = 'accelerated' | 'normal' | 'deliberate' | 'checkpoint_heavy';

/**
 * Learning-Optimized Response Plan
 * Output of D38 consumed by D31 Response Framing
 */
export interface LearningResponsePlan {
  /** Recommended explanation depth */
  explanation_depth: 'minimal' | 'concise' | 'moderate' | 'thorough' | 'comprehensive';
  /** Recommended framing style */
  framing_style: FramingStyle;
  /** Recommended pacing */
  pacing: PacingRecommendation;
  /** Whether reinforcement/recap is needed */
  reinforcement_needed: boolean;
  /** Learning tags to apply */
  learning_tags: LearningTag[];
  /** Whether to offer optional deep dive */
  offer_deep_dive: boolean;
  /** Whether to check understanding */
  check_understanding: boolean;
  /** Suggested max response length (characters) */
  suggested_max_length?: number;
}

// =============================================================================
// VTID-01132: Learning Style Bundle (Complete Output)
// =============================================================================

/**
 * Evidence record for explainability
 */
export interface LearningStyleEvidence {
  /** Signal that contributed to inference */
  signal: string;
  /** Value of the signal */
  value: unknown;
  /** Weight given to this signal */
  weight: number;
  /** Which dimension it affected */
  affected_dimension: keyof LearningStyleProfile;
}

/**
 * Complete Learning Style Bundle
 * Main output of D38 engine
 */
export interface LearningStyleBundle {
  /** Unique bundle ID */
  bundle_id: string;
  /** Generated timestamp */
  generated_at: string;
  /** User's learning style profile */
  profile: LearningStyleProfile;
  /** Confidence scores for each dimension */
  confidence: LearningStyleConfidence;
  /** Overall confidence (average) */
  overall_confidence: number;
  /** Learning-optimized response plan */
  response_plan: LearningResponsePlan;
  /** Evidence trail for explainability */
  evidence: LearningStyleEvidence[];
  /** Applied rules for transparency */
  rules_applied: string[];
  /** Disclaimer per D28 pattern */
  disclaimer: string;
}

// =============================================================================
// VTID-01132: API Response Types
// =============================================================================

/**
 * Compute learning style response
 */
export interface ComputeLearningStyleResponse {
  ok: boolean;
  bundle?: LearningStyleBundle;
  error?: string;
  message?: string;
}

/**
 * Get current learning style response
 */
export interface GetLearningStyleResponse {
  ok: boolean;
  profile?: LearningStyleProfile;
  confidence?: LearningStyleConfidence;
  response_plan?: LearningResponsePlan;
  last_updated?: string;
  error?: string;
  message?: string;
}

/**
 * Override learning style response
 */
export interface OverrideLearningStyleResponse {
  ok: boolean;
  dimension?: keyof LearningStyleProfile;
  old_value?: string;
  new_value?: string;
  message?: string;
  error?: string;
}

// =============================================================================
// VTID-01132: Zod Schemas for Validation
// =============================================================================

export const BrevityPreferenceSchema = z.enum(['concise', 'moderate', 'detailed', 'comprehensive']);
export const StructurePreferenceSchema = z.enum(['bullet_points', 'narrative', 'step_by_step', 'mixed']);
export const ExampleOrientationSchema = z.enum(['examples_first', 'principles_first', 'balanced', 'minimal_examples']);
export const ExplorationToleranceSchema = z.enum(['focused', 'moderate_exploration', 'highly_exploratory']);
export const RepetitionToleranceSchema = z.enum(['minimal', 'moderate', 'high']);
export const AbsorptionRateSchema = z.enum(['slow', 'moderate', 'fast', 'unknown']);
export const TerminologyComfortSchema = z.enum(['avoid_jargon', 'basic_terms', 'intermediate', 'expert']);

export const LearningStyleProfileSchema = z.object({
  brevity_preference: BrevityPreferenceSchema,
  structure_preference: StructurePreferenceSchema,
  example_orientation: ExampleOrientationSchema,
  exploration_tolerance: ExplorationToleranceSchema,
  repetition_tolerance: RepetitionToleranceSchema,
  absorption_rate: AbsorptionRateSchema,
  terminology_comfort: TerminologyComfortSchema,
});

export const LearningStyleConfidenceSchema = z.object({
  brevity_preference: z.number().min(0).max(100),
  structure_preference: z.number().min(0).max(100),
  example_orientation: z.number().min(0).max(100),
  exploration_tolerance: z.number().min(0).max(100),
  repetition_tolerance: z.number().min(0).max(100),
  absorption_rate: z.number().min(0).max(100),
  terminology_comfort: z.number().min(0).max(100),
});

export const ConversationSignalsSchema = z.object({
  avg_message_length: z.number().optional(),
  message_length_variance: z.number().optional(),
  clarification_request_count: z.number().int().min(0).optional(),
  follow_up_question_count: z.number().int().min(0).optional(),
  interaction_count: z.number().int().min(0).optional(),
  correction_count: z.number().int().min(0).optional(),
  confirmation_count: z.number().int().min(0).optional(),
  avg_response_time_seconds: z.number().optional(),
  uses_technical_vocabulary: z.boolean().optional(),
  brevity_feedback_count: z.number().int().min(0).optional(),
  detail_request_count: z.number().int().min(0).optional(),
  example_request_count: z.number().int().min(0).optional(),
  topic_breadth_score: z.number().min(0).max(100).optional(),
});

export const HistoricalPatternsSchema = z.object({
  guidance_uptake_rate: z.number().min(0).max(1).optional(),
  avg_turns_to_comprehension: z.number().optional(),
  preferred_domains: z.array(z.string()).optional(),
  historical_absorption_rate: AbsorptionRateSchema.optional(),
  total_interaction_count: z.number().int().min(0).optional(),
  session_count: z.number().int().min(0).optional(),
});

export const ExplicitLearningPreferencesSchema = z.object({
  preferred_length: z.enum(['brief', 'normal', 'detailed']).optional(),
  preferred_structure: z.enum(['bullets', 'paragraphs', 'steps']).optional(),
  prefers_examples: z.boolean().optional(),
  expertise_level: z.enum(['beginner', 'intermediate', 'expert']).optional(),
});

export const AvailabilitySignalsSchema = z.object({
  time_constrained: z.boolean().optional(),
  available_time_minutes: z.number().optional(),
  cognitive_load: z.number().min(0).max(100).optional(),
  engagement_level: z.number().min(0).max(100).optional(),
  emotional_state: z.string().optional(),
});

export const LearningStyleInputBundleSchema = z.object({
  conversation: ConversationSignalsSchema,
  historical: HistoricalPatternsSchema.optional(),
  explicit_preferences: ExplicitLearningPreferencesSchema.optional(),
  availability: AvailabilitySignalsSchema.optional(),
  session_id: z.string().optional(),
  user_id: z.string().optional(),
  tenant_id: z.string().optional(),
});

export const LearningTagSchema = z.enum([
  'explain_briefly',
  'step_by_step',
  'use_examples',
  'summarize_often',
  'avoid_jargon',
  'use_analogies',
  'check_understanding',
  'offer_deep_dive',
  'reinforce_key_points',
  'single_concept',
]);

export const FramingStyleSchema = z.enum(['direct', 'scaffolded', 'socratic', 'narrative', 'comparative']);
export const PacingRecommendationSchema = z.enum(['accelerated', 'normal', 'deliberate', 'checkpoint_heavy']);

export const LearningResponsePlanSchema = z.object({
  explanation_depth: z.enum(['minimal', 'concise', 'moderate', 'thorough', 'comprehensive']),
  framing_style: FramingStyleSchema,
  pacing: PacingRecommendationSchema,
  reinforcement_needed: z.boolean(),
  learning_tags: z.array(LearningTagSchema),
  offer_deep_dive: z.boolean(),
  check_understanding: z.boolean(),
  suggested_max_length: z.number().optional(),
});

// =============================================================================
// VTID-01132: Default Values
// =============================================================================

/**
 * Default learning style profile when no signals available
 */
export const DEFAULT_LEARNING_STYLE_PROFILE: LearningStyleProfile = {
  brevity_preference: 'moderate',
  structure_preference: 'mixed',
  example_orientation: 'balanced',
  exploration_tolerance: 'moderate_exploration',
  repetition_tolerance: 'moderate',
  absorption_rate: 'unknown',
  terminology_comfort: 'basic_terms',
};

/**
 * Default confidence scores (low when no data)
 */
export const DEFAULT_LEARNING_STYLE_CONFIDENCE: LearningStyleConfidence = {
  brevity_preference: 30,
  structure_preference: 30,
  example_orientation: 30,
  exploration_tolerance: 30,
  repetition_tolerance: 30,
  absorption_rate: 0,
  terminology_comfort: 30,
};

/**
 * Default response plan
 */
export const DEFAULT_LEARNING_RESPONSE_PLAN: LearningResponsePlan = {
  explanation_depth: 'moderate',
  framing_style: 'direct',
  pacing: 'normal',
  reinforcement_needed: false,
  learning_tags: [],
  offer_deep_dive: true,
  check_understanding: false,
};

// =============================================================================
// VTID-01132: Inference Thresholds
// =============================================================================

/**
 * Thresholds for brevity inference
 */
export const BREVITY_THRESHOLDS = {
  /** Messages shorter than this suggest concise preference */
  CONCISE_MAX_LENGTH: 80,
  /** Messages longer than this suggest detailed preference */
  DETAILED_MIN_LENGTH: 250,
  /** Messages longer than this suggest comprehensive preference */
  COMPREHENSIVE_MIN_LENGTH: 500,
} as const;

/**
 * Thresholds for absorption rate inference
 */
export const ABSORPTION_THRESHOLDS = {
  /** Fewer follow-ups than this suggests fast absorption */
  FAST_MAX_FOLLOWUPS: 1,
  /** More follow-ups than this suggests slow absorption */
  SLOW_MIN_FOLLOWUPS: 4,
  /** Quick response time threshold (seconds) */
  FAST_RESPONSE_TIME: 10,
  /** Slow response time threshold (seconds) */
  SLOW_RESPONSE_TIME: 60,
} as const;

/**
 * Thresholds for terminology comfort inference
 */
export const TERMINOLOGY_THRESHOLDS = {
  /** Minimum interactions to infer technical vocabulary comfort */
  MIN_INTERACTIONS_FOR_INFERENCE: 5,
  /** Jargon clarification requests above this suggest discomfort */
  JARGON_CLARIFICATION_THRESHOLD: 2,
} as const;

/**
 * Confidence cap for inferred values (matches D27)
 */
export const INFERENCE_CONFIDENCE_CAP = 85;

/**
 * Minimum confidence to apply a learning tag
 */
export const MIN_TAG_CONFIDENCE = 40;

// =============================================================================
// VTID-01132: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for learning style engine
 */
export const LEARNING_STYLE_EVENT_TYPES = [
  'd38.style.computed',
  'd38.style.updated',
  'd38.style.overridden',
  'd38.plan.generated',
  'd38.inference.failed',
] as const;

export type LearningStyleEventType = typeof LEARNING_STYLE_EVENT_TYPES[number];

/**
 * OASIS event payload for learning style
 */
export interface LearningStyleEventPayload {
  vtid: string;
  session_id?: string;
  user_id?: string;
  tenant_id?: string;
  bundle_id?: string;
  absorption_rate?: AbsorptionRate;
  overall_confidence?: number;
  rules_applied_count?: number;
  duration_ms?: number;
  error?: string;
}
