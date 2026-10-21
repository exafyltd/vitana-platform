/**
 * VTID-01144: D50 Positive Trajectory Reinforcement & Momentum Engine
 *
 * Type definitions for the positive-only reinforcement system that identifies
 * what's working and helps users continue their positive trajectories.
 *
 * This engine answers: "What's going well, and how can it be sustained?"
 *
 * Core Philosophy:
 *   - Positive-only reinforcement (no correction)
 *   - No comparison with others
 *   - No gamification pressure
 *   - No behavioral enforcement
 *   - Focus on continuation, not escalation
 *   - Explainability mandatory
 *
 * Hard Governance:
 *   - Memory-first
 *   - All outputs logged to OASIS
 *   - No schema-breaking changes
 *   - Reinforcement must feel authentic
 *
 * Determinism Rules:
 *   - Same positive signals → same reinforcement eligibility
 *   - Same trajectory data → same reinforcement output
 *   - Rule-based, no generative inference at this layer
 */

import { z } from 'zod';
import { LongitudinalDomain, TrendAnalysis, TrendDirection } from './longitudinal-adaptation';

// =============================================================================
// VTID-01144: Trajectory Types
// =============================================================================

/**
 * Types of positive trajectories that can be reinforced
 * Each reinforcement must belong to exactly one type
 */
export const TrajectoryType = z.enum([
  'health',        // Health Improvement - physical wellbeing trends
  'routine',       // Routine Stability - consistent patterns
  'social',        // Social Engagement - connection patterns
  'emotional',     // Emotional Balance - emotional regulation
  'learning',      // Skill / Learning Progress - growth areas
  'consistency'    // Consistency & Discipline - sustained behaviors
]);
export type TrajectoryType = z.infer<typeof TrajectoryType>;

/**
 * Mapping from longitudinal domains to trajectory types
 */
export const DOMAIN_TO_TRAJECTORY_MAP: Record<LongitudinalDomain, TrajectoryType | null> = {
  'preference': null,           // Not directly mapped to a trajectory
  'goal': 'learning',           // Goals relate to learning/progress
  'engagement': 'consistency',  // Engagement relates to consistency
  'social': 'social',           // Direct mapping
  'monetization': null,         // Not directly mapped
  'health': 'health',           // Direct mapping
  'communication': 'social',    // Communication relates to social
  'autonomy': 'emotional'       // Autonomy relates to emotional balance
};

// =============================================================================
// VTID-01144: Positive Signal Types (D44 Interface)
// =============================================================================

/**
 * Positive signal from D44 (or derived from D43)
 * Represents a detected moment of success, progress, or positive behavior
 */
export const PositiveSignalSchema = z.object({
  id: z.string().uuid(),
  domain: z.string(),
  signal_type: z.enum(['success', 'progress', 'consistency', 'improvement', 'milestone']),
  confidence: z.number().min(0).max(100),
  detected_at: z.string().datetime(),
  evidence: z.string(),
  numeric_value: z.number().nullable().optional(),
  metadata: z.record(z.unknown()).optional()
});
export type PositiveSignal = z.infer<typeof PositiveSignalSchema>;

// =============================================================================
// VTID-01144: Opportunity Window Types (D45 Interface)
// =============================================================================

/**
 * Opportunity window from D45 (or derived)
 * Represents an optimal timing for reinforcement
 */
export const OpportunityWindowSchema = z.object({
  id: z.string().uuid(),
  window_type: z.enum(['engagement_peak', 'routine_anchor', 'reflection_moment', 'achievement_context']),
  is_open: z.boolean(),
  opens_at: z.string().datetime().nullable().optional(),
  closes_at: z.string().datetime().nullable().optional(),
  confidence: z.number().min(0).max(100),
  context: z.record(z.unknown()).optional()
});
export type OpportunityWindow = z.infer<typeof OpportunityWindowSchema>;

// =============================================================================
// VTID-01144: Reinforcement Types
// =============================================================================

/**
 * Generated reinforcement (core output of D50)
 * This is the positive feedback that will be delivered to the user
 */
export const ReinforcementSchema = z.object({
  reinforcement_id: z.string().uuid(),
  trajectory_type: TrajectoryType,
  confidence: z.number().min(0).max(100),
  what_is_working: z.string().min(1).max(500),
  why_it_matters: z.string().min(1).max(500),
  suggested_focus: z.string().max(300).nullable().optional(),
  dismissible: z.boolean().default(true)
});
export type Reinforcement = z.infer<typeof ReinforcementSchema>;

/**
 * Database record for stored reinforcements
 */
export const StoredReinforcementSchema = ReinforcementSchema.extend({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  source_signals: z.array(z.string().uuid()).default([]),
  source_trends: z.array(z.string()).default([]),
  context_snapshot: z.record(z.unknown()).optional(),
  generated_at: z.string().datetime(),
  delivered_at: z.string().datetime().nullable().optional(),
  dismissed_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type StoredReinforcement = z.infer<typeof StoredReinforcementSchema>;

// =============================================================================
// VTID-01144: Eligibility & Validation Types
// =============================================================================

/**
 * Reinforcement eligibility check result
 */
export const EligibilityResultSchema = z.object({
  eligible: z.boolean(),
  trajectory_type: TrajectoryType.nullable(),
  confidence: z.number().min(0).max(100),
  days_sustained: z.number().int().min(0),
  last_reinforcement_date: z.string().datetime().nullable().optional(),
  days_since_last_reinforcement: z.number().int().nullable().optional(),
  rejection_reason: z.string().nullable().optional(),
  evidence_summary: z.string().nullable().optional()
});
export type EligibilityResult = z.infer<typeof EligibilityResultSchema>;

/**
 * Input bundle for reinforcement generation
 */
export const ReinforcementInputBundleSchema = z.object({
  // Required inputs
  trends: z.record(z.unknown()).optional(),  // From D43
  positive_signals: z.array(PositiveSignalSchema).default([]),  // From D44 (when available)
  opportunity_windows: z.array(OpportunityWindowSchema).default([]),  // From D45 (when available)

  // Optional context
  user_goals: z.array(z.string()).optional(),
  user_values: z.array(z.string()).optional(),
  community_feedback: z.record(z.unknown()).optional(),
  past_reinforcements: z.array(z.string().uuid()).optional()
});
export type ReinforcementInputBundle = z.infer<typeof ReinforcementInputBundleSchema>;

// =============================================================================
// VTID-01144: API Request/Response Types
// =============================================================================

/**
 * Request to check reinforcement eligibility
 */
export const CheckEligibilityRequestSchema = z.object({
  trajectory_types: z.array(TrajectoryType).optional(),
  include_evidence: z.boolean().default(false)
});
export type CheckEligibilityRequest = z.infer<typeof CheckEligibilityRequestSchema>;

/**
 * Response for eligibility check
 */
export interface CheckEligibilityResponse {
  ok: boolean;
  eligible_trajectories: EligibilityResult[];
  any_eligible: boolean;
  next_possible_reinforcement: string | null;
  error?: string;
}

/**
 * Request to generate reinforcement
 */
export const GenerateReinforcementRequestSchema = z.object({
  trajectory_type: TrajectoryType.optional(),  // If not specified, pick best eligible
  force_regenerate: z.boolean().default(false),
  include_context_snapshot: z.boolean().default(true)
});
export type GenerateReinforcementRequest = z.infer<typeof GenerateReinforcementRequestSchema>;

/**
 * Response for reinforcement generation
 */
export interface GenerateReinforcementResponse {
  ok: boolean;
  reinforcement?: Reinforcement;
  reinforcement_id?: string;
  delivered: boolean;
  error?: string;
}

/**
 * Request to dismiss a reinforcement
 */
export const DismissReinforcementRequestSchema = z.object({
  reinforcement_id: z.string().uuid(),
  reason: z.enum(['not_relevant', 'already_aware', 'timing_off', 'no_reason']).optional()
});
export type DismissReinforcementRequest = z.infer<typeof DismissReinforcementRequestSchema>;

/**
 * Response for dismissal
 */
export interface DismissReinforcementResponse {
  ok: boolean;
  reinforcement_id?: string;
  dismissed_at?: string;
  error?: string;
}

/**
 * Request to get reinforcement history
 */
export const GetReinforcementHistoryRequestSchema = z.object({
  trajectory_types: z.array(TrajectoryType).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  include_dismissed: z.boolean().default(false)
});
export type GetReinforcementHistoryRequest = z.infer<typeof GetReinforcementHistoryRequestSchema>;

/**
 * Response for reinforcement history
 */
export interface GetReinforcementHistoryResponse {
  ok: boolean;
  reinforcements?: StoredReinforcement[];
  count?: number;
  error?: string;
}

/**
 * Request to get current momentum state
 */
export const GetMomentumStateRequestSchema = z.object({
  include_eligible: z.boolean().default(true),
  include_recent: z.boolean().default(true)
});
export type GetMomentumStateRequest = z.infer<typeof GetMomentumStateRequestSchema>;

/**
 * Momentum state response
 */
export interface MomentumState {
  overall_momentum: 'building' | 'stable' | 'fragile' | 'unknown';
  trajectory_summaries: Array<{
    trajectory_type: TrajectoryType;
    status: 'positive' | 'stable' | 'insufficient_data';
    days_sustained: number;
    last_reinforced_at: string | null;
    eligible_for_reinforcement: boolean;
  }>;
  recent_reinforcements: StoredReinforcement[];
  next_opportunity: string | null;
}

/**
 * Response for momentum state
 */
export interface GetMomentumStateResponse {
  ok: boolean;
  state?: MomentumState;
  computed_at?: string;
  error?: string;
}

// =============================================================================
// VTID-01144: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for positive trajectory reinforcement
 */
export const REINFORCEMENT_EVENT_TYPES = [
  'd50.eligibility.checked',
  'd50.reinforcement.generated',
  'd50.reinforcement.delivered',
  'd50.reinforcement.dismissed',
  'd50.momentum.computed',
  'd50.trajectory.detected'
] as const;

export type ReinforcementEventType = typeof REINFORCEMENT_EVENT_TYPES[number];

/**
 * OASIS event payload for reinforcement events
 */
export interface ReinforcementEventPayload {
  vtid: string;
  tenant_id?: string;
  user_id?: string;
  event_type: ReinforcementEventType;
  trajectory_type?: TrajectoryType;
  reinforcement_id?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01144: Configuration & Thresholds
// =============================================================================

/**
 * Reinforcement generation thresholds
 */
export const REINFORCEMENT_THRESHOLDS = {
  // Minimum days a positive trend must be sustained
  MIN_SUSTAINED_DAYS: 7,

  // Minimum confidence to generate reinforcement
  MIN_CONFIDENCE: 80,

  // Minimum days between reinforcements of same type
  MIN_DAYS_BETWEEN_REINFORCEMENTS: 21,

  // Maximum reinforcements per day across all types
  MAX_DAILY_REINFORCEMENTS: 2,

  // Minimum trend magnitude for detection
  MIN_TREND_MAGNITUDE: 15,

  // Minimum trend direction threshold (slope)
  MIN_TREND_SLOPE: 0.02,

  // Data requirements
  MIN_DATA_POINTS_FOR_TRAJECTORY: 5,

  // Time windows
  LOOKBACK_DAYS: 30,
  RECENT_REINFORCEMENT_WINDOW_DAYS: 7
} as const;

/**
 * Trajectory type metadata for display and messaging
 */
export const TRAJECTORY_TYPE_METADATA: Record<TrajectoryType, {
  label: string;
  description: string;
  icon: string;
  message_templates: {
    what_is_working: string[];
    why_it_matters: string[];
  };
}> = {
  health: {
    label: 'Health Improvement',
    description: 'Physical wellbeing and health-related behaviors',
    icon: 'heart',
    message_templates: {
      what_is_working: [
        'You have maintained consistent {behavior} over the past {days} days',
        'Your {behavior} pattern shows steady improvement',
        'The regularity of your {behavior} has been notable'
      ],
      why_it_matters: [
        'Sustained patterns like this support long-term wellbeing',
        'Consistency in this area tends to compound over time',
        'This kind of routine often becomes easier to maintain'
      ]
    }
  },
  routine: {
    label: 'Routine Stability',
    description: 'Consistent daily patterns and habits',
    icon: 'calendar',
    message_templates: {
      what_is_working: [
        'Your daily rhythm has been remarkably consistent',
        'You have maintained a stable pattern in {area}',
        'The regularity of your {behavior} stands out'
      ],
      why_it_matters: [
        'Stable routines reduce cognitive load',
        'Predictable patterns often support other areas of life',
        'This consistency can serve as an anchor'
      ]
    }
  },
  social: {
    label: 'Social Engagement',
    description: 'Connection and social interaction patterns',
    icon: 'users',
    message_templates: {
      what_is_working: [
        'You have been staying connected through {behavior}',
        'Your engagement with {context} has been consistent',
        'The pattern of {behavior} shows sustained connection'
      ],
      why_it_matters: [
        'Social connections often support overall wellbeing',
        'Sustained engagement tends to deepen relationships',
        'Regular connection patterns are often self-reinforcing'
      ]
    }
  },
  emotional: {
    label: 'Emotional Balance',
    description: 'Emotional regulation and stability',
    icon: 'smile',
    message_templates: {
      what_is_working: [
        'Your emotional patterns have shown stability',
        'You have maintained balance in {area}',
        'The consistency in how you handle {context} is notable'
      ],
      why_it_matters: [
        'Emotional stability often supports decision-making',
        'Sustained balance can make challenges more manageable',
        'This kind of consistency often builds resilience'
      ]
    }
  },
  learning: {
    label: 'Skill / Learning Progress',
    description: 'Growth, skill development, and learning',
    icon: 'book-open',
    message_templates: {
      what_is_working: [
        'You have been steadily engaging with {area}',
        'Your progress in {skill} shows consistent effort',
        'The pattern of practice in {area} has been sustained'
      ],
      why_it_matters: [
        'Consistent practice tends to accumulate',
        'Sustained effort in learning often compounds',
        'This kind of engagement supports long-term growth'
      ]
    }
  },
  consistency: {
    label: 'Consistency & Discipline',
    description: 'Sustained behaviors and disciplined patterns',
    icon: 'repeat',
    message_templates: {
      what_is_working: [
        'You have shown sustained commitment to {behavior}',
        'The consistency of {pattern} over {days} days is clear',
        'Your disciplined approach to {area} continues'
      ],
      why_it_matters: [
        'Sustained patterns often become natural over time',
        'Consistency in one area can support other areas',
        'This kind of discipline tends to build momentum'
      ]
    }
  }
};

/**
 * Framing rules for reinforcement messages
 */
export const FRAMING_RULES = {
  // Maximum words in what_is_working
  MAX_OBSERVATION_WORDS: 30,

  // Maximum words in why_it_matters
  MAX_EXPLANATION_WORDS: 25,

  // Maximum words in suggested_focus
  MAX_FOCUS_WORDS: 20,

  // Prohibited phrases (no praise inflation)
  PROHIBITED_PHRASES: [
    'amazing', 'incredible', 'fantastic', 'awesome',
    'perfect', 'excellent', 'outstanding', 'brilliant',
    'great job', 'well done', 'keep it up', 'you\'re doing great'
  ],

  // Required: neutral, observational tone
  TONE: 'observational',

  // Focus on continuation, not escalation
  FOCUS: 'continuation'
} as const;

// =============================================================================
// VTID-01144: Helper Types
// =============================================================================

/**
 * Trend analysis extended with trajectory context
 */
export interface TrajectoryTrendAnalysis extends TrendAnalysis {
  trajectory_type: TrajectoryType;
  is_positive: boolean;
  sustained_days: number;
}

/**
 * Derived positive signal from D43 trend
 */
export interface DerivedPositiveSignal {
  source: 'trend';
  trend_domain: LongitudinalDomain;
  trajectory_type: TrajectoryType;
  confidence: number;
  evidence: string;
  sustained_days: number;
}

/**
 * Combined signal input for reinforcement generation
 */
export type ReinforcementSignalInput = PositiveSignal | DerivedPositiveSignal;
