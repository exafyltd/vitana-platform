/**
 * VTID-01138: D44 Proactive Signal Detection & Early Intervention Engine
 *
 * Type definitions for the Signal Detection system that proactively identifies
 * early weak signals indicating potential future risk or opportunity across
 * health, behavior, routines, social patterns, and preferences.
 *
 * Core Philosophy:
 *   - Detect early weak signals BEFORE problems occur
 *   - Surface insights as recommendations only (no autonomous actions)
 *   - Every signal must be explainable in plain language
 *   - Rare but meaningful signals (no spam)
 *   - Full traceability via OASIS events
 *
 * Hard Constraints:
 *   - No medical diagnosis
 *   - No automatic actions
 *   - No alerts spam
 *   - No nudging without explanation
 *   - No irreversible decisions
 *
 * Detection Rules:
 *   - Persistent: ≥3 occurrences or ≥7 days
 *   - Directional: trend, not noise
 *   - Confidence: ≥70%
 *   - Evidence: ≥2 independent sources
 */

import { z } from 'zod';

// =============================================================================
// VTID-01138: Signal Types
// =============================================================================

/**
 * Signal type classes - each signal belongs to exactly one class
 */
export const SignalType = z.enum([
  'health_drift',           // Health metrics trending in concerning direction
  'behavioral_drift',       // Behavior patterns changing significantly
  'routine_instability',    // Regular routines becoming unstable
  'cognitive_load_increase', // Signs of mental overload or stress
  'social_withdrawal',      // Decreasing social interactions
  'social_overload',        // Too many social demands
  'preference_shift',       // Core preferences changing
  'positive_momentum'       // Positive trends worth reinforcing
]);
export type SignalType = z.infer<typeof SignalType>;

/**
 * User impact levels
 */
export const UserImpact = z.enum([
  'low',      // Informational, worth knowing
  'medium',   // Worth attention, suggest reflection
  'high'      // Requires attention, suggest check-in
]);
export type UserImpact = z.infer<typeof UserImpact>;

/**
 * Suggested action types
 */
export const SuggestedAction = z.enum([
  'awareness',   // Simply be aware of this signal
  'reflection',  // Consider what this means for you
  'check_in'     // Actively check in on this area
]);
export type SuggestedAction = z.infer<typeof SuggestedAction>;

/**
 * Signal status
 */
export const SignalStatus = z.enum([
  'active',       // Signal is active and should be shown
  'acknowledged', // User has seen and acknowledged
  'dismissed',    // User dismissed as not relevant
  'actioned',     // User took action on this signal
  'expired'       // Signal has expired (time window passed)
]);
export type SignalStatus = z.infer<typeof SignalStatus>;

/**
 * Time windows for signal detection
 */
export const TimeWindow = z.enum([
  'last_7_days',
  'last_14_days',
  'last_30_days'
]);
export type TimeWindow = z.infer<typeof TimeWindow>;

/**
 * Evidence types
 */
export const EvidenceType = z.enum([
  'memory',      // Memory garden nodes
  'health',      // Health features, vitana scores
  'context',     // Context snapshots
  'diary',       // Diary entries
  'calendar',    // Calendar density
  'social',      // Social interaction patterns
  'location',    // Location patterns
  'wearable',    // Wearable data trends
  'preference',  // Preference changes
  'behavior'     // Behavioral observations
]);
export type EvidenceType = z.infer<typeof EvidenceType>;

/**
 * Detection source
 */
export const DetectionSource = z.enum([
  'engine',     // Automatic detection by D44 engine
  'manual',     // Manually created signal
  'scheduled'   // Scheduled detection run
]);
export type DetectionSource = z.infer<typeof DetectionSource>;

/**
 * Intervention action types
 */
export const InterventionActionType = z.enum([
  'acknowledged',
  'dismissed',
  'marked_helpful',
  'marked_not_helpful',
  'took_action',
  'reminder_set',
  'shared'
]);
export type InterventionActionType = z.infer<typeof InterventionActionType>;

// =============================================================================
// VTID-01138: Core Data Structures
// =============================================================================

/**
 * Evidence reference - links a signal to its supporting data
 */
export const SignalEvidenceSchema = z.object({
  id: z.string().uuid(),
  signal_id: z.string().uuid(),
  evidence_type: EvidenceType,
  source_ref: z.string(),     // Reference ID to source data
  source_table: z.string(),   // Table name for traceability
  weight: z.number().min(0).max(100).default(50),  // Contribution weight
  summary: z.string(),        // Brief description
  recorded_at: z.string().datetime(),
  created_at: z.string().datetime()
});
export type SignalEvidence = z.infer<typeof SignalEvidenceSchema>;

/**
 * Predictive signal - the core output of the detection engine
 */
export const PredictiveSignalSchema = z.object({
  id: z.string().uuid(),
  signal_type: SignalType,
  confidence: z.number().min(0).max(100),
  time_window: TimeWindow,
  detected_change: z.string(),       // Plain language description
  user_impact: UserImpact,
  suggested_action: SuggestedAction,
  explainability_text: z.string(),   // Plain language explanation

  // Evidence
  evidence_count: z.number().int().min(0),
  evidence: z.array(SignalEvidenceSchema).optional(),

  // Detection metadata
  detection_source: DetectionSource,
  domains_analyzed: z.array(z.string()),
  data_points_analyzed: z.number().int().min(0),

  // State
  status: SignalStatus,
  acknowledged_at: z.string().datetime().nullable().optional(),
  actioned_at: z.string().datetime().nullable().optional(),
  user_feedback: z.string().nullable().optional(),

  // Linking
  linked_drift_event_id: z.string().uuid().nullable().optional(),
  linked_memory_refs: z.array(z.string()).default([]),
  linked_health_refs: z.array(z.string()).default([]),
  linked_context_refs: z.array(z.string()).default([]),

  // Audit
  detected_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});
export type PredictiveSignal = z.infer<typeof PredictiveSignalSchema>;

/**
 * Intervention history record
 */
export const InterventionHistorySchema = z.object({
  id: z.string().uuid(),
  signal_id: z.string().uuid(),
  action_type: InterventionActionType,
  action_details: z.record(z.unknown()).default({}),
  created_at: z.string().datetime()
});
export type InterventionHistory = z.infer<typeof InterventionHistorySchema>;

// =============================================================================
// VTID-01138: Detection Rule Types
// =============================================================================

/**
 * Detection rule thresholds
 */
export const DETECTION_THRESHOLDS = {
  // Minimum confidence to emit a signal
  MIN_CONFIDENCE: 70,

  // Persistence requirements
  MIN_OCCURRENCES: 3,
  MIN_DAYS: 7,

  // Evidence requirements
  MIN_EVIDENCE_SOURCES: 2,

  // Time windows
  DEFAULT_TIME_WINDOW_DAYS: 14,
  MAX_TIME_WINDOW_DAYS: 30,

  // Rate limiting (prevent spam)
  MAX_SIGNALS_PER_TYPE_PER_WEEK: 1,
  MAX_ACTIVE_SIGNALS_TOTAL: 5,

  // Expiration
  DEFAULT_EXPIRATION_DAYS: 14
} as const;

/**
 * Signal class rules
 */
export interface SignalClassRule {
  type: SignalType;
  domains: string[];           // Which domains to analyze
  min_data_points: number;     // Minimum data points required
  direction_required: boolean; // Must have clear direction
  baseline_required: boolean;  // Needs comparison to baseline
  health_sensitive: boolean;   // Requires health data access
}

/**
 * Detection rules by signal class
 */
export const SIGNAL_CLASS_RULES: Record<SignalType, SignalClassRule> = {
  health_drift: {
    type: 'health_drift',
    domains: ['health'],
    min_data_points: 5,
    direction_required: true,
    baseline_required: true,
    health_sensitive: true
  },
  behavioral_drift: {
    type: 'behavioral_drift',
    domains: ['engagement', 'preference', 'communication'],
    min_data_points: 5,
    direction_required: true,
    baseline_required: true,
    health_sensitive: false
  },
  routine_instability: {
    type: 'routine_instability',
    domains: ['engagement', 'health', 'social'],
    min_data_points: 7,
    direction_required: false,
    baseline_required: true,
    health_sensitive: false
  },
  cognitive_load_increase: {
    type: 'cognitive_load_increase',
    domains: ['engagement', 'health', 'communication'],
    min_data_points: 5,
    direction_required: true,
    baseline_required: true,
    health_sensitive: true
  },
  social_withdrawal: {
    type: 'social_withdrawal',
    domains: ['social'],
    min_data_points: 5,
    direction_required: true,
    baseline_required: true,
    health_sensitive: false
  },
  social_overload: {
    type: 'social_overload',
    domains: ['social'],
    min_data_points: 5,
    direction_required: true,
    baseline_required: true,
    health_sensitive: false
  },
  preference_shift: {
    type: 'preference_shift',
    domains: ['preference', 'goal'],
    min_data_points: 3,
    direction_required: true,
    baseline_required: true,
    health_sensitive: false
  },
  positive_momentum: {
    type: 'positive_momentum',
    domains: ['health', 'engagement', 'social', 'goal'],
    min_data_points: 5,
    direction_required: true,
    baseline_required: true,
    health_sensitive: false
  }
};

// =============================================================================
// VTID-01138: API Request/Response Types
// =============================================================================

/**
 * Create signal request
 */
export const CreateSignalRequestSchema = z.object({
  signal_type: SignalType,
  confidence: z.number().min(0).max(100).default(70),
  time_window: TimeWindow.default('last_14_days'),
  detected_change: z.string().min(1).max(500),
  user_impact: UserImpact.default('medium'),
  suggested_action: SuggestedAction.default('awareness'),
  explainability_text: z.string().min(1).max(1000),
  evidence_count: z.number().int().min(0).default(0),
  detection_source: DetectionSource.default('engine'),
  domains_analyzed: z.array(z.string()).default([]),
  data_points_analyzed: z.number().int().min(0).default(0),
  linked_drift_event_id: z.string().uuid().optional(),
  linked_memory_refs: z.array(z.string()).default([]),
  linked_health_refs: z.array(z.string()).default([]),
  linked_context_refs: z.array(z.string()).default([])
});
export type CreateSignalRequest = z.infer<typeof CreateSignalRequestSchema>;

/**
 * Create signal response
 */
export interface CreateSignalResponse {
  ok: boolean;
  signal_id?: string;
  signal_type?: SignalType;
  expires_at?: string;
  error?: string;
}

/**
 * Get signals request
 */
export const GetSignalsRequestSchema = z.object({
  signal_types: z.array(SignalType).optional(),
  status: SignalStatus.optional(),
  min_confidence: z.number().min(0).max(100).default(0),
  min_impact: UserImpact.optional(),
  limit: z.number().int().min(1).max(100).default(20)
});
export type GetSignalsRequest = z.infer<typeof GetSignalsRequestSchema>;

/**
 * Get signals response
 */
export interface GetSignalsResponse {
  ok: boolean;
  signals?: PredictiveSignal[];
  count?: number;
  error?: string;
}

/**
 * Get signal details response
 */
export interface GetSignalDetailsResponse {
  ok: boolean;
  signal?: PredictiveSignal;
  evidence?: SignalEvidence[];
  history?: InterventionHistory[];
  error?: string;
}

/**
 * Acknowledge signal request
 */
export const AcknowledgeSignalRequestSchema = z.object({
  signal_id: z.string().uuid(),
  feedback: z.string().optional()
});
export type AcknowledgeSignalRequest = z.infer<typeof AcknowledgeSignalRequestSchema>;

/**
 * Acknowledge signal response
 */
export interface AcknowledgeSignalResponse {
  ok: boolean;
  signal_id?: string;
  status?: SignalStatus;
  error?: string;
}

/**
 * Dismiss signal request
 */
export const DismissSignalRequestSchema = z.object({
  signal_id: z.string().uuid(),
  reason: z.string().optional()
});
export type DismissSignalRequest = z.infer<typeof DismissSignalRequestSchema>;

/**
 * Dismiss signal response
 */
export interface DismissSignalResponse {
  ok: boolean;
  signal_id?: string;
  status?: SignalStatus;
  error?: string;
}

/**
 * Record intervention request
 */
export const RecordInterventionRequestSchema = z.object({
  signal_id: z.string().uuid(),
  action_type: InterventionActionType,
  action_details: z.record(z.unknown()).default({})
});
export type RecordInterventionRequest = z.infer<typeof RecordInterventionRequestSchema>;

/**
 * Record intervention response
 */
export interface RecordInterventionResponse {
  ok: boolean;
  intervention_id?: string;
  error?: string;
}

/**
 * Get signal stats response
 */
export interface GetSignalStatsResponse {
  ok: boolean;
  total_signals?: number;
  active_signals?: number;
  acknowledged_signals?: number;
  dismissed_signals?: number;
  high_impact_signals?: number;
  by_type?: Record<SignalType, number>;
  avg_confidence?: number;
  since?: string;
  error?: string;
}

/**
 * Detection run request
 */
export const RunDetectionRequestSchema = z.object({
  signal_types: z.array(SignalType).optional(),
  time_window: TimeWindow.default('last_14_days'),
  force: z.boolean().default(false)  // Bypass rate limiting
});
export type RunDetectionRequest = z.infer<typeof RunDetectionRequestSchema>;

/**
 * Detection run response
 */
export interface RunDetectionResponse {
  ok: boolean;
  signals_detected?: number;
  signals_created?: number;
  signals_skipped?: number;  // Due to rate limiting
  signals?: PredictiveSignal[];
  duration_ms?: number;
  error?: string;
}

// =============================================================================
// VTID-01138: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for signal detection
 */
export const SIGNAL_EVENT_TYPES = [
  'd44.signal.detected',
  'd44.signal.created',
  'd44.signal.acknowledged',
  'd44.signal.dismissed',
  'd44.signal.actioned',
  'd44.signal.expired',
  'd44.detection.started',
  'd44.detection.completed',
  'd44.intervention.recorded'
] as const;

export type SignalEventType = typeof SIGNAL_EVENT_TYPES[number];

/**
 * OASIS event payload for signal detection
 */
export interface SignalEventPayload {
  vtid: string;
  tenant_id?: string;
  user_id?: string;
  event_type: SignalEventType;
  signal_id?: string;
  signal_type?: SignalType;
  confidence?: number;
  user_impact?: UserImpact;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01138: Detection Input Types
// =============================================================================

/**
 * Input data for signal detection
 */
export interface DetectionInput {
  // Memory & Context
  diary_entries?: DiaryInput[];
  memory_nodes?: MemoryNodeInput[];
  preferences?: PreferenceInput[];
  relationships?: RelationshipInput[];
  conversation_summaries?: ConversationSummaryInput[];
  location_patterns?: LocationPatternInput[];
  calendar_density?: CalendarDensityInput;

  // Health (if available)
  vitana_scores?: VitanaScoreInput[];
  health_features?: HealthFeatureInput[];
  wearable_trends?: WearableTrendInput[];
  biomarker_deltas?: BiomarkerDeltaInput[];

  // D43 Integration
  drift_events?: DriftEventInput[];
  longitudinal_data_points?: LongitudinalDataPointInput[];
}

/**
 * Diary entry input
 */
export interface DiaryInput {
  id: string;
  recorded_at: string;
  mood_score?: number;
  energy_level?: number;
  topics?: string[];
  sentiment?: 'positive' | 'neutral' | 'negative';
}

/**
 * Memory node input
 */
export interface MemoryNodeInput {
  id: string;
  category: string;
  key: string;
  confidence: number;
  recorded_at: string;
}

/**
 * Preference input
 */
export interface PreferenceInput {
  id: string;
  category: string;
  key: string;
  value: unknown;
  confidence: number;
  recorded_at: string;
}

/**
 * Relationship input
 */
export interface RelationshipInput {
  id: string;
  relationship_type: string;
  strength: number;
  last_interaction?: string;
}

/**
 * Conversation summary input
 */
export interface ConversationSummaryInput {
  id: string;
  recorded_at: string;
  topics?: string[];
  sentiment?: string;
}

/**
 * Location pattern input
 */
export interface LocationPatternInput {
  date: string;
  location_count: number;
  travel_detected: boolean;
}

/**
 * Calendar density input
 */
export interface CalendarDensityInput {
  date: string;
  event_count: number;
  busy_hours: number;
}

/**
 * Vitana score input
 */
export interface VitanaScoreInput {
  id: string;
  date: string;
  overall_score: number;
  domain_scores: Record<string, number>;
}

/**
 * Health feature input
 */
export interface HealthFeatureInput {
  id: string;
  date: string;
  feature_key: string;
  value: number;
  unit?: string;
}

/**
 * Wearable trend input
 */
export interface WearableTrendInput {
  metric: string;
  direction: 'increasing' | 'decreasing' | 'stable';
  magnitude: number;
  confidence: number;
}

/**
 * Biomarker delta input
 */
export interface BiomarkerDeltaInput {
  biomarker: string;
  previous_value: number;
  current_value: number;
  change_percent: number;
  recorded_at: string;
}

/**
 * D43 Drift event input
 */
export interface DriftEventInput {
  id: string;
  type: string;
  magnitude: number;
  confidence: number;
  domains_affected: string[];
  detected_at: string;
}

/**
 * D43 Longitudinal data point input
 */
export interface LongitudinalDataPointInput {
  id: string;
  domain: string;
  key: string;
  value: unknown;
  numeric_value?: number;
  recorded_at: string;
}

// =============================================================================
// VTID-01138: Metadata & Display
// =============================================================================

/**
 * Signal type metadata for display
 */
export const SIGNAL_TYPE_METADATA: Record<SignalType, {
  label: string;
  description: string;
  icon: string;
  category: 'health' | 'behavior' | 'social' | 'positive';
}> = {
  health_drift: {
    label: 'Health Trend',
    description: 'Your health metrics are showing a notable trend',
    icon: 'heart',
    category: 'health'
  },
  behavioral_drift: {
    label: 'Behavior Change',
    description: 'Your patterns and habits seem to be shifting',
    icon: 'activity',
    category: 'behavior'
  },
  routine_instability: {
    label: 'Routine Disruption',
    description: 'Your regular routines appear less stable',
    icon: 'calendar',
    category: 'behavior'
  },
  cognitive_load_increase: {
    label: 'Mental Load',
    description: 'Signs of increased cognitive demand detected',
    icon: 'brain',
    category: 'health'
  },
  social_withdrawal: {
    label: 'Social Connection',
    description: 'Fewer social interactions than usual',
    icon: 'users-minus',
    category: 'social'
  },
  social_overload: {
    label: 'Social Demand',
    description: 'High volume of social interactions',
    icon: 'users-plus',
    category: 'social'
  },
  preference_shift: {
    label: 'Preference Change',
    description: 'Your preferences appear to be evolving',
    icon: 'sliders',
    category: 'behavior'
  },
  positive_momentum: {
    label: 'Positive Trend',
    description: 'Positive patterns worth celebrating',
    icon: 'trending-up',
    category: 'positive'
  }
};

/**
 * User impact metadata
 */
export const USER_IMPACT_METADATA: Record<UserImpact, {
  label: string;
  description: string;
  color: string;
}> = {
  low: {
    label: 'Low',
    description: 'Informational insight',
    color: 'blue'
  },
  medium: {
    label: 'Medium',
    description: 'Worth your attention',
    color: 'yellow'
  },
  high: {
    label: 'High',
    description: 'Requires attention',
    color: 'orange'
  }
};

/**
 * Suggested action metadata
 */
export const SUGGESTED_ACTION_METADATA: Record<SuggestedAction, {
  label: string;
  description: string;
}> = {
  awareness: {
    label: 'Be Aware',
    description: 'Simply be mindful of this pattern'
  },
  reflection: {
    label: 'Reflect',
    description: 'Consider what this means for you'
  },
  check_in: {
    label: 'Check In',
    description: 'Take time to assess this area'
  }
};
