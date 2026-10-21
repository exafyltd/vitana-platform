/**
 * VTID-01137: D43 Longitudinal Adaptation, Drift Detection & Personal Evolution Engine
 *
 * Type definitions for the Longitudinal Adaptation system that tracks user evolution
 * over time and adapts intelligence accordingly - safely, gradually, and transparently.
 *
 * Core Philosophy:
 *   - Users evolve; the system must evolve with them
 *   - Never surprise the user with sudden changes
 *   - Preserve historical context and allow regression
 *   - Treat change as exploration unless confirmed
 *   - Prefer user confirmation for major shifts
 *
 * Determinism Rules:
 *   - Same longitudinal signals → same drift detection
 *   - Same drift pattern → same adaptation plan
 *   - Rule-based thresholds, no creative inference
 */

import { z } from 'zod';
import { PreferenceCategory } from './user-preferences';

// =============================================================================
// VTID-01137: Domain Types
// =============================================================================

/**
 * Domains tracked for longitudinal signals
 */
export const LongitudinalDomain = z.enum([
  'preference',      // Preference changes over time
  'goal',            // Goal shifts and evolution
  'engagement',      // Engagement pattern changes
  'social',          // Social behavior evolution
  'monetization',    // Monetization comfort changes
  'health',          // Health & energy trends (non-diagnostic)
  'communication',   // Communication style evolution
  'autonomy'         // Autonomy tolerance changes
]);
export type LongitudinalDomain = z.infer<typeof LongitudinalDomain>;

/**
 * Drift types that can be detected
 */
export const DriftType = z.enum([
  'gradual',         // Slow preference evolution over weeks/months
  'abrupt',          // Life events, travel, stress - sudden change
  'seasonal',        // Cyclical patterns (seasonal, weekly)
  'experimental',    // User exploring new behaviors
  'stable',          // No meaningful drift detected
  'regression'       // Return to prior state
]);
export type DriftType = z.infer<typeof DriftType>;

/**
 * Evolution tags for user state
 */
export const EvolutionTag = z.enum([
  'stable_preferences',       // Preferences are stable
  'drift_detected',           // Meaningful drift detected
  'exploration_phase',        // User is exploring new behaviors
  'major_shift_candidate',    // Potential major life/preference shift
  'seasonal_pattern',         // Seasonal behavior detected
  'regression_detected'       // User returning to prior state
]);
export type EvolutionTag = z.infer<typeof EvolutionTag>;

/**
 * Adaptation strategies
 */
export const AdaptationStrategy = z.enum([
  'soft_reweight',            // Gradually adjust weights
  'parallel_hypothesis',      // Track old vs new preference
  'staged_adoption',          // Adopt in stages with confirmation
  'hold',                     // Don't adapt yet, need more data
  'rollback',                 // Roll back to prior model
  'confirm_with_user'         // Explicitly ask user to confirm
]);
export type AdaptationStrategy = z.infer<typeof AdaptationStrategy>;

// =============================================================================
// VTID-01137: Longitudinal Signal Types
// =============================================================================

/**
 * A single longitudinal data point
 */
export const LongitudinalDataPointSchema = z.object({
  id: z.string().uuid(),
  domain: LongitudinalDomain,
  key: z.string().min(1).max(100),
  value: z.unknown(),
  numeric_value: z.number().nullable().optional(),
  recorded_at: z.string().datetime(),
  source: z.enum(['explicit', 'inferred', 'behavioral', 'system']),
  confidence: z.number().min(0).max(100),
  metadata: z.record(z.unknown()).optional()
});
export type LongitudinalDataPoint = z.infer<typeof LongitudinalDataPointSchema>;

/**
 * Trend direction
 */
export const TrendDirection = z.enum([
  'increasing',
  'decreasing',
  'stable',
  'oscillating',
  'unknown'
]);
export type TrendDirection = z.infer<typeof TrendDirection>;

/**
 * Trend analysis for a domain
 */
export const TrendAnalysisSchema = z.object({
  domain: LongitudinalDomain,
  key: z.string(),
  direction: TrendDirection,
  magnitude: z.number().min(0).max(100),  // How strong is the trend
  velocity: z.number(),                    // Rate of change
  data_points_count: z.number().int().min(0),
  time_span_days: z.number(),
  first_observation: z.string().datetime(),
  last_observation: z.string().datetime(),
  confidence: z.number().min(0).max(100),
  baseline_value: z.unknown().nullable(),
  current_value: z.unknown().nullable()
});
export type TrendAnalysis = z.infer<typeof TrendAnalysisSchema>;

/**
 * Complete longitudinal signal bundle
 */
export const LongitudinalSignalBundleSchema = z.object({
  preference_trend: TrendAnalysisSchema.nullable().optional(),
  goal_trend: TrendAnalysisSchema.nullable().optional(),
  engagement_trend: TrendAnalysisSchema.nullable().optional(),
  social_trend: TrendAnalysisSchema.nullable().optional(),
  monetization_trend: TrendAnalysisSchema.nullable().optional(),
  health_trend: TrendAnalysisSchema.nullable().optional(),
  communication_trend: TrendAnalysisSchema.nullable().optional(),
  autonomy_trend: TrendAnalysisSchema.nullable().optional(),
  computed_at: z.string().datetime()
});
export type LongitudinalSignalBundle = z.infer<typeof LongitudinalSignalBundleSchema>;

// =============================================================================
// VTID-01137: Drift Detection Types
// =============================================================================

/**
 * Drift event - detected deviation from prior models
 */
export const DriftEventSchema = z.object({
  id: z.string().uuid(),
  type: DriftType,
  magnitude: z.number().min(0).max(100),    // 0 = no drift, 100 = complete reversal
  confidence: z.number().min(0).max(100),
  domains_affected: z.array(LongitudinalDomain),
  detected_at: z.string().datetime(),

  // Evidence
  evidence_summary: z.string(),
  data_points_analyzed: z.number().int().min(0),
  time_window_days: z.number(),

  // Context
  trigger_hypothesis: z.string().nullable().optional(),  // What might have caused this
  is_seasonal_pattern: z.boolean().default(false),

  // State
  acknowledged_by_user: z.boolean().default(false),
  acknowledged_at: z.string().datetime().nullable().optional(),

  // Audit
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type DriftEvent = z.infer<typeof DriftEventSchema>;

/**
 * Drift detection result
 */
export const DriftDetectionResultSchema = z.object({
  ok: z.boolean(),
  drift_detected: z.boolean(),
  events: z.array(DriftEventSchema).default([]),
  overall_stability: z.number().min(0).max(100),  // 100 = fully stable
  evolution_tags: z.array(EvolutionTag).default([]),
  recommendation: z.string().nullable().optional(),
  error: z.string().optional()
});
export type DriftDetectionResult = z.infer<typeof DriftDetectionResultSchema>;

// =============================================================================
// VTID-01137: Adaptation Types
// =============================================================================

/**
 * Domain-specific adaptation instruction
 */
export const DomainAdaptationSchema = z.object({
  domain: LongitudinalDomain,
  strategy: AdaptationStrategy,
  strength: z.number().min(0).max(100),  // How strongly to adapt
  old_value: z.unknown().nullable(),
  new_value: z.unknown().nullable(),
  confidence: z.number().min(0).max(100),
  requires_confirmation: z.boolean().default(false),
  reason: z.string()
});
export type DomainAdaptation = z.infer<typeof DomainAdaptationSchema>;

/**
 * Complete adaptation plan
 */
export const AdaptationPlanSchema = z.object({
  id: z.string().uuid(),
  domains_to_update: z.array(DomainAdaptationSchema).default([]),
  adaptation_strength: z.number().min(0).max(100),  // Overall adaptation strength
  confirmation_needed: z.boolean().default(false),
  confidence: z.number().min(0).max(100),

  // Triggers
  triggered_by_drift_id: z.string().uuid().nullable().optional(),
  triggered_by: z.enum(['drift_detection', 'user_feedback', 'scheduled', 'manual']),

  // State
  status: z.enum(['proposed', 'pending_confirmation', 'approved', 'applied', 'rejected', 'rolled_back']),
  proposed_at: z.string().datetime(),
  applied_at: z.string().datetime().nullable().optional(),

  // Safety
  can_rollback: z.boolean().default(true),
  rollback_until: z.string().datetime().nullable().optional(),

  // Audit
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type AdaptationPlan = z.infer<typeof AdaptationPlanSchema>;

/**
 * User preference snapshot for rollback
 */
export const PreferenceSnapshotSchema = z.object({
  id: z.string().uuid(),
  snapshot_type: z.enum(['before_adaptation', 'periodic', 'user_requested']),
  domains: z.record(z.unknown()),  // Domain -> preference state
  created_at: z.string().datetime(),
  adaptation_plan_id: z.string().uuid().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional()
});
export type PreferenceSnapshot = z.infer<typeof PreferenceSnapshotSchema>;

// =============================================================================
// VTID-01137: API Request/Response Types
// =============================================================================

/**
 * Record longitudinal data point request
 */
export const RecordDataPointRequestSchema = z.object({
  domain: LongitudinalDomain,
  key: z.string().min(1).max(100),
  value: z.unknown(),
  numeric_value: z.number().nullable().optional(),
  source: z.enum(['explicit', 'inferred', 'behavioral', 'system']).default('behavioral'),
  confidence: z.number().min(0).max(100).default(70),
  metadata: z.record(z.unknown()).optional()
});
export type RecordDataPointRequest = z.infer<typeof RecordDataPointRequestSchema>;

/**
 * Record data point response
 */
export interface RecordDataPointResponse {
  ok: boolean;
  data_point_id?: string;
  domain?: LongitudinalDomain;
  key?: string;
  error?: string;
}

/**
 * Get trends request
 */
export const GetTrendsRequestSchema = z.object({
  domains: z.array(LongitudinalDomain).optional(),
  time_window_days: z.number().int().min(1).max(365).default(30),
  min_data_points: z.number().int().min(2).max(100).default(5)
});
export type GetTrendsRequest = z.infer<typeof GetTrendsRequestSchema>;

/**
 * Get trends response
 */
export interface GetTrendsResponse {
  ok: boolean;
  signals?: LongitudinalSignalBundle;
  data_points_count?: number;
  time_span_days?: number;
  error?: string;
}

/**
 * Detect drift request
 */
export const DetectDriftRequestSchema = z.object({
  domains: z.array(LongitudinalDomain).optional(),
  sensitivity: z.enum(['low', 'medium', 'high']).default('medium'),
  time_window_days: z.number().int().min(7).max(365).default(30)
});
export type DetectDriftRequest = z.infer<typeof DetectDriftRequestSchema>;

/**
 * Get adaptation plan request
 */
export const GetAdaptationPlanRequestSchema = z.object({
  include_applied: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10)
});
export type GetAdaptationPlanRequest = z.infer<typeof GetAdaptationPlanRequestSchema>;

/**
 * Get adaptation plans response
 */
export interface GetAdaptationPlansResponse {
  ok: boolean;
  plans?: AdaptationPlan[];
  count?: number;
  error?: string;
}

/**
 * Approve adaptation request
 */
export const ApproveAdaptationRequestSchema = z.object({
  plan_id: z.string().uuid(),
  confirm: z.boolean()
});
export type ApproveAdaptationRequest = z.infer<typeof ApproveAdaptationRequestSchema>;

/**
 * Approve adaptation response
 */
export interface ApproveAdaptationResponse {
  ok: boolean;
  plan_id?: string;
  status?: 'approved' | 'rejected';
  applied_at?: string;
  error?: string;
}

/**
 * Rollback adaptation request
 */
export const RollbackAdaptationRequestSchema = z.object({
  plan_id: z.string().uuid(),
  reason: z.string().optional()
});
export type RollbackAdaptationRequest = z.infer<typeof RollbackAdaptationRequestSchema>;

/**
 * Rollback response
 */
export interface RollbackAdaptationResponse {
  ok: boolean;
  plan_id?: string;
  rolled_back_at?: string;
  snapshot_restored?: string;
  error?: string;
}

/**
 * Get evolution state response
 */
export interface GetEvolutionStateResponse {
  ok: boolean;
  evolution_tags?: EvolutionTag[];
  overall_stability?: number;
  active_drift_events?: DriftEvent[];
  pending_adaptations?: AdaptationPlan[];
  last_major_change?: string;
  error?: string;
}

/**
 * Acknowledge drift request
 */
export const AcknowledgeDriftRequestSchema = z.object({
  drift_id: z.string().uuid(),
  response: z.enum(['confirm_change', 'temporary', 'not_me_anymore', 'ignore'])
});
export type AcknowledgeDriftRequest = z.infer<typeof AcknowledgeDriftRequestSchema>;

/**
 * Acknowledge drift response
 */
export interface AcknowledgeDriftResponse {
  ok: boolean;
  drift_id?: string;
  response_recorded?: string;
  adaptation_triggered?: boolean;
  error?: string;
}

// =============================================================================
// VTID-01137: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for longitudinal adaptation
 */
export const LONGITUDINAL_EVENT_TYPES = [
  'd43.data_point.recorded',
  'd43.trend.computed',
  'd43.drift.detected',
  'd43.drift.acknowledged',
  'd43.adaptation.proposed',
  'd43.adaptation.approved',
  'd43.adaptation.applied',
  'd43.adaptation.rejected',
  'd43.adaptation.rolled_back',
  'd43.snapshot.created'
] as const;

export type LongitudinalEventType = typeof LONGITUDINAL_EVENT_TYPES[number];

/**
 * OASIS event payload for longitudinal adaptation
 */
export interface LongitudinalEventPayload {
  vtid: string;
  tenant_id?: string;
  user_id?: string;
  event_type: LongitudinalEventType;
  domain?: LongitudinalDomain;
  drift_type?: DriftType;
  adaptation_strategy?: AdaptationStrategy;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01137: Configuration & Thresholds
// =============================================================================

/**
 * Drift detection thresholds
 */
export const DRIFT_THRESHOLDS = {
  // Minimum confidence to consider a drift event valid
  MIN_CONFIDENCE: 60,

  // Minimum magnitude to trigger adaptation
  MIN_MAGNITUDE_FOR_ADAPTATION: 30,

  // Time windows for different drift types
  GRADUAL_DRIFT_MIN_DAYS: 14,
  ABRUPT_DRIFT_MAX_DAYS: 3,
  SEASONAL_CYCLE_DAYS: 7,

  // Data requirements
  MIN_DATA_POINTS_FOR_TREND: 5,
  MIN_DATA_POINTS_FOR_DRIFT: 10,

  // Adaptation thresholds
  AUTO_ADAPT_CONFIDENCE: 85,       // Above this, adapt without confirmation
  CONFIRMATION_REQUIRED_ABOVE: 50, // Below auto-adapt but above this, ask user

  // Rollback window (days)
  ROLLBACK_WINDOW_DAYS: 30
} as const;

/**
 * Sensitivity presets for drift detection
 */
export const SENSITIVITY_PRESETS: Record<'low' | 'medium' | 'high', {
  magnitude_threshold: number;
  confidence_threshold: number;
  min_data_points: number;
}> = {
  low: {
    magnitude_threshold: 50,
    confidence_threshold: 80,
    min_data_points: 15
  },
  medium: {
    magnitude_threshold: 30,
    confidence_threshold: 60,
    min_data_points: 10
  },
  high: {
    magnitude_threshold: 15,
    confidence_threshold: 40,
    min_data_points: 5
  }
};

/**
 * Domain metadata for display
 */
export const LONGITUDINAL_DOMAIN_METADATA: Record<LongitudinalDomain, {
  label: string;
  description: string;
  icon: string;
}> = {
  preference: {
    label: 'Preferences',
    description: 'General preference changes over time',
    icon: 'sliders'
  },
  goal: {
    label: 'Goals',
    description: 'Goal shifts and life direction changes',
    icon: 'target'
  },
  engagement: {
    label: 'Engagement',
    description: 'How actively you interact with the system',
    icon: 'activity'
  },
  social: {
    label: 'Social',
    description: 'Social behavior and connection patterns',
    icon: 'users'
  },
  monetization: {
    label: 'Economic',
    description: 'Spending and earning comfort levels',
    icon: 'dollar-sign'
  },
  health: {
    label: 'Health',
    description: 'Health and energy trend patterns',
    icon: 'heart'
  },
  communication: {
    label: 'Communication',
    description: 'Communication style preferences',
    icon: 'message-circle'
  },
  autonomy: {
    label: 'Autonomy',
    description: 'Comfort with system autonomy',
    icon: 'zap'
  }
};

/**
 * Evolution tag metadata for display
 */
export const EVOLUTION_TAG_METADATA: Record<EvolutionTag, {
  label: string;
  description: string;
  severity: 'info' | 'notice' | 'warning';
}> = {
  stable_preferences: {
    label: 'Stable',
    description: 'Your preferences are consistent and stable',
    severity: 'info'
  },
  drift_detected: {
    label: 'Change Detected',
    description: 'We noticed some changes in your patterns',
    severity: 'notice'
  },
  exploration_phase: {
    label: 'Exploring',
    description: 'You seem to be trying new things',
    severity: 'info'
  },
  major_shift_candidate: {
    label: 'Major Change',
    description: 'Significant change in preferences detected',
    severity: 'warning'
  },
  seasonal_pattern: {
    label: 'Seasonal',
    description: 'This appears to be a cyclical pattern',
    severity: 'info'
  },
  regression_detected: {
    label: 'Returning',
    description: 'You seem to be returning to previous patterns',
    severity: 'notice'
  }
};
