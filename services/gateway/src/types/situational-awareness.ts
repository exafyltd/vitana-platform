/**
 * VTID-01126: Situational Awareness Engine Types (D32)
 *
 * Type definitions for the Situational Awareness Engine.
 * D32 understands the user's current situation, not just their words.
 *
 * This engine answers: "What is realistically appropriate for this user right now?"
 *
 * Core Capabilities:
 * 1. Build a Situation Vector from available signals (time, location, availability, energy, constraints)
 * 2. Score every candidate action/recommendation against the situation
 * 3. Output situation-aware action envelopes and tags for downstream engines
 *
 * Hard Constraints (from spec):
 * - Never assume availability if unknown
 * - Prefer light suggestions when uncertainty is high
 * - Defer monetization if situation confidence < threshold
 * - Respect safety, health, and privacy constraints by default
 * - Situational inference must be reversible (can be corrected by user)
 */

import { z } from 'zod';
import type { IntelligenceDomain } from './domain-routing';
import type { PreferenceCategory } from './user-preferences';

// =============================================================================
// VTID-01126: Time Context
// =============================================================================

/**
 * Time window classifications
 */
export const TimeWindow = z.enum([
  'early_morning',     // 05:00-08:00
  'morning',           // 08:00-12:00
  'afternoon',         // 12:00-17:00
  'evening',           // 17:00-21:00
  'late_evening',      // 21:00-24:00
  'night'              // 00:00-05:00
]);
export type TimeWindow = z.infer<typeof TimeWindow>;

/**
 * Day type classification
 */
export const DayType = z.enum([
  'weekday',
  'weekend',
  'holiday'            // If known
]);
export type DayType = z.infer<typeof DayType>;

/**
 * Time context signals
 */
export interface TimeContext {
  /** Local time in user's timezone (ISO string) */
  local_time: string;
  /** Hour of day (0-23) */
  hour: number;
  /** Day of week (0=Sunday, 6=Saturday) */
  day_of_week: number;
  /** Time window classification */
  time_window: TimeWindow;
  /** Weekday or weekend */
  day_type: DayType;
  /** Minutes since midnight */
  minutes_since_midnight: number;
  /** Whether it's likely work hours (Mon-Fri 9-17) */
  is_likely_work_hours: boolean;
  /** Whether it's late night (22:00-06:00) */
  is_late_night: boolean;
  /** Whether it's early morning (05:00-08:00) */
  is_early_morning: boolean;
  /** User's timezone if known */
  timezone?: string;
  /** Confidence in time context (0-100) */
  confidence: number;
}

// =============================================================================
// VTID-01126: Location Context
// =============================================================================

/**
 * Location type classification
 */
export const LocationType = z.enum([
  'home',
  'work',
  'travel',
  'public',
  'unknown'
]);
export type LocationType = z.infer<typeof LocationType>;

/**
 * Indoor/outdoor bias
 */
export const EnvironmentType = z.enum([
  'indoor',
  'outdoor',
  'mixed',
  'unknown'
]);
export type EnvironmentType = z.infer<typeof EnvironmentType>;

/**
 * Location context signals
 */
export interface LocationContext {
  /** City if known */
  city?: string;
  /** Country if known */
  country?: string;
  /** Country code (ISO 3166-1 alpha-2) */
  country_code?: string;
  /** Location type classification */
  location_type: LocationType;
  /** Indoor/outdoor bias */
  environment_type: EnvironmentType;
  /** Whether user is traveling (different from home location) */
  is_traveling: boolean;
  /** Distance from home in km (if known) */
  distance_from_home_km?: number;
  /** Confidence in location context (0-100) */
  confidence: number;
}

// =============================================================================
// VTID-01126: Availability Context
// =============================================================================

/**
 * Availability level classification
 */
export const AvailabilityLevel = z.enum([
  'free',              // Open calendar, no constraints
  'lightly_busy',      // Some commitments but flexible
  'busy',              // Occupied, limited time
  'very_busy',         // Packed schedule
  'do_not_disturb',    // Explicitly unavailable
  'unknown'            // No calendar/availability data
]);
export type AvailabilityLevel = z.infer<typeof AvailabilityLevel>;

/**
 * Interaction mode preference
 */
export const InteractionMode = z.enum([
  'quick',             // User wants brief interactions
  'normal',            // Standard interaction length
  'long',              // User has time for deep engagement
  'unknown'
]);
export type InteractionMode = z.infer<typeof InteractionMode>;

/**
 * Availability context signals
 */
export interface AvailabilityContext {
  /** Overall availability level */
  availability_level: AvailabilityLevel;
  /** Preferred interaction mode */
  interaction_mode: InteractionMode;
  /** Whether calendar data is available */
  has_calendar_data: boolean;
  /** Minutes until next known commitment (if any) */
  minutes_until_next_commitment?: number;
  /** Whether user has free time blocks today */
  has_free_blocks_today: boolean;
  /** Estimated available minutes right now */
  estimated_available_minutes?: number;
  /** Confidence in availability context (0-100) */
  confidence: number;
}

// =============================================================================
// VTID-01126: Energy & Readiness Context
// =============================================================================

/**
 * Energy level classification
 */
export const EnergyLevel = z.enum([
  'high',              // User is energetic, ready for engagement
  'moderate',          // Normal energy levels
  'low',               // User seems tired or drained
  'depleted',          // User is exhausted
  'unknown'
]);
export type EnergyLevel = z.infer<typeof EnergyLevel>;

/**
 * Readiness for different activity types
 */
export const ReadinessLevel = z.enum([
  'ready_for_action',        // Can handle tasks, decisions
  'ready_for_exploration',   // Open to browsing, learning
  'passive_only',            // Only receptive mode
  'resting',                 // Not ready for engagement
  'unknown'
]);
export type ReadinessLevel = z.infer<typeof ReadinessLevel>;

/**
 * Energy & readiness context signals
 */
export interface EnergyReadinessContext {
  /** Inferred energy level */
  energy_level: EnergyLevel;
  /** Readiness for engagement */
  readiness_level: ReadinessLevel;
  /** Whether this is inferred from time of day */
  inferred_from_time: boolean;
  /** Whether this is inferred from emotional signals (D28) */
  inferred_from_signals: boolean;
  /** Whether this is inferred from health context */
  inferred_from_health: boolean;
  /** Recent interaction count (last hour) */
  recent_interaction_count: number;
  /** Time since last interaction (minutes) */
  minutes_since_last_interaction?: number;
  /** Confidence in energy/readiness context (0-100) */
  confidence: number;
}

// =============================================================================
// VTID-01126: Constraint Flags
// =============================================================================

/**
 * Situational constraint types
 */
export const SituationalConstraintType = z.enum([
  'safety',            // Safety-related constraint
  'cost_sensitivity',  // User is cost-conscious
  'mobility_limit',    // User has mobility constraints
  'privacy_sensitive', // User is in private mode
  'time_pressure',     // User is rushed
  'quiet_mode',        // User prefers minimal notifications
  'focus_mode',        // User is concentrating on something
  'health_constraint'  // Health-related limitation
]);
export type SituationalConstraintType = z.infer<typeof SituationalConstraintType>;

/**
 * Individual constraint flag
 */
export interface ConstraintFlag {
  type: SituationalConstraintType;
  active: boolean;
  confidence: number;
  source: 'explicit' | 'inferred' | 'scheduled' | 'health';
  expires_at?: string;
  description?: string;
}

// =============================================================================
// VTID-01126: Situation Vector (Core Output)
// =============================================================================

/**
 * Complete Situation Vector - the core output of D32
 *
 * This vector represents the user's current situation across all dimensions.
 * It is computed once per turn and used by downstream engines.
 */
export interface SituationVector {
  /** Time context signals */
  time_context: TimeContext;
  /** Location context signals */
  location_context: LocationContext;
  /** Availability context signals */
  availability_context: AvailabilityContext;
  /** Energy and readiness context */
  readiness_context: EnergyReadinessContext;
  /** Active constraint flags */
  constraint_flags: ConstraintFlag[];
  /** Overall situation confidence (0-100) */
  overall_confidence: number;
  /** Timestamp when this vector was computed */
  computed_at: string;
  /** Unique ID for this situation vector */
  vector_id: string;
}

// =============================================================================
// VTID-01126: Appropriateness Scoring
// =============================================================================

/**
 * Appropriateness classification for actions
 */
export const AppropriatenessLevel = z.enum([
  'appropriate_now',     // Good to do right now
  'better_later',        // Could do but better to defer
  'not_appropriate'      // Should not do in current situation
]);
export type AppropriatenessLevel = z.infer<typeof AppropriatenessLevel>;

/**
 * Scored action with appropriateness assessment
 */
export interface ScoredAction {
  /** The action being scored */
  action: string;
  /** Action type */
  action_type: 'recommendation' | 'suggestion' | 'proactive' | 'booking' | 'purchase' | 'notification';
  /** Domain of the action */
  domain?: IntelligenceDomain;
  /** Appropriateness classification */
  appropriateness: AppropriatenessLevel;
  /** Confidence in this assessment (0-100) */
  confidence: number;
  /** Reason for this classification */
  reason: string;
  /** Factors that contributed to this score */
  factors: AppropriatenessFactor[];
  /** Suggested deferral time if better_later */
  defer_until?: string;
  /** Alternative lighter action if available */
  lighter_alternative?: string;
}

/**
 * Factor contributing to appropriateness score
 */
export interface AppropriatenessFactor {
  factor: string;
  impact: 'positive' | 'negative' | 'neutral';
  weight: number;
  description: string;
}

// =============================================================================
// VTID-01126: Situation Tags (for downstream engines)
// =============================================================================

/**
 * Situation tags that feed downstream engines
 * These are the "output signals" that D33-D36, D44+, and Autopilot consume
 */
export const SituationTag = z.enum([
  'now_ok',                  // Safe to take action now
  'suggest_short',           // Prefer short/light interactions
  'defer_recommendation',    // Hold off on recommendations
  'explore_light',           // User can browse but don't push
  'avoid_heavy_decisions',   // No major decisions right now
  'focus_mode',              // User is concentrating
  'quiet_hours',             // Minimal disturbance
  'high_engagement_ok',      // User is ready for deep engagement
  'commerce_ok',             // Commerce recommendations allowed
  'commerce_deferred',       // Defer monetization
  'booking_ok',              // Booking flows allowed
  'booking_deferred'         // Defer booking flows
]);
export type SituationTag = z.infer<typeof SituationTag>;

// =============================================================================
// VTID-01126: Allowed Actions Envelope
// =============================================================================

/**
 * Allowed action in the envelope
 */
export interface AllowedAction {
  /** Action identifier */
  action: string;
  /** Action category */
  category: 'information' | 'suggestion' | 'action' | 'booking' | 'commerce' | 'notification';
  /** Confidence that this action is appropriate (0-100) */
  confidence: number;
  /** Reason why this action is allowed */
  reason: string;
  /** Priority within the envelope (1 = highest) */
  priority: number;
  /** Maximum interaction depth allowed */
  max_depth: 'light' | 'medium' | 'deep';
  /** Time limit for this action (minutes) */
  time_limit_minutes?: number;
}

/**
 * Situation-Aware Action Envelope
 * A ranked envelope of what the system is allowed to do now
 */
export interface ActionEnvelope {
  /** Allowed actions, ranked by priority */
  allowed_actions: AllowedAction[];
  /** Actions that are blocked in current situation */
  blocked_actions: Array<{
    action: string;
    reason: string;
    unblock_condition?: string;
  }>;
  /** Active situation tags */
  active_tags: SituationTag[];
  /** Overall envelope confidence (0-100) */
  envelope_confidence: number;
  /** When this envelope expires */
  expires_at: string;
  /** Reference to the situation vector used */
  vector_id: string;
}

// =============================================================================
// VTID-01126: Situational Awareness Bundle (Canonical Output)
// =============================================================================

/**
 * Complete Situational Awareness Bundle
 * This is the immutable output per turn from D32
 */
export interface SituationalAwarenessBundle {
  /** Unique bundle ID */
  bundle_id: string;
  /** Bundle hash for verification */
  bundle_hash: string;
  /** When this bundle was computed */
  computed_at: string;
  /** Computation duration in ms */
  computation_duration_ms: number;

  /** The situation vector */
  situation_vector: SituationVector;
  /** The action envelope */
  action_envelope: ActionEnvelope;

  /** User identification */
  user_id: string;
  tenant_id: string;
  session_id?: string;

  /** Input sources used */
  sources: {
    context_bundle_used: boolean;
    intent_bundle_used: boolean;
    signal_bundle_used: boolean;
    preference_bundle_used: boolean;
    calendar_used: boolean;
    location_used: boolean;
  };

  /** Metadata for traceability */
  metadata: {
    engine_version: string;
    determinism_key: string;
    input_hash: string;
  };

  /** Non-negotiable disclaimer */
  disclaimer: string;
}

// =============================================================================
// VTID-01126: Input Types
// =============================================================================

/**
 * Input for situational awareness computation
 */
export interface SituationalAwarenessInput {
  /** User identification */
  user_id: string;
  tenant_id: string;
  session_id?: string;

  /** Current message/query (optional) */
  current_message?: string;

  /** Context from D20 (optional) */
  context_bundle_id?: string;

  /** Intent from D21 (optional) */
  intent?: {
    primary_intent?: string;
    urgency_level?: string;
  };

  /** Signals from D28 (optional) */
  emotional_cognitive_signals?: {
    emotional_state?: string;
    cognitive_state?: string;
    engagement_level?: string;
    is_urgent?: boolean;
  };

  /** Preferences from D27 (optional) */
  preferences?: {
    communication_style?: string;
    autonomy_preference?: string;
    timing_constraints?: Array<{
      type: string;
      value: unknown;
    }>;
  };

  /** Health context (optional, non-diagnostic) */
  health_context?: {
    energy_level?: number;
    sleep_quality?: number;
    stress_level?: number;
  };

  /** Calendar hints (optional) */
  calendar_hints?: {
    next_event_in_minutes?: number;
    is_free_now?: boolean;
    busy_until?: string;
  };

  /** Location hints (optional) */
  location_hints?: {
    city?: string;
    country?: string;
    is_home?: boolean;
    is_traveling?: boolean;
  };

  /** User's timezone */
  timezone?: string;

  /** Explicit user-provided availability */
  explicit_availability?: AvailabilityLevel;

  /** Explicit user-provided constraints */
  explicit_constraints?: SituationalConstraintType[];
}

// =============================================================================
// VTID-01126: API Response Types
// =============================================================================

/**
 * Response from situational awareness computation
 */
export interface SituationalAwarenessResponse {
  ok: boolean;
  bundle?: SituationalAwarenessBundle;
  error?: string;
  message?: string;
}

/**
 * Response for action scoring
 */
export interface ActionScoringResponse {
  ok: boolean;
  scored_actions?: ScoredAction[];
  situation_vector?: SituationVector;
  error?: string;
}

/**
 * Response for situation override
 */
export interface SituationOverrideResponse {
  ok: boolean;
  message?: string;
  updated_vector?: SituationVector;
  error?: string;
}

// =============================================================================
// VTID-01126: Configuration
// =============================================================================

/**
 * Situational awareness configuration
 */
export interface SituationalAwarenessConfig {
  /** Minimum confidence to suggest action (0-100) */
  action_confidence_threshold: number;
  /** Minimum confidence for commerce recommendations (0-100) */
  commerce_confidence_threshold: number;
  /** Minimum confidence for booking flows (0-100) */
  booking_confidence_threshold: number;
  /** Default action envelope TTL (minutes) */
  envelope_ttl_minutes: number;
  /** Whether to defer on low confidence */
  defer_on_low_confidence: boolean;
  /** Late night hours (when to be extra conservative) */
  late_night_start_hour: number;
  late_night_end_hour: number;
}

/**
 * Default configuration
 */
export const DEFAULT_SITUATIONAL_CONFIG: SituationalAwarenessConfig = {
  action_confidence_threshold: 50,
  commerce_confidence_threshold: 70,
  booking_confidence_threshold: 65,
  envelope_ttl_minutes: 15,
  defer_on_low_confidence: true,
  late_night_start_hour: 22,
  late_night_end_hour: 6
};

// =============================================================================
// VTID-01126: Time Window Classification Constants
// =============================================================================

/**
 * Time window hour ranges
 */
export const TIME_WINDOW_RANGES: Record<TimeWindow, { start: number; end: number }> = {
  early_morning: { start: 5, end: 8 },
  morning: { start: 8, end: 12 },
  afternoon: { start: 12, end: 17 },
  evening: { start: 17, end: 21 },
  late_evening: { start: 21, end: 24 },
  night: { start: 0, end: 5 }
};

/**
 * Default energy levels by time window
 */
export const DEFAULT_ENERGY_BY_TIME: Record<TimeWindow, EnergyLevel> = {
  early_morning: 'moderate',
  morning: 'high',
  afternoon: 'moderate',
  evening: 'moderate',
  late_evening: 'low',
  night: 'depleted'
};

/**
 * Default readiness levels by time window
 */
export const DEFAULT_READINESS_BY_TIME: Record<TimeWindow, ReadinessLevel> = {
  early_morning: 'ready_for_exploration',
  morning: 'ready_for_action',
  afternoon: 'ready_for_action',
  evening: 'ready_for_exploration',
  late_evening: 'passive_only',
  night: 'resting'
};

// =============================================================================
// VTID-01126: ORB Integration Types
// =============================================================================

/**
 * Simplified situation context for ORB system prompt injection
 */
export interface OrbSituationContext {
  /** Current time window */
  time_window: TimeWindow;
  /** Is it late night? */
  is_late_night: boolean;
  /** Availability level */
  availability: AvailabilityLevel;
  /** Energy level */
  energy: EnergyLevel;
  /** Active situation tags */
  active_tags: SituationTag[];
  /** Key constraint flags */
  active_constraints: SituationalConstraintType[];
  /** Suggested interaction depth */
  suggested_depth: 'light' | 'medium' | 'deep';
  /** Overall confidence */
  confidence: number;
  /** Disclaimer */
  disclaimer: string;
}

/**
 * Convert SituationalAwarenessBundle to OrbSituationContext
 */
export function toOrbSituationContext(bundle: SituationalAwarenessBundle): OrbSituationContext {
  const activeConstraints = bundle.situation_vector.constraint_flags
    .filter(c => c.active)
    .map(c => c.type);

  // Determine suggested depth based on situation
  let suggestedDepth: 'light' | 'medium' | 'deep' = 'medium';
  if (bundle.action_envelope.active_tags.includes('suggest_short')) {
    suggestedDepth = 'light';
  } else if (bundle.action_envelope.active_tags.includes('high_engagement_ok')) {
    suggestedDepth = 'deep';
  }

  return {
    time_window: bundle.situation_vector.time_context.time_window,
    is_late_night: bundle.situation_vector.time_context.is_late_night,
    availability: bundle.situation_vector.availability_context.availability_level,
    energy: bundle.situation_vector.readiness_context.energy_level,
    active_tags: bundle.action_envelope.active_tags,
    active_constraints: activeConstraints,
    suggested_depth: suggestedDepth,
    confidence: bundle.situation_vector.overall_confidence,
    disclaimer: bundle.disclaimer
  };
}

/**
 * Format OrbSituationContext for system prompt injection
 */
export function formatSituationContextForPrompt(ctx: OrbSituationContext): string {
  const lines: string[] = [
    '## Current Situation (D32 Situational Awareness)',
    `[${ctx.disclaimer}]`,
    ''
  ];

  lines.push(`- Time: ${ctx.time_window.replace('_', ' ')}${ctx.is_late_night ? ' (late night)' : ''}`);
  lines.push(`- Availability: ${ctx.availability.replace('_', ' ')}`);
  lines.push(`- Energy: ${ctx.energy}`);
  lines.push(`- Confidence: ${ctx.confidence}%`);

  if (ctx.active_tags.length > 0) {
    lines.push('');
    lines.push('### Situation Tags');
    for (const tag of ctx.active_tags) {
      lines.push(`- ${tag.replace('_', ' ')}`);
    }
  }

  if (ctx.active_constraints.length > 0) {
    lines.push('');
    lines.push('### Active Constraints');
    for (const constraint of ctx.active_constraints) {
      lines.push(`- ${constraint.replace('_', ' ')}`);
    }
  }

  lines.push('');
  lines.push('### Interaction Guidance');
  lines.push(`- Suggested depth: ${ctx.suggested_depth}`);

  if (ctx.active_tags.includes('defer_recommendation')) {
    lines.push('- Defer proactive recommendations');
  }
  if (ctx.active_tags.includes('avoid_heavy_decisions')) {
    lines.push('- Avoid pushing major decisions');
  }
  if (ctx.active_tags.includes('commerce_deferred')) {
    lines.push('- Defer commerce/monetization');
  }

  return lines.join('\n');
}
