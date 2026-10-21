/**
 * VTID-01129: D35 Social Context, Relationship Weighting & Proximity Engine Types
 *
 * Type definitions for understanding who matters right now in the user's life
 * and how social context should shape recommendations.
 *
 * D35 ensures the system reasons about:
 * - Personal relationships
 * - Social proximity
 * - Group relevance
 * - Social comfort & trust
 *
 * Hard Constraints (from spec):
 * - Never force introductions
 * - Respect explicit social boundaries immediately
 * - Avoid monetization through social pressure
 * - Gradually expand social graph unless user opts out
 *
 * Dependencies: D20-D34
 */

import { z } from 'zod';

// =============================================================================
// VTID-01129: Relationship Categories
// =============================================================================

/**
 * Relationship tier categories for graph activation
 */
export const RELATIONSHIP_TIERS = [
  'close',        // Friends, partner, family - high trust, frequent interaction
  'weak',         // Coworkers, acquaintances - moderate trust, occasional interaction
  'community',    // Groups, meetups, memberships - shared interests
  'professional'  // Mentors, clients, providers - transactional/advisory
] as const;

export type RelationshipTier = typeof RELATIONSHIP_TIERS[number];

/**
 * Relationship tier metadata
 */
export interface RelationshipTierMetadata {
  tier: RelationshipTier;
  display_name: string;
  description: string;
  default_trust_level: number;  // 0-100
  default_proximity_weight: number;  // 0-1
  comfort_for_new_intro: boolean;
}

/**
 * Canon tier metadata definitions
 */
export const RELATIONSHIP_TIER_METADATA: Record<RelationshipTier, RelationshipTierMetadata> = {
  close: {
    tier: 'close',
    display_name: 'Close Relationships',
    description: 'Friends, partner, family - high trust, frequent interaction',
    default_trust_level: 90,
    default_proximity_weight: 1.0,
    comfort_for_new_intro: true
  },
  weak: {
    tier: 'weak',
    display_name: 'Weak Ties',
    description: 'Coworkers, acquaintances - moderate trust, occasional interaction',
    default_trust_level: 50,
    default_proximity_weight: 0.5,
    comfort_for_new_intro: true
  },
  community: {
    tier: 'community',
    display_name: 'Community Ties',
    description: 'Groups, meetups, memberships - shared interests',
    default_trust_level: 60,
    default_proximity_weight: 0.6,
    comfort_for_new_intro: false
  },
  professional: {
    tier: 'professional',
    display_name: 'Professional Ties',
    description: 'Mentors, clients, providers - transactional/advisory relationship',
    default_trust_level: 70,
    default_proximity_weight: 0.4,
    comfort_for_new_intro: false
  }
};

// =============================================================================
// VTID-01129: Active Relationship Set
// =============================================================================

/**
 * Active relationship set - which tiers are relevant right now
 */
export interface ActiveRelationshipSet {
  close: boolean;
  weak: boolean;
  community: boolean;
  professional: boolean;
  /** Which tier is most relevant for current context */
  primary_tier: RelationshipTier | null;
  /** Reason for activation (for audit/explainability) */
  activation_reason: string;
}

/**
 * Default (neutral) relationship set when no context
 */
export const DEFAULT_ACTIVE_RELATIONSHIP_SET: ActiveRelationshipSet = {
  close: true,
  weak: true,
  community: true,
  professional: true,
  primary_tier: null,
  activation_reason: 'default_neutral'
};

// =============================================================================
// VTID-01129: Social Proximity Scoring
// =============================================================================

/**
 * Factors that contribute to social proximity score
 */
export interface SocialProximityFactors {
  /** Recency of last interaction (0-100) */
  interaction_recency: number;
  /** Shared interests/goals overlap (0-100) */
  shared_interests: number;
  /** Physical proximity if known (0-100, null if unknown) */
  physical_proximity: number | null;
  /** Emotional tone history (0-100, 50=neutral) */
  emotional_tone: number;
  /** Contextual relevance to current intent (0-100) */
  contextual_relevance: number;
}

/**
 * Social proximity score for a connection
 */
export interface SocialProximityScore {
  /** The connection node ID */
  node_id: string;
  /** Normalized score 0.0-1.0 */
  score: number;
  /** Raw score 0-100 before normalization */
  raw_score: number;
  /** Breakdown of contributing factors */
  factors: SocialProximityFactors;
  /** Relationship tier of this connection */
  tier: RelationshipTier;
  /** Timestamp of score computation */
  computed_at: string;
  /** Cache TTL in seconds */
  ttl_seconds: number;
}

/**
 * Weights for proximity factor calculation
 * These sum to 1.0 (or close to it accounting for null physical_proximity)
 */
export const PROXIMITY_FACTOR_WEIGHTS = {
  interaction_recency: 0.30,      // 30%
  shared_interests: 0.25,         // 25%
  physical_proximity: 0.10,       // 10% (redistributed if null)
  emotional_tone: 0.15,           // 15%
  contextual_relevance: 0.20      // 20%
} as const;

// =============================================================================
// VTID-01129: Social Comfort Profile
// =============================================================================

/**
 * Social comfort level for different interaction types
 */
export type ComfortLevel = 'comfortable' | 'neutral' | 'uncomfortable' | 'unknown';

/**
 * Social comfort profile for the user
 */
export interface SocialComfortProfile {
  /** Comfort with one-to-one interactions */
  one_to_one: ComfortLevel;
  /** Confidence in one_to_one assessment (0-100) */
  one_to_one_confidence: number;

  /** Comfort with small groups (2-6 people) */
  small_group: ComfortLevel;
  /** Confidence in small_group assessment (0-100) */
  small_group_confidence: number;

  /** Comfort with large groups (7+ people) */
  large_group: ComfortLevel;
  /** Confidence in large_group assessment (0-100) */
  large_group_confidence: number;

  /** Comfort with meeting new people */
  new_people: ComfortLevel;
  /** Confidence in new_people assessment (0-100) */
  new_people_confidence: number;

  /** Overall social energy level (0-100) */
  social_energy: number;

  /** Last updated */
  updated_at: string;

  /** Evidence that informed this profile */
  evidence: SocialComfortEvidence[];
}

/**
 * Evidence that contributed to comfort profile
 */
export interface SocialComfortEvidence {
  source: 'diary' | 'explicit' | 'behavioral' | 'preference' | 'inferred';
  signal: string;
  weight: number;
  timestamp: string;
}

/**
 * Default comfort profile (unknown state)
 */
export const DEFAULT_SOCIAL_COMFORT_PROFILE: SocialComfortProfile = {
  one_to_one: 'neutral',
  one_to_one_confidence: 50,
  small_group: 'neutral',
  small_group_confidence: 50,
  large_group: 'unknown',
  large_group_confidence: 0,
  new_people: 'unknown',
  new_people_confidence: 0,
  social_energy: 50,
  updated_at: new Date().toISOString(),
  evidence: []
};

// =============================================================================
// VTID-01129: Social Context Tags
// =============================================================================

/**
 * Social context tags that can be applied to actions/recommendations
 */
export const SOCIAL_CONTEXT_TAGS = [
  'prefer_known_people',      // Prioritize existing connections
  'small_group_only',         // Limit to small group settings
  'large_group_ok',           // Large groups are acceptable
  'community_ok',             // Community-based activities acceptable
  'avoid_new_connections',    // Don't suggest new introductions
  'one_on_one_preferred',     // Prefer 1:1 interactions
  'professional_context',     // Professional setting appropriate
  'social_expansion_ok',      // User is open to expanding network
  'low_energy_mode',          // User has low social energy
  'high_energy_mode'          // User has high social energy
] as const;

export type SocialContextTag = typeof SOCIAL_CONTEXT_TAGS[number];

// =============================================================================
// VTID-01129: Socially Weighted Actions
// =============================================================================

/**
 * Social context associated with an action
 */
export interface ActionSocialContext {
  /** Recommended group size range */
  group_size: {
    min: number;
    max: number;
  };
  /** Whether action involves new people */
  involves_new_people: boolean;
  /** Whether action is public or private */
  visibility: 'public' | 'private' | 'semi-private';
  /** Required relationship tier for participants */
  required_tier: RelationshipTier | null;
  /** Preferred time of day */
  preferred_timing: 'morning' | 'afternoon' | 'evening' | 'flexible';
}

/**
 * Socially weighted action with context
 */
export interface SociallyWeightedAction {
  /** Action identifier */
  action_id: string;
  /** Action type */
  action_type: string;
  /** Human-readable action description */
  action_description: string;
  /** Social context for this action */
  social_context: ActionSocialContext;
  /** Proximity score if action involves specific person */
  proximity_score: number | null;
  /** How well this action fits user's comfort profile (0-100) */
  comfort_fit: number;
  /** Applied social context tags */
  tags: SocialContextTag[];
  /** Why this action was suggested */
  rationale: string;
}

// =============================================================================
// VTID-01129: Social Context Bundle (Canonical Output)
// =============================================================================

/**
 * Complete social context bundle for a turn/request
 */
export interface SocialContextBundle {
  /** Active relationship tiers for this context */
  active_relationship_set: ActiveRelationshipSet;

  /** User's comfort profile */
  comfort_profile: SocialComfortProfile;

  /** Top relevant connections with proximity scores */
  relevant_connections: SocialProximityScore[];

  /** Social context tags for filtering */
  context_tags: SocialContextTag[];

  /** Socially weighted actions (if requested) */
  weighted_actions: SociallyWeightedAction[];

  /** Metadata for audit */
  metadata: {
    bundle_id: string;
    computed_at: string;
    input_hash: string;
    version: string;
  };
}

// =============================================================================
// VTID-01129: API Request/Response Schemas
// =============================================================================

/**
 * Compute social context request
 */
export const ComputeSocialContextRequestSchema = z.object({
  /** Current domain (from D22) */
  domain: z.string().optional(),
  /** Current intent type (from D21) */
  intent_type: z.string().optional(),
  /** Emotional state (from D28) */
  emotional_state: z.string().optional(),
  /** Whether user explicitly requested social activity */
  social_intent: z.boolean().optional().default(false),
  /** Maximum connections to return with scores */
  max_connections: z.number().int().min(1).max(50).optional().default(10),
  /** Whether to include weighted actions */
  include_actions: z.boolean().optional().default(false)
});

export type ComputeSocialContextRequest = z.infer<typeof ComputeSocialContextRequestSchema>;

/**
 * Compute social context response
 */
export interface ComputeSocialContextResponse {
  ok: boolean;
  error?: string;
  message?: string;
  bundle?: SocialContextBundle;
  processing_time_ms?: number;
}

/**
 * Get proximity score request
 */
export const GetProximityScoreRequestSchema = z.object({
  /** Node ID to score */
  node_id: z.string().uuid(),
  /** Context for scoring */
  context_domain: z.string().optional()
});

export type GetProximityScoreRequest = z.infer<typeof GetProximityScoreRequestSchema>;

/**
 * Get proximity score response
 */
export interface GetProximityScoreResponse {
  ok: boolean;
  error?: string;
  message?: string;
  score?: SocialProximityScore;
}

/**
 * Update comfort profile request
 */
export const UpdateComfortProfileRequestSchema = z.object({
  /** Field to update */
  field: z.enum(['one_to_one', 'small_group', 'large_group', 'new_people', 'social_energy']),
  /** New value (ComfortLevel or number for social_energy) */
  value: z.union([
    z.enum(['comfortable', 'neutral', 'uncomfortable', 'unknown']),
    z.number().int().min(0).max(100)
  ]),
  /** Source of this update */
  source: z.enum(['diary', 'explicit', 'behavioral', 'preference', 'inferred']).default('explicit')
});

export type UpdateComfortProfileRequest = z.infer<typeof UpdateComfortProfileRequestSchema>;

/**
 * Update comfort profile response
 */
export interface UpdateComfortProfileResponse {
  ok: boolean;
  error?: string;
  message?: string;
  profile?: SocialComfortProfile;
}

/**
 * Get comfort profile response
 */
export interface GetComfortProfileResponse {
  ok: boolean;
  error?: string;
  message?: string;
  profile?: SocialComfortProfile;
}

// =============================================================================
// VTID-01129: Filtering Rules
// =============================================================================

/**
 * Social filtering rule
 */
export interface SocialFilteringRule {
  rule_id: string;
  name: string;
  description: string;
  condition: {
    comfort_field?: keyof Pick<SocialComfortProfile, 'one_to_one' | 'small_group' | 'large_group' | 'new_people'>;
    comfort_value?: ComfortLevel;
    social_energy_max?: number;
    social_energy_min?: number;
  };
  action: {
    exclude_tags?: SocialContextTag[];
    require_tags?: SocialContextTag[];
    max_group_size?: number;
    avoid_new_people?: boolean;
  };
  priority: number;
}

/**
 * Canonical social filtering rules (spec section 3)
 */
export const SOCIAL_FILTERING_RULES: SocialFilteringRule[] = [
  {
    rule_id: 'rule_low_energy',
    name: 'Low Energy Mode',
    description: 'When social energy is low, prefer smaller/known groups',
    condition: {
      social_energy_max: 30
    },
    action: {
      require_tags: ['small_group_only', 'prefer_known_people', 'low_energy_mode'],
      max_group_size: 4,
      avoid_new_people: true
    },
    priority: 10
  },
  {
    rule_id: 'rule_uncomfortable_large_groups',
    name: 'Avoid Large Groups',
    description: 'When uncomfortable with large groups, limit group size',
    condition: {
      comfort_field: 'large_group',
      comfort_value: 'uncomfortable'
    },
    action: {
      exclude_tags: ['large_group_ok'],
      require_tags: ['small_group_only'],
      max_group_size: 6
    },
    priority: 20
  },
  {
    rule_id: 'rule_uncomfortable_new_people',
    name: 'Avoid New Introductions',
    description: 'When uncomfortable with new people, avoid introductions',
    condition: {
      comfort_field: 'new_people',
      comfort_value: 'uncomfortable'
    },
    action: {
      require_tags: ['prefer_known_people', 'avoid_new_connections'],
      avoid_new_people: true
    },
    priority: 30
  },
  {
    rule_id: 'rule_high_energy_expansion',
    name: 'Social Expansion Mode',
    description: 'When high social energy and comfortable, allow expansion',
    condition: {
      social_energy_min: 70
    },
    action: {
      require_tags: ['social_expansion_ok', 'high_energy_mode']
    },
    priority: 40
  }
];

// =============================================================================
// VTID-01129: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for social context engine
 */
export const SOCIAL_CONTEXT_EVENT_TYPES = [
  'd35.context.computed',
  'd35.context.compute.failed',
  'd35.proximity.scored',
  'd35.comfort.updated',
  'd35.action.filtered',
  'd35.boundary.respected'
] as const;

export type SocialContextEventType = typeof SOCIAL_CONTEXT_EVENT_TYPES[number];

// =============================================================================
// VTID-01129: Helper Functions
// =============================================================================

/**
 * Check if a comfort level is acceptable for an action
 */
export function isComfortAcceptable(level: ComfortLevel): boolean {
  return level === 'comfortable' || level === 'neutral';
}

/**
 * Get relationship tier from edge strength and type
 */
export function inferRelationshipTier(
  relationshipType: string,
  strength: number
): RelationshipTier {
  // Friend with high strength = close
  if (relationshipType === 'friend' && strength >= 60) {
    return 'close';
  }
  // Member of group = community
  if (relationshipType === 'member' || relationshipType === 'attendee') {
    return 'community';
  }
  // Using/following services = professional
  if (relationshipType === 'using' || relationshipType === 'following') {
    return 'professional';
  }
  // Everything else = weak ties
  return 'weak';
}

/**
 * Calculate weighted proximity score from factors
 */
export function calculateProximityScore(factors: SocialProximityFactors): number {
  let score = 0;
  let totalWeight = 0;

  // Interaction recency
  score += factors.interaction_recency * PROXIMITY_FACTOR_WEIGHTS.interaction_recency;
  totalWeight += PROXIMITY_FACTOR_WEIGHTS.interaction_recency;

  // Shared interests
  score += factors.shared_interests * PROXIMITY_FACTOR_WEIGHTS.shared_interests;
  totalWeight += PROXIMITY_FACTOR_WEIGHTS.shared_interests;

  // Physical proximity (redistribute weight if null)
  if (factors.physical_proximity !== null) {
    score += factors.physical_proximity * PROXIMITY_FACTOR_WEIGHTS.physical_proximity;
    totalWeight += PROXIMITY_FACTOR_WEIGHTS.physical_proximity;
  }

  // Emotional tone (centered at 50 = neutral)
  score += factors.emotional_tone * PROXIMITY_FACTOR_WEIGHTS.emotional_tone;
  totalWeight += PROXIMITY_FACTOR_WEIGHTS.emotional_tone;

  // Contextual relevance
  score += factors.contextual_relevance * PROXIMITY_FACTOR_WEIGHTS.contextual_relevance;
  totalWeight += PROXIMITY_FACTOR_WEIGHTS.contextual_relevance;

  // Normalize by actual weight used
  const rawScore = totalWeight > 0 ? score / totalWeight : 0;
  return Math.min(1.0, Math.max(0.0, rawScore / 100));
}

/**
 * Determine social context tags from comfort profile and energy
 */
export function deriveContextTags(profile: SocialComfortProfile): SocialContextTag[] {
  const tags: SocialContextTag[] = [];

  // Energy-based tags
  if (profile.social_energy < 30) {
    tags.push('low_energy_mode');
    tags.push('small_group_only');
    tags.push('prefer_known_people');
  } else if (profile.social_energy >= 70) {
    tags.push('high_energy_mode');
    tags.push('social_expansion_ok');
  }

  // Comfort-based tags
  if (profile.one_to_one === 'comfortable' && profile.one_to_one_confidence >= 60) {
    tags.push('one_on_one_preferred');
  }

  if (profile.large_group === 'comfortable' && profile.large_group_confidence >= 60) {
    tags.push('large_group_ok');
  }

  if (profile.large_group === 'uncomfortable' && profile.large_group_confidence >= 50) {
    tags.push('small_group_only');
  }

  if (profile.new_people === 'uncomfortable' && profile.new_people_confidence >= 50) {
    tags.push('avoid_new_connections');
    tags.push('prefer_known_people');
  } else if (profile.new_people === 'comfortable' && profile.new_people_confidence >= 60) {
    tags.push('social_expansion_ok');
  }

  // Remove duplicates
  return [...new Set(tags)];
}

/**
 * Generate input hash for determinism verification
 */
export function generateSocialContextHash(
  domain: string | undefined,
  intentType: string | undefined,
  emotionalState: string | undefined,
  comfortProfile: SocialComfortProfile
): string {
  const input = JSON.stringify({
    domain: domain || 'unknown',
    intentType: intentType || 'unknown',
    emotionalState: emotionalState || 'neutral',
    socialEnergy: comfortProfile.social_energy,
    comfortOne: comfortProfile.one_to_one,
    comfortSmall: comfortProfile.small_group,
    comfortLarge: comfortProfile.large_group,
    comfortNew: comfortProfile.new_people
  });

  // Simple hash for determinism verification
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `d35_${Math.abs(hash).toString(16)}`;
}
