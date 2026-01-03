/**
 * VTID-01145: D51 Predictive Fatigue, Burnout & Overload Detection Engine
 *
 * Type definitions for the Overload Detection system that detects early patterns
 * of fatigue, cognitive overload, emotional strain, or burnout risk BEFORE they
 * escalate, and surfaces them as gentle awareness signals.
 *
 * This engine answers: "Is the system observing early signs of overload — and why?"
 *
 * Hard Constraints (from spec):
 *   - Memory-first: All outputs logged to OASIS
 *   - Safety-first: No medical or psychological diagnosis
 *   - Detection ≠ labeling: No diagnostic terms unless user-originated
 *   - No urgency or alarm framing
 *   - Explainability mandatory
 *   - No schema-breaking changes
 *
 * Detection Rules:
 *   - Pattern persists ≥ 7 days OR ≥ 3 repeated spikes
 *   - ≥ 2 independent signal sources
 *   - Confidence ≥ 75%
 *   - Clear deviation from user's personal baseline
 *
 * What This Engine Must NOT Do:
 *   - ❌ No alerts
 *   - ❌ No escalation
 *   - ❌ No recommendations (handled by D49/D46)
 *   - ❌ No labeling of identity or condition
 */

import { z } from 'zod';

// =============================================================================
// VTID-01145: Overload Dimension Types
// =============================================================================

/**
 * Overload dimensions - each detection belongs to exactly ONE primary dimension
 */
export const OverloadDimension = z.enum([
  'physical',     // Physical fatigue patterns
  'cognitive',    // Cognitive overload patterns
  'emotional',    // Emotional strain patterns
  'routine',      // Routine saturation patterns
  'social',       // Social exhaustion patterns
  'context'       // Context switching load patterns
]);
export type OverloadDimension = z.infer<typeof OverloadDimension>;

/**
 * Potential impact levels
 */
export const PotentialImpact = z.enum([
  'low',      // Minor impact on wellbeing
  'medium',   // Moderate impact requiring awareness
  'high'      // Significant impact warranting attention
]);
export type PotentialImpact = z.infer<typeof PotentialImpact>;

/**
 * Time window for detection
 */
export const TimeWindow = z.enum([
  'last_7_days',
  'last_14_days',
  'last_21_days'
]);
export type TimeWindow = z.infer<typeof TimeWindow>;

/**
 * Signal source types that can contribute to detection
 */
export const OverloadSignalSource = z.enum([
  'longitudinal_trends',     // D43 longitudinal data
  'risk_windows',            // D45 risk window data
  'behavioral_signals',      // D44 behavioral/cognitive signals
  'sleep_recovery',          // Sleep & recovery data (optional)
  'calendar_density',        // Calendar fragmentation (optional)
  'conversation_cadence',    // Conversation tone shifts (optional)
  'social_load',             // Social interaction load (optional)
  'diary_sentiment'          // Self-reported diary sentiment (optional)
]);
export type OverloadSignalSource = z.infer<typeof OverloadSignalSource>;

// =============================================================================
// VTID-01145: Pattern Types
// =============================================================================

/**
 * Pattern types that can be observed
 */
export const PatternType = z.enum([
  'sustained_low_energy',         // Persistent low energy over time
  'cognitive_decline',            // Declining cognitive capacity
  'emotional_volatility',         // Increased emotional instability
  'routine_rigidity',             // Over-reliance on routine, fear of change
  'social_withdrawal',            // Reduced social engagement
  'context_thrashing',            // Excessive context switching
  'recovery_deficit',             // Insufficient recovery periods
  'capacity_erosion',             // Gradual capacity reduction
  'engagement_drop',              // Declining engagement levels
  'stress_accumulation'           // Stress building without release
]);
export type PatternType = z.infer<typeof PatternType>;

/**
 * Observed pattern reference
 */
export const ObservedPatternSchema = z.object({
  pattern_type: PatternType,
  signal_sources: z.array(OverloadSignalSource).min(1),
  first_observed_at: z.string().datetime(),
  observation_count: z.number().int().min(1),
  intensity: z.number().min(0).max(100),
  trend_direction: z.enum(['worsening', 'stable', 'improving']),
  supporting_evidence: z.string()
});
export type ObservedPattern = z.infer<typeof ObservedPatternSchema>;

// =============================================================================
// VTID-01145: Baseline Types
// =============================================================================

/**
 * User baseline snapshot for comparison
 */
export const UserBaselineSchema = z.object({
  dimension: OverloadDimension,
  baseline_score: z.number().min(0).max(100),
  baseline_computed_at: z.string().datetime(),
  data_points_count: z.number().int().min(0),
  standard_deviation: z.number().min(0),
  is_stable: z.boolean()
});
export type UserBaseline = z.infer<typeof UserBaselineSchema>;

/**
 * Deviation from baseline
 */
export const BaselineDeviationSchema = z.object({
  dimension: OverloadDimension,
  baseline_score: z.number().min(0).max(100),
  current_score: z.number().min(0).max(100),
  deviation_magnitude: z.number(),  // Can be negative
  deviation_percentage: z.number(),
  is_significant: z.boolean(),
  significance_threshold: z.number()
});
export type BaselineDeviation = z.infer<typeof BaselineDeviationSchema>;

// =============================================================================
// VTID-01145: Detection Types
// =============================================================================

/**
 * Overload detection - the primary output of D51
 *
 * Strict output structure as per spec:
 * {
 *   "overload_id": "uuid",
 *   "dimension": "physical|cognitive|emotional|routine|social|context",
 *   "confidence": 0-100,
 *   "time_window": "last_7_to_21_days",
 *   "observed_patterns": ["pattern_ref_1", "pattern_ref_2"],
 *   "potential_impact": "low|medium|high",
 *   "explainability_text": "plain language explanation",
 *   "dismissible": true
 * }
 */
export const OverloadDetectionSchema = z.object({
  // Core identification
  overload_id: z.string().uuid(),

  // Primary dimension (exactly one)
  dimension: OverloadDimension,

  // Confidence score (must be ≥ 75% to emit)
  confidence: z.number().min(0).max(100),

  // Time window of detection
  time_window: TimeWindow,

  // Referenced patterns (at least 2 required)
  observed_patterns: z.array(z.string()).min(2),

  // Impact assessment
  potential_impact: PotentialImpact,

  // Plain language explanation (observational, non-diagnostic)
  explainability_text: z.string().min(1),

  // Always true - user can always dismiss
  dismissible: z.literal(true),

  // Additional metadata
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),

  // Dismissal tracking
  dismissed_at: z.string().datetime().nullable().optional(),
  dismissed_reason: z.string().nullable().optional()
});
export type OverloadDetection = z.infer<typeof OverloadDetectionSchema>;

/**
 * Full detection record with patterns and baseline
 */
export const OverloadDetectionRecordSchema = OverloadDetectionSchema.extend({
  // Full pattern details
  pattern_details: z.array(ObservedPatternSchema).optional(),

  // Baseline deviation info
  baseline_deviation: BaselineDeviationSchema.optional(),

  // Tenant/user context
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid()
});
export type OverloadDetectionRecord = z.infer<typeof OverloadDetectionRecordSchema>;

// =============================================================================
// VTID-01145: Detection Result Types
// =============================================================================

/**
 * Result of detection analysis
 */
export const DetectionResultSchema = z.object({
  ok: z.boolean(),

  // Did we detect overload patterns?
  detection_found: z.boolean(),

  // The detection (if found and meets all criteria)
  detection: OverloadDetectionSchema.nullable().optional(),

  // Patterns observed (even if not meeting threshold)
  patterns_observed: z.array(ObservedPatternSchema).default([]),

  // Baseline info
  baseline_snapshot: z.array(UserBaselineSchema).default([]),

  // Why detection was/wasn't emitted
  decision_rationale: z.string(),

  // Error info
  error: z.string().optional()
});
export type DetectionResult = z.infer<typeof DetectionResultSchema>;

// =============================================================================
// VTID-01145: API Request/Response Types
// =============================================================================

/**
 * Compute detection request
 */
export const ComputeDetectionRequestSchema = z.object({
  // Optional: focus on specific dimensions
  dimensions: z.array(OverloadDimension).optional(),

  // Time window for analysis
  time_window_days: z.number().int().min(7).max(21).default(14),

  // Include dismissed detections in response
  include_dismissed: z.boolean().default(false)
});
export type ComputeDetectionRequest = z.infer<typeof ComputeDetectionRequestSchema>;

/**
 * Compute detection response
 */
export interface ComputeDetectionResponse {
  ok: boolean;
  error?: string;
  message?: string;
  detections?: OverloadDetection[];
  patterns_observed?: ObservedPattern[];
  baseline_snapshot?: UserBaseline[];
}

/**
 * Get current detections request
 */
export const GetDetectionsRequestSchema = z.object({
  include_dismissed: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10)
});
export type GetDetectionsRequest = z.infer<typeof GetDetectionsRequestSchema>;

/**
 * Get detections response
 */
export interface GetDetectionsResponse {
  ok: boolean;
  error?: string;
  message?: string;
  detections?: OverloadDetection[];
  count?: number;
}

/**
 * Dismiss detection request
 */
export const DismissDetectionRequestSchema = z.object({
  overload_id: z.string().uuid(),
  reason: z.string().optional()
});
export type DismissDetectionRequest = z.infer<typeof DismissDetectionRequestSchema>;

/**
 * Dismiss detection response
 */
export interface DismissDetectionResponse {
  ok: boolean;
  error?: string;
  message?: string;
  overload_id?: string;
  dismissed_at?: string;
}

/**
 * Get baseline request
 */
export const GetBaselineRequestSchema = z.object({
  dimensions: z.array(OverloadDimension).optional(),
  recompute: z.boolean().default(false)
});
export type GetBaselineRequest = z.infer<typeof GetBaselineRequestSchema>;

/**
 * Get baseline response
 */
export interface GetBaselineResponse {
  ok: boolean;
  error?: string;
  message?: string;
  baselines?: UserBaseline[];
  computed_at?: string;
}

/**
 * Explain detection request
 */
export const ExplainDetectionRequestSchema = z.object({
  overload_id: z.string().uuid()
});
export type ExplainDetectionRequest = z.infer<typeof ExplainDetectionRequestSchema>;

/**
 * Explain detection response
 */
export interface ExplainDetectionResponse {
  ok: boolean;
  error?: string;
  detection?: OverloadDetection;
  patterns?: ObservedPattern[];
  baseline_deviation?: BaselineDeviation;
  signal_sources?: OverloadSignalSource[];
  rules_applied?: string[];
  explainability_text?: string;
}

// =============================================================================
// VTID-01145: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for overload detection
 */
export const OVERLOAD_EVENT_TYPES = [
  'overload.detected',
  'overload.detection.computed',
  'overload.detection.failed',
  'overload.dismissed',
  'overload.baseline.computed',
  'overload.pattern.observed'
] as const;

export type OverloadEventType = typeof OVERLOAD_EVENT_TYPES[number];

/**
 * OASIS event payload for overload detection
 */
export interface OverloadEventPayload {
  vtid: string;
  tenant_id?: string;
  user_id?: string;
  overload_id?: string;
  dimension?: OverloadDimension;
  confidence?: number;
  time_window?: TimeWindow;
  potential_impact?: PotentialImpact;
  pattern_count?: number;
  signal_sources?: OverloadSignalSource[];
  duration_ms?: number;
  error?: string;
}

// =============================================================================
// VTID-01145: Detection Rules & Thresholds
// =============================================================================

/**
 * Detection thresholds (from spec)
 */
export const DETECTION_THRESHOLDS = {
  // Pattern must persist for at least this many days
  MIN_PERSISTENCE_DAYS: 7,

  // OR pattern must have at least this many spikes
  MIN_SPIKE_COUNT: 3,

  // Must have at least this many independent signal sources
  MIN_SIGNAL_SOURCES: 2,

  // Confidence must be at least this percentage
  MIN_CONFIDENCE: 75,

  // Deviation from baseline must be at least this percentage
  MIN_BASELINE_DEVIATION: 20,

  // Time windows for analysis
  DEFAULT_TIME_WINDOW_DAYS: 14,
  MIN_TIME_WINDOW_DAYS: 7,
  MAX_TIME_WINDOW_DAYS: 21,

  // Data requirements
  MIN_DATA_POINTS_FOR_BASELINE: 14,
  MIN_DATA_POINTS_FOR_DETECTION: 7
} as const;

/**
 * Impact thresholds
 */
export const IMPACT_THRESHOLDS = {
  // Low impact: deviation 20-40%
  LOW_DEVIATION_MIN: 20,
  LOW_DEVIATION_MAX: 40,

  // Medium impact: deviation 40-60%
  MEDIUM_DEVIATION_MIN: 40,
  MEDIUM_DEVIATION_MAX: 60,

  // High impact: deviation > 60%
  HIGH_DEVIATION_MIN: 60
} as const;

// =============================================================================
// VTID-01145: Explainability Templates
// =============================================================================

/**
 * Explainability text templates
 * Uses observational language: "the system notices..."
 * Emphasizes reversibility and normalcy
 */
export const EXPLAINABILITY_TEMPLATES: Record<OverloadDimension, {
  observation: string;
  context: string;
  reassurance: string;
}> = {
  physical: {
    observation: 'The system notices patterns that may suggest physical tiredness has been present over the past few weeks.',
    context: 'This observation is based on energy-related signals and activity patterns.',
    reassurance: 'This is a normal fluctuation that many people experience. It may naturally improve with rest.'
  },
  cognitive: {
    observation: 'The system notices patterns that may suggest increased mental load over recent days.',
    context: 'This observation is based on focus-related signals and task completion patterns.',
    reassurance: 'Periods of higher cognitive demand are common. Lighter tasks may feel more comfortable for now.'
  },
  emotional: {
    observation: 'The system notices patterns that may suggest emotional capacity has been stretched recently.',
    context: 'This observation is based on interaction patterns and emotional signal indicators.',
    reassurance: 'Emotional ebbs and flows are part of life. This observation is temporary and dismissible.'
  },
  routine: {
    observation: 'The system notices patterns suggesting routines may be feeling more demanding than usual.',
    context: 'This observation is based on schedule density and routine completion patterns.',
    reassurance: 'Routine fatigue is common and often resolves with small adjustments.'
  },
  social: {
    observation: 'The system notices patterns that may suggest social energy has been more depleted recently.',
    context: 'This observation is based on social interaction patterns and engagement signals.',
    reassurance: 'Social energy naturally fluctuates. Quiet time often helps restore balance.'
  },
  context: {
    observation: 'The system notices patterns suggesting frequent context switching may be present.',
    context: 'This observation is based on task transition patterns and focus disruption signals.',
    reassurance: 'Context switching load is common in busy periods and tends to normalize.'
  }
};

/**
 * Build explainability text for a detection
 */
export function buildExplainabilityText(
  dimension: OverloadDimension,
  patterns: ObservedPattern[],
  deviation?: BaselineDeviation
): string {
  const template = EXPLAINABILITY_TEMPLATES[dimension];
  const lines: string[] = [];

  // Main observation
  lines.push(template.observation);

  // Context about what signals contributed
  if (patterns.length > 0) {
    const sources = [...new Set(patterns.flatMap(p => p.signal_sources))];
    lines.push(`${template.context} (${sources.length} signal source${sources.length > 1 ? 's' : ''}).`);
  } else {
    lines.push(template.context);
  }

  // Deviation context if available
  if (deviation && deviation.is_significant) {
    lines.push(`This represents about ${Math.abs(Math.round(deviation.deviation_percentage))}% difference from your typical patterns.`);
  }

  // Reassurance
  lines.push(template.reassurance);

  return lines.join(' ');
}

// =============================================================================
// VTID-01145: Dimension Metadata
// =============================================================================

/**
 * Dimension metadata for display and processing
 */
export const DIMENSION_METADATA: Record<OverloadDimension, {
  label: string;
  description: string;
  icon: string;
  related_signals: OverloadSignalSource[];
  pattern_types: PatternType[];
}> = {
  physical: {
    label: 'Physical Fatigue',
    description: 'Patterns suggesting physical tiredness or energy depletion',
    icon: 'battery-low',
    related_signals: ['longitudinal_trends', 'sleep_recovery', 'behavioral_signals'],
    pattern_types: ['sustained_low_energy', 'recovery_deficit', 'capacity_erosion']
  },
  cognitive: {
    label: 'Cognitive Overload',
    description: 'Patterns suggesting mental load or processing strain',
    icon: 'brain',
    related_signals: ['behavioral_signals', 'longitudinal_trends', 'conversation_cadence'],
    pattern_types: ['cognitive_decline', 'engagement_drop', 'context_thrashing']
  },
  emotional: {
    label: 'Emotional Strain',
    description: 'Patterns suggesting emotional capacity depletion',
    icon: 'heart',
    related_signals: ['behavioral_signals', 'diary_sentiment', 'conversation_cadence'],
    pattern_types: ['emotional_volatility', 'stress_accumulation', 'capacity_erosion']
  },
  routine: {
    label: 'Routine Saturation',
    description: 'Patterns suggesting routine demands exceeding capacity',
    icon: 'calendar',
    related_signals: ['calendar_density', 'longitudinal_trends', 'behavioral_signals'],
    pattern_types: ['routine_rigidity', 'capacity_erosion', 'stress_accumulation']
  },
  social: {
    label: 'Social Exhaustion',
    description: 'Patterns suggesting social energy depletion',
    icon: 'users',
    related_signals: ['social_load', 'behavioral_signals', 'longitudinal_trends'],
    pattern_types: ['social_withdrawal', 'recovery_deficit', 'capacity_erosion']
  },
  context: {
    label: 'Context Switching Load',
    description: 'Patterns suggesting excessive task/context transitions',
    icon: 'shuffle',
    related_signals: ['calendar_density', 'behavioral_signals', 'risk_windows'],
    pattern_types: ['context_thrashing', 'cognitive_decline', 'engagement_drop']
  }
};

// =============================================================================
// VTID-01145: Database Record Types
// =============================================================================

/**
 * Overload detection record from database
 */
export interface OverloadDetectionDbRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  dimension: OverloadDimension;
  confidence: number;
  time_window: TimeWindow;
  observed_patterns: string[];
  pattern_details: ObservedPattern[];
  baseline_deviation: BaselineDeviation | null;
  potential_impact: PotentialImpact;
  explainability_text: string;
  dismissible: boolean;
  dismissed_at: string | null;
  dismissed_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * User baseline record from database
 */
export interface UserBaselineDbRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  dimension: OverloadDimension;
  baseline_score: number;
  data_points_count: number;
  standard_deviation: number;
  is_stable: boolean;
  computed_at: string;
  expires_at: string;
}

// =============================================================================
// VTID-01145: Safety Constants
// =============================================================================

/**
 * Non-diagnostic disclaimer (always present)
 */
export const OVERLOAD_DISCLAIMER =
  'These observations are pattern-based awareness signals, not medical or psychological assessments. ' +
  'They reflect system observations that may be dismissed at any time. ' +
  'For health concerns, please consult appropriate professionals.';

/**
 * Forbidden terms (must never appear in outputs)
 */
export const FORBIDDEN_DIAGNOSTIC_TERMS = [
  'burnout',
  'depression',
  'anxiety disorder',
  'clinical',
  'diagnosis',
  'mental illness',
  'mental health condition',
  'psychiatric',
  'psychological disorder',
  'syndrome'
] as const;

/**
 * Check if text contains forbidden terms
 */
export function containsForbiddenTerms(text: string): boolean {
  const lowerText = text.toLowerCase();
  return FORBIDDEN_DIAGNOSTIC_TERMS.some(term => lowerText.includes(term));
}

/**
 * Sanitize text to remove any forbidden terms
 */
export function sanitizeExplainabilityText(text: string): string {
  let sanitized = text;
  for (const term of FORBIDDEN_DIAGNOSTIC_TERMS) {
    const regex = new RegExp(term, 'gi');
    sanitized = sanitized.replace(regex, 'pattern');
  }
  return sanitized;
}
