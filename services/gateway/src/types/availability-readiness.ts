/**
 * VTID-01127: Availability, Time-Window & Readiness Types (D33)
 *
 * Type definitions for the Availability, Time-Window & Readiness Engine.
 * Determines how much and how deep the system should act right now.
 *
 * Hard Constraints (from spec):
 *   - Default to LOWER depth when uncertain
 *   - Never stack multiple asks in low availability
 *   - Monetization requires readiness_score >= threshold
 *   - User overrides always win immediately
 *
 * This engine prevents:
 *   - Cognitive overload
 *   - Mistimed prompts
 *   - Premature monetization
 */

import { z } from 'zod';

// =============================================================================
// Availability Levels
// =============================================================================

/**
 * User availability level inferred from signals
 * Conservative fusion of multiple input signals
 */
export const AvailabilityLevel = z.enum([
  'low',      // User is likely busy/distracted
  'medium',   // User has some time but limited
  'high',     // User appears engaged and available
  'unknown'   // Insufficient signals to determine
]);
export type AvailabilityLevel = z.infer<typeof AvailabilityLevel>;

// =============================================================================
// Time Window Types
// =============================================================================

/**
 * Viable action window types
 * How much time the user likely has for interaction
 */
export const TimeWindow = z.enum([
  'immediate',  // <=2 minutes - quick nudge only
  'short',      // 2-10 minutes - brief flow
  'extended',   // >10 minutes - deep engagement possible
  'defer'       // Not now - save for later
]);
export type TimeWindow = z.infer<typeof TimeWindow>;

// =============================================================================
// Readiness Score
// =============================================================================

/**
 * Cognitive/behavioral readiness score (0.0 - 1.0)
 * Estimates user's capacity for engagement
 */
export const ReadinessScoreSchema = z.number().min(0).max(1);
export type ReadinessScore = z.infer<typeof ReadinessScoreSchema>;

// =============================================================================
// Action Depth Configuration
// =============================================================================

/**
 * Action depth output - controls what the system is allowed to do
 * Translates availability + time window + readiness into guardrails
 */
export const ActionDepthSchema = z.object({
  max_steps: z.number().int().min(0).max(10).default(1),
  max_questions: z.number().int().min(0).max(5).default(0),
  max_recommendations: z.number().int().min(0).max(5).default(1),
  allow_booking: z.boolean().default(false),
  allow_payment: z.boolean().default(false)
});
export type ActionDepth = z.infer<typeof ActionDepthSchema>;

// =============================================================================
// Availability Tags
// =============================================================================

/**
 * Output tags for downstream engines to consume
 */
export const AvailabilityTag = z.enum([
  'quick_only',       // Only quick, simple interactions
  'light_flow_ok',    // Short guided flows acceptable
  'deep_flow_ok',     // Extended engagement allowed
  'defer_actions'     // Defer all non-essential actions
]);
export type AvailabilityTag = z.infer<typeof AvailabilityTag>;

// =============================================================================
// Signal Inputs (D33 Dependencies)
// =============================================================================

/**
 * Time context signals for availability inference
 */
export interface TimeContextSignals {
  current_hour: number;              // 0-23
  day_of_week: number;               // 0=Sunday, 6=Saturday
  is_weekend: boolean;
  local_timezone_offset_minutes?: number;
}

/**
 * Session telemetry for pacing inference
 */
export interface SessionTelemetry {
  session_start_time: string;        // ISO timestamp
  interaction_count: number;         // Number of turns
  avg_response_time_seconds: number; // Average user response time
  session_length_minutes: number;    // How long session has been active
  recent_response_times?: number[];  // Last N response times (optional)
  interaction_mode: 'voice' | 'text';
}

/**
 * Calendar/schedule hints (if available)
 */
export interface CalendarHints {
  has_upcoming_event: boolean;
  minutes_to_next_event?: number;
  is_in_meeting: boolean;
  calendar_availability?: 'free' | 'busy' | 'tentative' | 'unknown';
}

/**
 * Health context (non-diagnostic)
 */
export interface HealthContextHints {
  energy_indicator?: 'low' | 'medium' | 'high' | 'unknown';
  recent_sleep_quality?: number;     // 0-100, from longevity state
  stress_level?: number;             // 0-100, from D28/longevity
}

/**
 * Complete input for D33 computation
 */
export interface AvailabilityComputeInput {
  // Session context
  session_id?: string;
  turn_id?: string;

  // Time context
  time_context?: TimeContextSignals;

  // Session telemetry
  telemetry?: SessionTelemetry;

  // Calendar hints
  calendar?: CalendarHints;

  // D28 emotional/cognitive signals (simplified)
  emotional_state?: string;
  cognitive_state?: string;
  engagement_level?: 'high' | 'medium' | 'low';
  is_urgent?: boolean;
  is_hesitant?: boolean;

  // D27 preferences
  preferred_interaction_depth?: 'minimal' | 'moderate' | 'detailed';
  quiet_hours_active?: boolean;

  // Health context
  health_context?: HealthContextHints;

  // User override (always wins)
  user_override?: {
    availability?: AvailabilityLevel;
    time_available_minutes?: number;
    readiness?: 'ready' | 'not_now' | 'busy';
  };
}

// =============================================================================
// Engine Output
// =============================================================================

/**
 * Availability assessment with confidence
 */
export interface AvailabilityAssessment {
  level: AvailabilityLevel;
  confidence: number;          // 0-100
  factors: AvailabilityFactor[];
}

/**
 * Factor contributing to availability assessment
 */
export interface AvailabilityFactor {
  source: string;              // Which signal source
  signal: string;              // What was detected
  contribution: number;        // -1.0 to +1.0 impact
  confidence: number;          // 0-100
}

/**
 * Time window assessment
 */
export interface TimeWindowAssessment {
  window: TimeWindow;
  confidence: number;
  estimated_minutes?: number;
  factors: TimeWindowFactor[];
}

/**
 * Factor contributing to time window assessment
 */
export interface TimeWindowFactor {
  source: string;
  signal: string;
  contribution: number;
}

/**
 * Readiness assessment
 */
export interface ReadinessAssessment {
  score: ReadinessScore;
  confidence: number;
  factors: ReadinessFactor[];
  risk_flags: ReadinessRiskFlag[];
}

/**
 * Factor contributing to readiness score
 */
export interface ReadinessFactor {
  source: string;
  signal: string;
  impact: number;              // -1.0 to +1.0
}

/**
 * Risk flags that may reduce readiness
 */
export interface ReadinessRiskFlag {
  type: 'decision_fatigue' | 'cognitive_overload' | 'emotional_stress' | 'low_energy' | 'time_pressure';
  severity: 'low' | 'medium' | 'high';
  reason: string;
}

/**
 * Complete D33 output bundle
 */
export interface AvailabilityReadinessBundle {
  // Core assessments
  availability: AvailabilityAssessment;
  time_window: TimeWindowAssessment;
  readiness: ReadinessAssessment;

  // Action depth guardrails
  action_depth: ActionDepth;

  // Availability tag for downstream
  availability_tag: AvailabilityTag;

  // Metadata
  computed_at: string;
  session_id?: string;
  turn_id?: string;
  was_user_override: boolean;

  // Disclaimer
  disclaimer: string;
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/**
 * Compute availability request
 */
export const ComputeAvailabilityRequestSchema = z.object({
  session_id: z.string().optional(),
  turn_id: z.string().optional(),
  time_context: z.object({
    current_hour: z.number().int().min(0).max(23),
    day_of_week: z.number().int().min(0).max(6),
    is_weekend: z.boolean(),
    local_timezone_offset_minutes: z.number().optional()
  }).optional(),
  telemetry: z.object({
    session_start_time: z.string(),
    interaction_count: z.number().int().min(0),
    avg_response_time_seconds: z.number().min(0),
    session_length_minutes: z.number().min(0),
    recent_response_times: z.array(z.number()).optional(),
    interaction_mode: z.enum(['voice', 'text'])
  }).optional(),
  calendar: z.object({
    has_upcoming_event: z.boolean(),
    minutes_to_next_event: z.number().optional(),
    is_in_meeting: z.boolean(),
    calendar_availability: z.enum(['free', 'busy', 'tentative', 'unknown']).optional()
  }).optional(),
  emotional_state: z.string().optional(),
  cognitive_state: z.string().optional(),
  engagement_level: z.enum(['high', 'medium', 'low']).optional(),
  is_urgent: z.boolean().optional(),
  is_hesitant: z.boolean().optional(),
  preferred_interaction_depth: z.enum(['minimal', 'moderate', 'detailed']).optional(),
  quiet_hours_active: z.boolean().optional(),
  health_context: z.object({
    energy_indicator: z.enum(['low', 'medium', 'high', 'unknown']).optional(),
    recent_sleep_quality: z.number().min(0).max(100).optional(),
    stress_level: z.number().min(0).max(100).optional()
  }).optional(),
  user_override: z.object({
    availability: AvailabilityLevel.optional(),
    time_available_minutes: z.number().optional(),
    readiness: z.enum(['ready', 'not_now', 'busy']).optional()
  }).optional()
});
export type ComputeAvailabilityRequest = z.infer<typeof ComputeAvailabilityRequestSchema>;

/**
 * Standard API response
 */
export interface AvailabilityApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Compute response
 */
export interface ComputeAvailabilityResponse {
  ok: boolean;
  bundle?: AvailabilityReadinessBundle;
  error?: string;
  message?: string;
}

/**
 * Get current response
 */
export interface GetCurrentAvailabilityResponse {
  ok: boolean;
  bundle?: AvailabilityReadinessBundle;
  cached: boolean;
  cache_age_seconds?: number;
  error?: string;
}

/**
 * Override request
 */
export const OverrideAvailabilityRequestSchema = z.object({
  availability: AvailabilityLevel.optional(),
  time_available_minutes: z.number().min(0).optional(),
  readiness: z.enum(['ready', 'not_now', 'busy']).optional(),
  reason: z.string().optional()
});
export type OverrideAvailabilityRequest = z.infer<typeof OverrideAvailabilityRequestSchema>;

/**
 * Override response
 */
export interface OverrideAvailabilityResponse {
  ok: boolean;
  override_id?: string;
  previous_level?: AvailabilityLevel;
  new_level?: AvailabilityLevel;
  expires_at?: string;
  error?: string;
}

// =============================================================================
// Guardrail Integration Types
// =============================================================================

/**
 * Guardrail context for downstream engines (D34-D36)
 */
export interface AvailabilityGuardrailContext {
  max_steps: number;
  max_questions: number;
  max_recommendations: number;
  allow_booking: boolean;
  allow_payment: boolean;
  availability_tag: AvailabilityTag;
  readiness_score: number;
  time_window: TimeWindow;
}

/**
 * Format guardrail context for system prompt injection
 */
export function formatGuardrailContextForPrompt(ctx: AvailabilityGuardrailContext): string {
  const lines: string[] = [
    '## Action Depth Guardrails (D33)',
    ''
  ];

  // Tag-based summary
  switch (ctx.availability_tag) {
    case 'quick_only':
      lines.push('User availability: LOW - Quick interactions only');
      lines.push('- Limit to 1 concise suggestion');
      lines.push('- No follow-up questions');
      lines.push('- No bookings or payments');
      break;
    case 'light_flow_ok':
      lines.push('User availability: MEDIUM - Light flows acceptable');
      lines.push(`- Up to ${ctx.max_steps} steps allowed`);
      lines.push(`- Up to ${ctx.max_questions} clarifying question(s)`);
      break;
    case 'deep_flow_ok':
      lines.push('User availability: HIGH - Extended engagement allowed');
      lines.push('- Guided flows and multi-step interactions permitted');
      if (ctx.allow_booking) lines.push('- Bookings allowed');
      if (ctx.allow_payment) lines.push('- Payments allowed (with confirmation)');
      break;
    case 'defer_actions':
      lines.push('User availability: DEFER - Save actions for later');
      lines.push('- Acknowledge request and note for follow-up');
      lines.push('- No active suggestions or asks');
      break;
  }

  lines.push('');
  lines.push(`Readiness score: ${(ctx.readiness_score * 100).toFixed(0)}%`);

  if (ctx.readiness_score < 0.5) {
    lines.push('- Avoid commitments or monetization');
    lines.push('- Consider offering: "Too much right now?"');
  }

  return lines.join('\n');
}

// =============================================================================
// OASIS Event Types
// =============================================================================

/**
 * OASIS event types for D33
 */
export const AVAILABILITY_EVENT_TYPES = [
  'd33.availability.computed',
  'd33.availability.override',
  'd33.readiness.risk_flagged',
  'd33.action_depth.applied',
  'd33.guardrail.enforced'
] as const;

export type AvailabilityEventType = typeof AVAILABILITY_EVENT_TYPES[number];

/**
 * OASIS event payload
 */
export interface AvailabilityEventPayload {
  vtid: string;
  session_id?: string;
  turn_id?: string;
  availability_level: AvailabilityLevel;
  time_window: TimeWindow;
  readiness_score: number;
  availability_tag: AvailabilityTag;
  was_override: boolean;
  action_depth?: ActionDepth;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default thresholds for D33 rules.
 *
 * VTID-03136 (Phase B.7): the 11 literal values below are the cache-cold
 * safety net. Production source of truth is `decision_policy` rows
 * under `situational.*`. Consumers should call `getD33Thresholds()` —
 * which reads through PolicyResolver — instead of `D33_THRESHOLDS.X`
 * directly. The literal export is preserved for backwards compatibility
 * and test fixtures.
 */
export interface D33Thresholds {
  // Readiness thresholds
  READINESS_MONETIZATION_MIN: number;
  READINESS_DEEP_FLOW_MIN: number;
  READINESS_LIGHT_FLOW_MIN: number;
  // Time window boundaries (minutes)
  TIME_IMMEDIATE_MAX: number;
  TIME_SHORT_MAX: number;
  // Confidence threshold
  MIN_CONFIDENCE_FOR_ACTION: number;
  // Response time signals (seconds)
  FAST_RESPONSE_THRESHOLD: number;
  SLOW_RESPONSE_THRESHOLD: number;
  // Session length signals (minutes)
  SHORT_SESSION_THRESHOLD: number;
  LONG_SESSION_THRESHOLD: number;
  // Override expiry (minutes)
  OVERRIDE_EXPIRY_MINUTES: number;
}

export const D33_THRESHOLDS_FALLBACK: D33Thresholds = {
  READINESS_MONETIZATION_MIN: 0.6,
  READINESS_DEEP_FLOW_MIN: 0.5,
  READINESS_LIGHT_FLOW_MIN: 0.3,
  TIME_IMMEDIATE_MAX: 2,
  TIME_SHORT_MAX: 10,
  MIN_CONFIDENCE_FOR_ACTION: 50,
  FAST_RESPONSE_THRESHOLD: 5,
  SLOW_RESPONSE_THRESHOLD: 30,
  SHORT_SESSION_THRESHOLD: 2,
  LONG_SESSION_THRESHOLD: 15,
  OVERRIDE_EXPIRY_MINUTES: 30,
};

// Backwards-compatible alias — kept for callers that read the const at
// module-load time. New consumers should prefer `getD33Thresholds()`.
export const D33_THRESHOLDS: D33Thresholds = D33_THRESHOLDS_FALLBACK;

/**
 * Resolve the current D33 threshold set via PolicyResolver. Each field
 * falls back to the literal in `D33_THRESHOLDS_FALLBACK` when the
 * resolver cache is cold or the policy row is missing.
 */
export function getD33Thresholds(): D33Thresholds {
  // Lazy import to avoid a circular dependency: `decision-contract`
  // doesn't import `types/`, but `types/` shouldn't pull in services at
  // module load. The require pattern resolves at call time, when the
  // service registry is already constructed.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getPolicyResolver } = require('../services/decision-contract/policy-resolver') as typeof import('../services/decision-contract/policy-resolver');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { POLICY_KEYS } = require('../services/decision-contract/policy-keys') as typeof import('../services/decision-contract/policy-keys');
  const r = getPolicyResolver();
  return {
    READINESS_MONETIZATION_MIN: r.getValue<number>(POLICY_KEYS.SITUATIONAL_READINESS_MONETIZATION_MIN, { defaultValue: D33_THRESHOLDS_FALLBACK.READINESS_MONETIZATION_MIN }),
    READINESS_DEEP_FLOW_MIN:    r.getValue<number>(POLICY_KEYS.SITUATIONAL_READINESS_DEEP_FLOW_MIN,    { defaultValue: D33_THRESHOLDS_FALLBACK.READINESS_DEEP_FLOW_MIN }),
    READINESS_LIGHT_FLOW_MIN:   r.getValue<number>(POLICY_KEYS.SITUATIONAL_READINESS_LIGHT_FLOW_MIN,   { defaultValue: D33_THRESHOLDS_FALLBACK.READINESS_LIGHT_FLOW_MIN }),
    TIME_IMMEDIATE_MAX:         r.getValue<number>(POLICY_KEYS.SITUATIONAL_TIME_WINDOW_IMMEDIATE_MAX_MINUTES, { defaultValue: D33_THRESHOLDS_FALLBACK.TIME_IMMEDIATE_MAX }),
    TIME_SHORT_MAX:             r.getValue<number>(POLICY_KEYS.SITUATIONAL_TIME_WINDOW_SHORT_MAX_MINUTES,     { defaultValue: D33_THRESHOLDS_FALLBACK.TIME_SHORT_MAX }),
    MIN_CONFIDENCE_FOR_ACTION:  r.getValue<number>(POLICY_KEYS.SITUATIONAL_CONFIDENCE_MIN_FOR_ACTION,         { defaultValue: D33_THRESHOLDS_FALLBACK.MIN_CONFIDENCE_FOR_ACTION }),
    FAST_RESPONSE_THRESHOLD:    r.getValue<number>(POLICY_KEYS.SITUATIONAL_RESPONSE_TIME_FAST_THRESHOLD_SECONDS, { defaultValue: D33_THRESHOLDS_FALLBACK.FAST_RESPONSE_THRESHOLD }),
    SLOW_RESPONSE_THRESHOLD:    r.getValue<number>(POLICY_KEYS.SITUATIONAL_RESPONSE_TIME_SLOW_THRESHOLD_SECONDS, { defaultValue: D33_THRESHOLDS_FALLBACK.SLOW_RESPONSE_THRESHOLD }),
    SHORT_SESSION_THRESHOLD:    r.getValue<number>(POLICY_KEYS.SITUATIONAL_SESSION_LENGTH_SHORT_THRESHOLD_MINUTES, { defaultValue: D33_THRESHOLDS_FALLBACK.SHORT_SESSION_THRESHOLD }),
    LONG_SESSION_THRESHOLD:     r.getValue<number>(POLICY_KEYS.SITUATIONAL_SESSION_LENGTH_LONG_THRESHOLD_MINUTES,  { defaultValue: D33_THRESHOLDS_FALLBACK.LONG_SESSION_THRESHOLD }),
    OVERRIDE_EXPIRY_MINUTES:    r.getValue<number>(POLICY_KEYS.SITUATIONAL_OVERRIDE_EXPIRY_MINUTES,               { defaultValue: D33_THRESHOLDS_FALLBACK.OVERRIDE_EXPIRY_MINUTES }),
  };
}

/**
 * Default action depth profiles
 */
export const ACTION_DEPTH_PROFILES: Record<AvailabilityTag, ActionDepth> = {
  quick_only: {
    max_steps: 1,
    max_questions: 0,
    max_recommendations: 1,
    allow_booking: false,
    allow_payment: false
  },
  light_flow_ok: {
    max_steps: 3,
    max_questions: 1,
    max_recommendations: 2,
    allow_booking: false,
    allow_payment: false
  },
  deep_flow_ok: {
    max_steps: 10,
    max_questions: 3,
    max_recommendations: 5,
    allow_booking: true,
    allow_payment: true
  },
  defer_actions: {
    max_steps: 0,
    max_questions: 0,
    max_recommendations: 0,
    allow_booking: false,
    allow_payment: false
  }
};

/**
 * Standard disclaimer for D33 outputs
 */
export const D33_DISCLAIMER = 'Availability and readiness assessments are probabilistic behavioral observations, not definitive states. User overrides always take precedence.';
