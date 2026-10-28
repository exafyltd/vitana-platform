/**
 * VTID-01143: D49 Proactive Health & Lifestyle Risk Mitigation Layer
 *
 * Type definitions for the Risk Mitigation Engine that translates
 * risk windows (D45) and early signals (D44) into low-friction
 * mitigation suggestions that reduce downside before harm occurs.
 *
 * Core Philosophy:
 *   - Safety > optimization
 *   - No diagnosis, no treatment
 *   - No medical claims
 *   - Suggestions only, never actions
 *   - Explainability mandatory
 *   - All outputs logged to OASIS
 *
 * This layer answers: "What small, safe adjustment could lower risk right now?"
 *
 * Determinism Rules:
 *   - Same risk inputs → same mitigation suggestions
 *   - Rule-based generation, no generative inference
 *   - All mitigations are dismissible without consequence
 */

import { z } from 'zod';

// =============================================================================
// VTID-01143: Mitigation Domain Types
// =============================================================================

/**
 * Mitigation domains - each mitigation must belong to exactly one
 */
export const MitigationDomain = z.enum([
  'sleep',       // Sleep & Recovery
  'nutrition',   // Nutrition & Hydration
  'movement',    // Movement & Activity
  'mental',      // Mental Load & Stress
  'routine',     // Routine Stability
  'social'       // Social Balance
]);
export type MitigationDomain = z.infer<typeof MitigationDomain>;

/**
 * Effort levels - D49 only generates low effort mitigations
 */
export const EffortLevel = z.enum([
  'low',         // Can be done immediately with minimal effort
  'medium',      // Requires some planning or commitment (not used in D49)
  'high'         // Significant effort required (not used in D49)
]);
export type EffortLevel = z.infer<typeof EffortLevel>;

/**
 * Mitigation status tracking
 */
export const MitigationStatus = z.enum([
  'active',      // Currently displayed/available to user
  'dismissed',   // User dismissed without action
  'acknowledged',// User acknowledged/viewed
  'expired',     // Time window passed
  'superseded'   // Replaced by a newer mitigation
]);
export type MitigationStatus = z.infer<typeof MitigationStatus>;

// =============================================================================
// VTID-01143: Risk Window & Signal Input Types
// =============================================================================

/**
 * Risk window input from D45
 */
export const RiskWindowInputSchema = z.object({
  risk_window_id: z.string().uuid(),
  risk_type: z.string(),
  confidence: z.number().min(0).max(100),
  severity: z.enum(['low', 'medium', 'high']),
  start_time: z.string().datetime(),
  end_time: z.string().datetime().optional(),
  domains_affected: z.array(z.string()),
  evidence: z.array(z.object({
    signal_id: z.string().optional(),
    description: z.string(),
    weight: z.number().min(0).max(1)
  })).optional(),
  metadata: z.record(z.unknown()).optional()
});
export type RiskWindowInput = z.infer<typeof RiskWindowInputSchema>;

/**
 * Early signal input from D44
 */
export const EarlySignalInputSchema = z.object({
  signal_id: z.string().uuid(),
  signal_type: z.string(),
  value: z.unknown(),
  numeric_value: z.number().optional(),
  confidence: z.number().min(0).max(100),
  detected_at: z.string().datetime(),
  domain: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});
export type EarlySignalInput = z.infer<typeof EarlySignalInputSchema>;

/**
 * Health context (optional, non-diagnostic)
 */
export const HealthContextSchema = z.object({
  vitana_index: z.number().min(0).max(100).optional(),
  energy_level: z.number().min(0).max(100).optional(),
  stress_level: z.number().min(0).max(100).optional(),
  sleep_quality: z.number().min(0).max(100).optional(),
  activity_level: z.number().min(0).max(100).optional()
});
export type HealthContext = z.infer<typeof HealthContextSchema>;

/**
 * User context for personalization
 */
export const UserContextSchema = z.object({
  user_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  timezone: z.string().optional(),
  preferences: z.record(z.unknown()).optional(),
  constraints: z.array(z.string()).optional(),
  recent_mitigations: z.array(z.string().uuid()).optional()
});
export type UserContext = z.infer<typeof UserContextSchema>;

// =============================================================================
// VTID-01143: Core Mitigation Types
// =============================================================================

/**
 * A single risk mitigation suggestion
 * This is the primary output of D49
 */
export const RiskMitigationSchema = z.object({
  mitigation_id: z.string().uuid(),
  risk_window_id: z.string().uuid(),
  domain: MitigationDomain,
  confidence: z.number().min(0).max(100),
  suggested_adjustment: z.string(),  // Plain language, optional phrasing
  why_this_helps: z.string(),        // Short explanation
  effort_level: z.literal('low'),    // D49 only generates low effort
  dismissible: z.literal(true),      // Always true - user can always dismiss

  // Additional metadata
  source_signals: z.array(z.string().uuid()).optional(),
  precedent_type: z.enum(['user_history', 'general_safety']).optional(),

  // Safety disclaimers (always present)
  disclaimer: z.string().default('This is a gentle suggestion, not medical advice. Feel free to dismiss if not relevant.'),

  // Lifecycle
  status: MitigationStatus.default('active'),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().optional(),
  dismissed_at: z.string().datetime().optional(),

  // Audit
  generated_by_version: z.string(),
  input_hash: z.string()  // For determinism verification
});
export type RiskMitigation = z.infer<typeof RiskMitigationSchema>;

/**
 * Mitigation generation result
 */
export const MitigationGenerationResultSchema = z.object({
  ok: z.boolean(),
  mitigations: z.array(RiskMitigationSchema).default([]),
  skipped_reasons: z.array(z.object({
    risk_window_id: z.string().uuid(),
    reason: z.string()
  })).optional(),
  generation_metadata: z.object({
    engine_version: z.string(),
    computed_at: z.string().datetime(),
    computation_duration_ms: z.number(),
    determinism_key: z.string(),
    input_hash: z.string()
  }),
  error: z.string().optional()
});
export type MitigationGenerationResult = z.infer<typeof MitigationGenerationResultSchema>;

// =============================================================================
// VTID-01143: API Request/Response Types
// =============================================================================

/**
 * Generate mitigations request
 */
export const GenerateMitigationsRequestSchema = z.object({
  risk_windows: z.array(RiskWindowInputSchema),
  early_signals: z.array(EarlySignalInputSchema).optional(),
  health_context: HealthContextSchema.optional(),
  user_context: UserContextSchema
});
export type GenerateMitigationsRequest = z.infer<typeof GenerateMitigationsRequestSchema>;

/**
 * Generate mitigations response
 */
export interface GenerateMitigationsResponse {
  ok: boolean;
  mitigations?: RiskMitigation[];
  skipped_count?: number;
  generation_id?: string;
  error?: string;
}

/**
 * Dismiss mitigation request
 */
export const DismissMitigationRequestSchema = z.object({
  mitigation_id: z.string().uuid(),
  reason: z.enum(['not_relevant', 'already_doing', 'not_now', 'no_reason']).optional()
});
export type DismissMitigationRequest = z.infer<typeof DismissMitigationRequestSchema>;

/**
 * Dismiss mitigation response
 */
export interface DismissMitigationResponse {
  ok: boolean;
  mitigation_id?: string;
  dismissed_at?: string;
  error?: string;
}

/**
 * Get active mitigations request
 */
export const GetActiveMitigationsRequestSchema = z.object({
  domains: z.array(MitigationDomain).optional(),
  limit: z.number().int().min(1).max(50).default(10)
});
export type GetActiveMitigationsRequest = z.infer<typeof GetActiveMitigationsRequestSchema>;

/**
 * Get active mitigations response
 */
export interface GetActiveMitigationsResponse {
  ok: boolean;
  mitigations?: RiskMitigation[];
  count?: number;
  error?: string;
}

/**
 * Get mitigation history request
 */
export const GetMitigationHistoryRequestSchema = z.object({
  domains: z.array(MitigationDomain).optional(),
  statuses: z.array(MitigationStatus).optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20)
});
export type GetMitigationHistoryRequest = z.infer<typeof GetMitigationHistoryRequestSchema>;

/**
 * Get mitigation history response
 */
export interface GetMitigationHistoryResponse {
  ok: boolean;
  mitigations?: RiskMitigation[];
  count?: number;
  error?: string;
}

// =============================================================================
// VTID-01143: Mitigation Rule Types
// =============================================================================

/**
 * Mitigation rule for deterministic generation
 */
export interface MitigationRule {
  id: string;
  domain: MitigationDomain;
  trigger_risk_types: string[];
  min_confidence: number;
  suggestion_template: string;
  explanation_template: string;
  conditions: MitigationCondition[];
  precedent_type: 'user_history' | 'general_safety';
  cooldown_days: number;  // Don't show again within this period
}

/**
 * Condition for mitigation rule activation
 */
export interface MitigationCondition {
  type: 'risk_severity' | 'time_of_day' | 'health_metric' | 'signal_present';
  operator: 'eq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'not_in';
  value: unknown;
}

/**
 * Recent mitigation check for cooldown enforcement
 */
export interface RecentMitigationCheck {
  domain: MitigationDomain;
  suggestion_hash: string;
  last_shown: string;
  days_since: number;
}

// =============================================================================
// VTID-01143: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for risk mitigation
 */
export const RISK_MITIGATION_EVENT_TYPES = [
  'risk_mitigation.generated',
  'risk_mitigation.dismissed',
  'risk_mitigation.acknowledged',
  'risk_mitigation.expired',
  'risk_mitigation.skipped',
  'risk_mitigation.error'
] as const;

export type RiskMitigationEventType = typeof RISK_MITIGATION_EVENT_TYPES[number];

/**
 * OASIS event payload for risk mitigation
 */
export interface RiskMitigationEventPayload {
  vtid: string;
  tenant_id?: string;
  user_id?: string;
  mitigation_id?: string;
  risk_window_id?: string;
  domain?: MitigationDomain;
  event_type: RiskMitigationEventType;
  confidence?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01143: Configuration & Thresholds
// =============================================================================

/**
 * D49 configuration thresholds
 */
export const MITIGATION_THRESHOLDS = {
  // Minimum risk confidence to generate mitigation (from spec: 75%)
  MIN_RISK_CONFIDENCE: 75,

  // Cooldown period - don't show similar mitigation within N days (from spec: 14 days)
  COOLDOWN_DAYS: 14,

  // Maximum mitigations to show at once
  MAX_ACTIVE_MITIGATIONS: 5,

  // Expiry time for mitigations (hours)
  DEFAULT_EXPIRY_HOURS: 24,

  // Minimum confidence for generated mitigation
  MIN_MITIGATION_CONFIDENCE: 60
} as const;

/**
 * Domain-specific configuration
 */
export const DOMAIN_CONFIG: Record<MitigationDomain, {
  label: string;
  description: string;
  icon: string;
  priority: number;
  example_suggestions: string[];
}> = {
  sleep: {
    label: 'Sleep & Recovery',
    description: 'Suggestions to improve sleep quality and recovery',
    icon: 'moon',
    priority: 1,
    example_suggestions: [
      'Consider dimming lights 30 minutes before bed',
      'A short wind-down routine may help tonight'
    ]
  },
  nutrition: {
    label: 'Nutrition & Hydration',
    description: 'Gentle reminders about eating and drinking habits',
    icon: 'droplet',
    priority: 2,
    example_suggestions: [
      'Having a glass of water might help right now',
      'Consider a light snack if you haven\'t eaten recently'
    ]
  },
  movement: {
    label: 'Movement & Activity',
    description: 'Low-effort movement suggestions',
    icon: 'activity',
    priority: 3,
    example_suggestions: [
      'A brief walk might help clear your mind',
      'Consider stretching for a few minutes'
    ]
  },
  mental: {
    label: 'Mental Load & Stress',
    description: 'Stress reduction and mental wellness suggestions',
    icon: 'brain',
    priority: 4,
    example_suggestions: [
      'Taking a few deep breaths may help',
      'Consider stepping away for a brief moment'
    ]
  },
  routine: {
    label: 'Routine Stability',
    description: 'Suggestions to maintain healthy routines',
    icon: 'calendar',
    priority: 5,
    example_suggestions: [
      'Keeping your usual schedule today might help',
      'Consider sticking to your regular routine'
    ]
  },
  social: {
    label: 'Social Balance',
    description: 'Social connection and balance suggestions',
    icon: 'users',
    priority: 6,
    example_suggestions: [
      'Reaching out to someone might be nice today',
      'Consider taking some quiet time for yourself'
    ]
  }
};

/**
 * Language patterns for safe, non-prescriptive suggestions
 * All suggestions must use these patterns
 */
export const SAFE_LANGUAGE_PATTERNS = {
  prefixes: [
    'Consider',
    'You might find it helpful to',
    'It may help to',
    'When you have a moment, perhaps',
    'A gentle reminder to',
    'You could try'
  ],
  suffixes: [
    'if that feels right',
    'when it works for you',
    'only if you feel like it',
    'as feels comfortable'
  ],
  disclaimers: [
    'This is just a gentle suggestion - feel free to dismiss.',
    'Only you know what\'s best for you right now.',
    'This is not medical advice.',
    'Take this or leave it - no pressure.'
  ]
};

/**
 * Mitigation status metadata for display
 */
export const MITIGATION_STATUS_METADATA: Record<MitigationStatus, {
  label: string;
  description: string;
  color: string;
}> = {
  active: {
    label: 'Active',
    description: 'Currently available for the user',
    color: 'blue'
  },
  dismissed: {
    label: 'Dismissed',
    description: 'User chose to dismiss this suggestion',
    color: 'gray'
  },
  acknowledged: {
    label: 'Acknowledged',
    description: 'User viewed or acknowledged this suggestion',
    color: 'green'
  },
  expired: {
    label: 'Expired',
    description: 'Time window for this suggestion has passed',
    color: 'yellow'
  },
  superseded: {
    label: 'Superseded',
    description: 'Replaced by a newer, more relevant suggestion',
    color: 'gray'
  }
};
