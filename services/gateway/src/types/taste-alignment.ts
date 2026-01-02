/**
 * VTID-01133: Taste, Aesthetic & Lifestyle Alignment Types (D39)
 *
 * Type definitions for the Taste, Aesthetic & Lifestyle Alignment Engine.
 * Aligns recommendations with user's taste, aesthetic preferences, and lifestyle identity.
 *
 * D39 ensures suggestions *feel like "me" to the user*, increasing resonance,
 * trust, and long-term engagement.
 *
 * Core Question: "Does this fit who I am and how I like to live?"
 *
 * Hard Constraints (from spec):
 *   - Respect identity signals immediately
 *   - NO aesthetic judgment
 *   - Never imply "better" lifestyles
 *   - Treat taste as personal, not hierarchical
 *   - Allow user to redefine taste at any time
 */

import { z } from 'zod';

// =============================================================================
// VTID-01133: Taste Profile Components
// =============================================================================

/**
 * Simplicity preference - how the user prefers complexity in recommendations
 */
export const SimplicityPreference = z.enum([
  'minimalist',    // Prefers fewer, simpler options
  'balanced',      // Moderate complexity
  'comprehensive'  // Values detailed, thorough options
]);
export type SimplicityPreference = z.infer<typeof SimplicityPreference>;

/**
 * Premium orientation - user's preference for premium vs value options
 */
export const PremiumOrientation = z.enum([
  'value_focused',     // Prefers affordable, value-oriented options
  'quality_balanced',  // Balances quality and value
  'premium_oriented'   // Prefers premium, high-end options
]);
export type PremiumOrientation = z.infer<typeof PremiumOrientation>;

/**
 * Aesthetic style - visual/experiential style preference
 */
export const AestheticStyle = z.enum([
  'modern',       // Contemporary, cutting-edge
  'classic',      // Traditional, timeless
  'eclectic',     // Mixed, unique combinations
  'natural',      // Organic, nature-inspired
  'functional',   // Practical, utility-focused
  'neutral'       // No strong preference
]);
export type AestheticStyle = z.infer<typeof AestheticStyle>;

/**
 * Tone affinity - preferred communication/presentation tone
 */
export const ToneAffinity = z.enum([
  'technical',     // Precise, detailed, data-driven
  'expressive',    // Warm, emotional, story-driven
  'casual',        // Relaxed, informal
  'professional',  // Formal, business-like
  'minimalist',    // Concise, no-frills
  'neutral'        // Adaptive, no preference
]);
export type ToneAffinity = z.infer<typeof ToneAffinity>;

/**
 * Complete taste profile as per spec section 2.1
 */
export const TasteProfileSchema = z.object({
  simplicity_preference: SimplicityPreference.default('balanced'),
  premium_orientation: PremiumOrientation.default('quality_balanced'),
  aesthetic_style: AestheticStyle.default('neutral'),
  tone_affinity: ToneAffinity.default('neutral'),
  confidence: z.number().min(0).max(100).default(0),
  last_updated_at: z.string().datetime().optional()
});
export type TasteProfile = z.infer<typeof TasteProfileSchema>;

// =============================================================================
// VTID-01133: Lifestyle Profile Components
// =============================================================================

/**
 * Routine style - structured vs flexible daily patterns
 */
export const RoutineStyle = z.enum([
  'structured',   // Prefers fixed schedules, predictable routines
  'flexible',     // Adapts easily, spontaneous
  'hybrid'        // Mix of structure and flexibility
]);
export type RoutineStyle = z.infer<typeof RoutineStyle>;

/**
 * Social orientation - solo vs group preference
 */
export const SocialOrientation = z.enum([
  'solo_focused',      // Prefers individual activities
  'small_groups',      // Prefers intimate settings
  'social_oriented',   // Enjoys larger social settings
  'adaptive'           // Varies by context
]);
export type SocialOrientation = z.infer<typeof SocialOrientation>;

/**
 * Convenience bias - convenience vs intentionality
 */
export const ConvenienceBias = z.enum([
  'convenience_first',    // Prioritizes ease and speed
  'balanced',             // Balances convenience with quality
  'intentional_living'    // Values craft, process, meaning
]);
export type ConvenienceBias = z.infer<typeof ConvenienceBias>;

/**
 * Experience type - digital vs physical preference
 */
export const ExperienceType = z.enum([
  'digital_native',    // Prefers digital experiences
  'physical_focused',  // Prefers in-person, tangible
  'blended'            // Comfortable with both
]);
export type ExperienceType = z.infer<typeof ExperienceType>;

/**
 * Novelty tolerance - experimentation level
 */
export const NoveltyTolerance = z.enum([
  'conservative',   // Prefers familiar, tried-and-true
  'moderate',       // Open to new with some caution
  'explorer'        // Actively seeks new experiences
]);
export type NoveltyTolerance = z.infer<typeof NoveltyTolerance>;

/**
 * Complete lifestyle profile as per spec section 2.2
 */
export const LifestyleProfileSchema = z.object({
  routine_style: RoutineStyle.default('hybrid'),
  social_orientation: SocialOrientation.default('adaptive'),
  convenience_bias: ConvenienceBias.default('balanced'),
  experience_type: ExperienceType.default('blended'),
  novelty_tolerance: NoveltyTolerance.default('moderate'),
  confidence: z.number().min(0).max(100).default(0),
  last_updated_at: z.string().datetime().optional()
});
export type LifestyleProfile = z.infer<typeof LifestyleProfileSchema>;

// =============================================================================
// VTID-01133: Alignment Tags (per spec section 5.2)
// =============================================================================

/**
 * Taste and lifestyle tags for downstream consumers
 */
export const AlignmentTag = z.enum([
  'minimalist_fit',      // Fits minimalist preferences
  'premium_fit',         // Fits premium orientation
  'convenience_first',   // Optimized for convenience
  'exploratory_ok',      // Suitable for exploration-minded users
  'classic_style',       // Matches classic aesthetic
  'modern_fit',          // Matches modern aesthetic
  'solo_appropriate',    // Good for individual context
  'social_appropriate',  // Good for social context
  'routine_compatible',  // Works with structured routines
  'flexible_fit'         // Works with flexible lifestyles
]);
export type AlignmentTag = z.infer<typeof AlignmentTag>;

// =============================================================================
// VTID-01133: Alignment Scoring
// =============================================================================

/**
 * Alignment score breakdown for transparency/explainability
 */
export const AlignmentBreakdownSchema = z.object({
  taste_score: z.number().min(0).max(1),
  lifestyle_score: z.number().min(0).max(1),
  taste_factors: z.array(z.object({
    factor: z.string(),
    contribution: z.number(),
    reason: z.string()
  })).default([]),
  lifestyle_factors: z.array(z.object({
    factor: z.string(),
    contribution: z.number(),
    reason: z.string()
  })).default([])
});
export type AlignmentBreakdown = z.infer<typeof AlignmentBreakdownSchema>;

/**
 * Aligned action - action with alignment metadata
 */
export const AlignedActionSchema = z.object({
  action_id: z.string(),
  action_type: z.string(),
  action_data: z.unknown(),
  alignment_score: z.number().min(0).max(1),
  lifestyle_fit: z.number().min(0).max(1),
  confidence: z.number().min(0).max(100),
  tags: z.array(AlignmentTag).default([]),
  breakdown: AlignmentBreakdownSchema.optional(),
  reframing_suggestion: z.string().optional(),
  excluded: z.boolean().default(false),
  exclusion_reason: z.string().optional()
});
export type AlignedAction = z.infer<typeof AlignedActionSchema>;

// =============================================================================
// VTID-01133: Combined Alignment Bundle
// =============================================================================

/**
 * Complete taste alignment bundle for a user
 */
export const TasteAlignmentBundleSchema = z.object({
  taste_profile: TasteProfileSchema,
  lifestyle_profile: LifestyleProfileSchema,
  combined_confidence: z.number().min(0).max(100).default(0),
  profile_completeness: z.number().min(0).max(100).default(0),
  sparse_data: z.boolean().default(true),
  computed_at: z.string().datetime()
});
export type TasteAlignmentBundle = z.infer<typeof TasteAlignmentBundleSchema>;

// =============================================================================
// VTID-01133: Signal Inference Types
// =============================================================================

/**
 * Sources for taste/lifestyle inference
 */
export const TasteSignalSource = z.enum([
  'explicit_setting',     // User explicitly set
  'language_analysis',    // Inferred from language patterns
  'brand_interaction',    // From brand/product interactions
  'reaction_pattern',     // From acceptance/rejection patterns
  'diary_content',        // From diary entries
  'behavior_pattern',     // From general behavior
  'social_pattern',       // From social interactions
  'onboarding'            // From onboarding responses
]);
export type TasteSignalSource = z.infer<typeof TasteSignalSource>;

/**
 * Taste signal - evidence for taste inference
 */
export const TasteSignalSchema = z.object({
  source: TasteSignalSource,
  signal_type: z.enum(['taste', 'lifestyle']),
  dimension: z.string(),
  inferred_value: z.string(),
  confidence: z.number().min(0).max(100),
  evidence: z.string().optional(),
  observed_at: z.string().datetime()
});
export type TasteSignal = z.infer<typeof TasteSignalSchema>;

// =============================================================================
// VTID-01133: Action Input Types
// =============================================================================

/**
 * Action to score for alignment
 */
export const ActionToScoreSchema = z.object({
  id: z.string(),
  type: z.string(), // recommendation, product, service, event, content, etc.
  attributes: z.object({
    complexity: z.enum(['simple', 'moderate', 'complex']).optional(),
    price_tier: z.enum(['budget', 'mid', 'premium', 'luxury']).optional(),
    aesthetic: AestheticStyle.optional(),
    tone: ToneAffinity.optional(),
    social_setting: z.enum(['solo', 'small_group', 'large_group']).optional(),
    convenience_level: z.enum(['low', 'medium', 'high']).optional(),
    novelty_level: z.enum(['familiar', 'moderate', 'novel']).optional(),
    experience_mode: z.enum(['digital', 'physical', 'hybrid']).optional(),
    timing_flexibility: z.enum(['fixed', 'flexible']).optional(),
    tags: z.array(z.string()).optional()
  }).passthrough()
});
export type ActionToScore = z.infer<typeof ActionToScoreSchema>;

// =============================================================================
// VTID-01133: API Request/Response Schemas
// =============================================================================

/**
 * Get alignment bundle request (no body needed, uses auth)
 */
export const GetAlignmentBundleRequestSchema = z.object({});
export type GetAlignmentBundleRequest = z.infer<typeof GetAlignmentBundleRequestSchema>;

/**
 * Set taste profile request
 */
export const SetTasteProfileRequestSchema = z.object({
  simplicity_preference: SimplicityPreference.optional(),
  premium_orientation: PremiumOrientation.optional(),
  aesthetic_style: AestheticStyle.optional(),
  tone_affinity: ToneAffinity.optional()
});
export type SetTasteProfileRequest = z.infer<typeof SetTasteProfileRequestSchema>;

/**
 * Set lifestyle profile request
 */
export const SetLifestyleProfileRequestSchema = z.object({
  routine_style: RoutineStyle.optional(),
  social_orientation: SocialOrientation.optional(),
  convenience_bias: ConvenienceBias.optional(),
  experience_type: ExperienceType.optional(),
  novelty_tolerance: NoveltyTolerance.optional()
});
export type SetLifestyleProfileRequest = z.infer<typeof SetLifestyleProfileRequestSchema>;

/**
 * Score actions request
 */
export const ScoreActionsRequestSchema = z.object({
  actions: z.array(ActionToScoreSchema),
  include_breakdown: z.boolean().optional().default(false),
  min_alignment_threshold: z.number().min(0).max(1).optional().default(0.3),
  exclude_low_alignment: z.boolean().optional().default(false)
});
export type ScoreActionsRequest = z.infer<typeof ScoreActionsRequestSchema>;

/**
 * Record reaction request - for implicit taste learning
 */
export const RecordReactionRequestSchema = z.object({
  action_id: z.string(),
  action_type: z.string(),
  reaction: z.enum(['accepted', 'rejected', 'saved', 'dismissed', 'engaged', 'skipped']),
  context: z.object({
    attributes: z.record(z.unknown()).optional(),
    session_id: z.string().optional()
  }).optional()
});
export type RecordReactionRequest = z.infer<typeof RecordReactionRequestSchema>;

// =============================================================================
// VTID-01133: API Response Types
// =============================================================================

/**
 * Standard API response
 */
export interface TasteAlignmentApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Get alignment bundle response
 */
export interface GetAlignmentBundleResponse {
  ok: boolean;
  bundle?: TasteAlignmentBundle;
  error?: string;
}

/**
 * Set profile response
 */
export interface SetProfileResponse {
  ok: boolean;
  profile_type?: 'taste' | 'lifestyle';
  updated_fields?: string[];
  new_confidence?: number;
  error?: string;
}

/**
 * Score actions response
 */
export interface ScoreActionsResponse {
  ok: boolean;
  aligned_actions?: AlignedAction[];
  excluded_count?: number;
  average_alignment?: number;
  error?: string;
}

/**
 * Record reaction response
 */
export interface RecordReactionResponse {
  ok: boolean;
  recorded?: boolean;
  signal_id?: string;
  inference_triggered?: boolean;
  error?: string;
}

// =============================================================================
// VTID-01133: Audit Types
// =============================================================================

/**
 * Taste alignment audit entry
 */
export interface TasteAlignmentAuditEntry {
  id: string;
  action: 'taste_profile_updated' | 'lifestyle_profile_updated' | 'signal_recorded' |
          'inference_applied' | 'bundle_computed' | 'actions_scored' | 'reaction_recorded';
  target_type: 'taste_profile' | 'lifestyle_profile' | 'signal' | 'bundle' | 'scoring' | 'reaction';
  target_id: string | null;
  old_value: unknown;
  new_value: unknown;
  confidence_delta: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// =============================================================================
// VTID-01133: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for taste alignment
 */
export const TASTE_ALIGNMENT_EVENT_TYPES = [
  'taste.profile.updated',
  'lifestyle.profile.updated',
  'taste.signal.recorded',
  'taste.inference.applied',
  'taste.bundle.computed',
  'taste.actions.scored',
  'taste.reaction.recorded'
] as const;

export type TasteAlignmentEventType = typeof TASTE_ALIGNMENT_EVENT_TYPES[number];

/**
 * OASIS event payload for taste alignment
 */
export interface TasteAlignmentEventPayload {
  vtid: string;
  tenant_id: string;
  user_id: string;
  action: TasteAlignmentEventType;
  target_type: 'taste_profile' | 'lifestyle_profile' | 'signal' | 'bundle' | 'scoring' | 'reaction';
  target_id?: string;
  confidence_delta?: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01133: Constants
// =============================================================================

/**
 * Dimension metadata for taste profile
 */
export const TASTE_DIMENSION_METADATA = {
  simplicity_preference: {
    label: 'Simplicity Preference',
    description: 'How you prefer complexity in recommendations',
    options: {
      minimalist: 'Fewer, simpler options',
      balanced: 'Moderate complexity',
      comprehensive: 'Detailed, thorough options'
    }
  },
  premium_orientation: {
    label: 'Premium Orientation',
    description: 'Your preference for premium vs value options',
    options: {
      value_focused: 'Affordable, value-oriented',
      quality_balanced: 'Balance of quality and value',
      premium_oriented: 'Premium, high-end options'
    }
  },
  aesthetic_style: {
    label: 'Aesthetic Style',
    description: 'Your visual and experiential style preference',
    options: {
      modern: 'Contemporary, cutting-edge',
      classic: 'Traditional, timeless',
      eclectic: 'Mixed, unique combinations',
      natural: 'Organic, nature-inspired',
      functional: 'Practical, utility-focused',
      neutral: 'No strong preference'
    }
  },
  tone_affinity: {
    label: 'Tone Affinity',
    description: 'Your preferred communication style',
    options: {
      technical: 'Precise, data-driven',
      expressive: 'Warm, story-driven',
      casual: 'Relaxed, informal',
      professional: 'Formal, business-like',
      minimalist: 'Concise, no-frills',
      neutral: 'Adaptive'
    }
  }
};

/**
 * Dimension metadata for lifestyle profile
 */
export const LIFESTYLE_DIMENSION_METADATA = {
  routine_style: {
    label: 'Routine Style',
    description: 'How structured your daily patterns are',
    options: {
      structured: 'Fixed schedules, predictable',
      flexible: 'Adapts easily, spontaneous',
      hybrid: 'Mix of structure and flexibility'
    }
  },
  social_orientation: {
    label: 'Social Orientation',
    description: 'Your preference for solo vs group activities',
    options: {
      solo_focused: 'Individual activities',
      small_groups: 'Intimate settings',
      social_oriented: 'Larger social settings',
      adaptive: 'Varies by context'
    }
  },
  convenience_bias: {
    label: 'Convenience Bias',
    description: 'How you balance convenience with intentionality',
    options: {
      convenience_first: 'Prioritizes ease and speed',
      balanced: 'Balances convenience with quality',
      intentional_living: 'Values craft, process, meaning'
    }
  },
  experience_type: {
    label: 'Experience Type',
    description: 'Your preference for digital vs physical experiences',
    options: {
      digital_native: 'Digital experiences',
      physical_focused: 'In-person, tangible',
      blended: 'Comfortable with both'
    }
  },
  novelty_tolerance: {
    label: 'Novelty Tolerance',
    description: 'How open you are to new experiences',
    options: {
      conservative: 'Familiar, tried-and-true',
      moderate: 'Open with some caution',
      explorer: 'Actively seeks new'
    }
  }
};
