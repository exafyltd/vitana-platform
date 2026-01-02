/**
 * VTID-01126: D32 Situational Awareness Engine
 *
 * Deterministic engine that understands the user's current situation,
 * not just their words.
 *
 * This engine answers: "What is realistically appropriate for this user right now?"
 *
 * Core Capabilities:
 * 1. Situation Vector Assembly - Build a Situation Vector from available signals
 * 2. Situational Appropriateness Scoring - Score actions against the situation
 * 3. Action Envelope Generation - Output what the system is allowed to do now
 *
 * Hard Constraints (Non-Negotiable):
 * - Never assume availability if unknown
 * - Prefer light suggestions when uncertainty is high
 * - Defer monetization if situation confidence < threshold
 * - Respect safety, health, and privacy constraints by default
 * - Situational inference must be reversible (can be corrected by user)
 *
 * Determinism Requirements:
 * - Same inputs -> same outputs
 * - No randomness at this layer
 * - Keyword/rule-based inference only
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  SituationalAwarenessBundle,
  SituationalAwarenessInput,
  SituationalAwarenessResponse,
  SituationVector,
  TimeContext,
  LocationContext,
  AvailabilityContext,
  EnergyReadinessContext,
  ConstraintFlag,
  ActionEnvelope,
  AllowedAction,
  ScoredAction,
  ActionScoringResponse,
  SituationOverrideResponse,
  SituationTag,
  TimeWindow,
  DayType,
  LocationType,
  EnvironmentType,
  AvailabilityLevel,
  EnergyLevel,
  ReadinessLevel,
  SituationalConstraintType,
  AppropriatenessLevel,
  AppropriatenessFactor,
  OrbSituationContext,
  toOrbSituationContext,
  formatSituationContextForPrompt,
  DEFAULT_SITUATIONAL_CONFIG,
  TIME_WINDOW_RANGES,
  DEFAULT_ENERGY_BY_TIME,
  DEFAULT_READINESS_BY_TIME
} from '../types/situational-awareness';

// =============================================================================
// VTID-01126: Constants
// =============================================================================

const VTID = 'VTID-01126';
const LOG_PREFIX = '[D32-Engine]';
const ENGINE_VERSION = '1.0.0';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

/**
 * Non-negotiable disclaimer
 */
const SITUATION_DISCLAIMER = 'Situational context is inferred from available signals and may not reflect actual circumstances. User corrections override inferences.';

// =============================================================================
// VTID-01126: Environment Detection
// =============================================================================

function isDevSandbox(): boolean {
  const env = (process.env.ENVIRONMENT || process.env.VITANA_ENV || '').toLowerCase();
  return env === 'dev-sandbox' ||
         env === 'dev' ||
         env === 'development' ||
         env === 'sandbox' ||
         env.includes('dev') ||
         env.includes('sandbox');
}

// =============================================================================
// VTID-01126: Supabase Client
// =============================================================================

let _supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
  if (_supabaseClient) return _supabaseClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    return null;
  }

  _supabaseClient = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  return _supabaseClient;
}

// =============================================================================
// VTID-01126: Time Context Assembly
// =============================================================================

/**
 * Classify hour into time window
 */
function classifyTimeWindow(hour: number): TimeWindow {
  if (hour >= 5 && hour < 8) return 'early_morning';
  if (hour >= 8 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  if (hour >= 21 && hour < 24) return 'late_evening';
  return 'night'; // 0-5
}

/**
 * Classify day type
 */
function classifyDayType(dayOfWeek: number): DayType {
  return (dayOfWeek === 0 || dayOfWeek === 6) ? 'weekend' : 'weekday';
}

/**
 * Assemble time context from available signals
 */
function assembleTimeContext(input: SituationalAwarenessInput): TimeContext {
  const now = new Date();

  // Use provided timezone or default to UTC
  const timezone = input.timezone || 'UTC';

  // Get local time components
  let localTime: Date;
  try {
    // Create a formatter for the timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    // Parse the formatted date parts
    const parts = formatter.formatToParts(now);
    const values: Record<string, string> = {};
    for (const part of parts) {
      values[part.type] = part.value;
    }

    const hour = parseInt(values.hour, 10);
    const minute = parseInt(values.minute, 10);
    const dayOfWeek = now.getDay(); // Approximation - may not be accurate for all timezones

    const timeWindow = classifyTimeWindow(hour);
    const dayType = classifyDayType(dayOfWeek);

    return {
      local_time: now.toISOString(),
      hour,
      day_of_week: dayOfWeek,
      time_window: timeWindow,
      day_type: dayType,
      minutes_since_midnight: hour * 60 + minute,
      is_likely_work_hours: dayType === 'weekday' && hour >= 9 && hour < 17,
      is_late_night: hour >= 22 || hour < 6,
      is_early_morning: hour >= 5 && hour < 8,
      timezone,
      confidence: timezone !== 'UTC' ? 90 : 70 // Higher confidence if timezone provided
    };
  } catch {
    // Fallback to UTC
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const dayOfWeek = now.getUTCDay();
    const timeWindow = classifyTimeWindow(hour);
    const dayType = classifyDayType(dayOfWeek);

    return {
      local_time: now.toISOString(),
      hour,
      day_of_week: dayOfWeek,
      time_window: timeWindow,
      day_type: dayType,
      minutes_since_midnight: hour * 60 + minute,
      is_likely_work_hours: dayType === 'weekday' && hour >= 9 && hour < 17,
      is_late_night: hour >= 22 || hour < 6,
      is_early_morning: hour >= 5 && hour < 8,
      timezone: 'UTC',
      confidence: 60 // Lower confidence when using UTC fallback
    };
  }
}

// =============================================================================
// VTID-01126: Location Context Assembly
// =============================================================================

/**
 * Assemble location context from available signals
 */
function assembleLocationContext(input: SituationalAwarenessInput): LocationContext {
  const hints = input.location_hints;

  if (!hints) {
    return {
      location_type: 'unknown',
      environment_type: 'unknown',
      is_traveling: false,
      confidence: 0
    };
  }

  let locationType: LocationType = 'unknown';
  let confidence = 30;

  if (hints.is_home !== undefined) {
    locationType = hints.is_home ? 'home' : 'unknown';
    confidence = hints.is_home ? 80 : 40;
  }

  if (hints.is_traveling !== undefined && hints.is_traveling) {
    locationType = 'travel';
    confidence = 75;
  }

  return {
    city: hints.city,
    country: hints.country,
    location_type: locationType,
    environment_type: 'unknown', // Would need more signals to determine
    is_traveling: hints.is_traveling ?? false,
    confidence
  };
}

// =============================================================================
// VTID-01126: Availability Context Assembly
// =============================================================================

/**
 * Assemble availability context from available signals
 */
function assembleAvailabilityContext(input: SituationalAwarenessInput): AvailabilityContext {
  // Use explicit availability if provided
  if (input.explicit_availability) {
    return {
      availability_level: input.explicit_availability,
      interaction_mode: input.explicit_availability === 'free' ? 'long' :
                       input.explicit_availability === 'busy' ? 'quick' : 'normal',
      has_calendar_data: false,
      has_free_blocks_today: input.explicit_availability === 'free',
      confidence: 95 // High confidence for explicit input
    };
  }

  // Use calendar hints if available
  const calendar = input.calendar_hints;
  if (calendar) {
    let availabilityLevel: AvailabilityLevel = 'unknown';
    let interactionMode: InteractionMode = 'normal';
    let confidence = 60;

    if (calendar.is_free_now !== undefined) {
      if (calendar.is_free_now) {
        availabilityLevel = 'free';
        interactionMode = 'long';
        confidence = 80;
      } else {
        availabilityLevel = 'busy';
        interactionMode = 'quick';
        confidence = 80;
      }
    }

    if (calendar.next_event_in_minutes !== undefined) {
      if (calendar.next_event_in_minutes < 15) {
        availabilityLevel = 'very_busy';
        interactionMode = 'quick';
        confidence = 85;
      } else if (calendar.next_event_in_minutes < 30) {
        availabilityLevel = 'busy';
        interactionMode = 'quick';
        confidence = 80;
      } else if (calendar.next_event_in_minutes < 60) {
        availabilityLevel = 'lightly_busy';
        interactionMode = 'normal';
        confidence = 75;
      }
    }

    return {
      availability_level: availabilityLevel,
      interaction_mode: interactionMode,
      has_calendar_data: true,
      minutes_until_next_commitment: calendar.next_event_in_minutes,
      has_free_blocks_today: calendar.is_free_now ?? false,
      estimated_available_minutes: calendar.next_event_in_minutes,
      confidence
    };
  }

  // No availability data - default to unknown
  return {
    availability_level: 'unknown',
    interaction_mode: 'unknown',
    has_calendar_data: false,
    has_free_blocks_today: false,
    confidence: 0
  };
}

type InteractionMode = 'quick' | 'normal' | 'long' | 'unknown';

// =============================================================================
// VTID-01126: Energy & Readiness Context Assembly
// =============================================================================

/**
 * Assemble energy and readiness context from available signals
 */
function assembleEnergyReadinessContext(
  input: SituationalAwarenessInput,
  timeContext: TimeContext
): EnergyReadinessContext {
  let energyLevel: EnergyLevel = 'unknown';
  let readinessLevel: ReadinessLevel = 'unknown';
  let inferredFromTime = false;
  let inferredFromSignals = false;
  let inferredFromHealth = false;
  let confidence = 0;

  // Check health context first (highest priority for energy)
  if (input.health_context?.energy_level !== undefined) {
    const healthEnergy = input.health_context.energy_level;
    if (healthEnergy >= 80) energyLevel = 'high';
    else if (healthEnergy >= 60) energyLevel = 'moderate';
    else if (healthEnergy >= 40) energyLevel = 'low';
    else energyLevel = 'depleted';
    inferredFromHealth = true;
    confidence = Math.min(healthEnergy, 85); // Cap at 85 for inferred values
  }

  // Check emotional/cognitive signals
  if (input.emotional_cognitive_signals) {
    const signals = input.emotional_cognitive_signals;

    // Adjust energy based on cognitive state
    if (signals.cognitive_state === 'fatigued') {
      energyLevel = energyLevel === 'unknown' ? 'low' : energyLevel;
      if (energyLevel === 'high') energyLevel = 'moderate';
      inferredFromSignals = true;
    } else if (signals.cognitive_state === 'focused' || signals.cognitive_state === 'engaged') {
      if (energyLevel === 'unknown') energyLevel = 'moderate';
      inferredFromSignals = true;
    }

    // Determine readiness based on engagement
    if (signals.engagement_level === 'high') {
      readinessLevel = 'ready_for_action';
      confidence = Math.max(confidence, 70);
    } else if (signals.engagement_level === 'medium') {
      readinessLevel = 'ready_for_exploration';
      confidence = Math.max(confidence, 60);
    } else if (signals.engagement_level === 'low') {
      readinessLevel = 'passive_only';
      confidence = Math.max(confidence, 50);
    }
  }

  // Fall back to time-based defaults if still unknown
  if (energyLevel === 'unknown') {
    energyLevel = DEFAULT_ENERGY_BY_TIME[timeContext.time_window];
    inferredFromTime = true;
    confidence = Math.max(confidence, 40); // Lower confidence for time-based inference
  }

  if (readinessLevel === 'unknown') {
    readinessLevel = DEFAULT_READINESS_BY_TIME[timeContext.time_window];
    inferredFromTime = true;
    if (confidence === 0) confidence = 40;
  }

  return {
    energy_level: energyLevel,
    readiness_level: readinessLevel,
    inferred_from_time: inferredFromTime,
    inferred_from_signals: inferredFromSignals,
    inferred_from_health: inferredFromHealth,
    recent_interaction_count: 0, // Would need session data
    minutes_since_last_interaction: undefined,
    confidence
  };
}

// =============================================================================
// VTID-01126: Constraint Flags Assembly
// =============================================================================

/**
 * Assemble constraint flags from available signals
 */
function assembleConstraintFlags(
  input: SituationalAwarenessInput,
  timeContext: TimeContext,
  energyContext: EnergyReadinessContext
): ConstraintFlag[] {
  const flags: ConstraintFlag[] = [];

  // Add explicit constraints
  if (input.explicit_constraints) {
    for (const constraintType of input.explicit_constraints) {
      flags.push({
        type: constraintType,
        active: true,
        confidence: 100,
        source: 'explicit',
        description: `User-specified: ${constraintType.replace('_', ' ')}`
      });
    }
  }

  // Add time-based constraints
  if (timeContext.is_late_night) {
    flags.push({
      type: 'quiet_mode',
      active: true,
      confidence: 70,
      source: 'inferred',
      description: 'Late night - prefer minimal disturbance'
    });
  }

  // Add energy-based constraints
  if (energyContext.energy_level === 'depleted' || energyContext.energy_level === 'low') {
    flags.push({
      type: 'focus_mode',
      active: false, // Not active but noted
      confidence: 50,
      source: 'inferred',
      description: 'Low energy detected - avoid demanding tasks'
    });
  }

  // Add health-based constraints
  if (input.health_context?.stress_level !== undefined && input.health_context.stress_level > 70) {
    flags.push({
      type: 'health_constraint',
      active: true,
      confidence: 60,
      source: 'health',
      description: 'Elevated stress - prefer calming interactions'
    });
  }

  // Add urgency-based constraints
  if (input.emotional_cognitive_signals?.is_urgent) {
    flags.push({
      type: 'time_pressure',
      active: true,
      confidence: 80,
      source: 'inferred',
      description: 'User has expressed time pressure'
    });
  }

  // Add preference-based constraints
  if (input.preferences?.timing_constraints) {
    for (const tc of input.preferences.timing_constraints) {
      if (tc.type === 'quiet_hours') {
        flags.push({
          type: 'quiet_mode',
          active: true,
          confidence: 90,
          source: 'scheduled',
          description: 'Scheduled quiet hours active'
        });
      }
    }
  }

  return flags;
}

// =============================================================================
// VTID-01126: Situation Vector Assembly
// =============================================================================

/**
 * Assemble complete Situation Vector
 * DETERMINISTIC: Same inputs -> same output
 */
function assembleSituationVector(input: SituationalAwarenessInput): SituationVector {
  const timeContext = assembleTimeContext(input);
  const locationContext = assembleLocationContext(input);
  const availabilityContext = assembleAvailabilityContext(input);
  const energyReadinessContext = assembleEnergyReadinessContext(input, timeContext);
  const constraintFlags = assembleConstraintFlags(input, timeContext, energyReadinessContext);

  // Calculate overall confidence as weighted average
  const confidences = [
    { value: timeContext.confidence, weight: 0.25 },
    { value: locationContext.confidence, weight: 0.15 },
    { value: availabilityContext.confidence, weight: 0.30 },
    { value: energyReadinessContext.confidence, weight: 0.30 }
  ];

  const totalWeight = confidences.reduce((sum, c) => sum + c.weight, 0);
  const weightedSum = confidences.reduce((sum, c) => sum + c.value * c.weight, 0);
  const overallConfidence = Math.round(weightedSum / totalWeight);

  const vectorId = `sv_${Date.now()}_${input.user_id.substring(0, 8)}`;

  return {
    time_context: timeContext,
    location_context: locationContext,
    availability_context: availabilityContext,
    readiness_context: energyReadinessContext,
    constraint_flags: constraintFlags,
    overall_confidence: overallConfidence,
    computed_at: new Date().toISOString(),
    vector_id: vectorId
  };
}

// =============================================================================
// VTID-01126: Situation Tags Generation
// =============================================================================

/**
 * Generate situation tags based on the situation vector
 */
function generateSituationTags(vector: SituationVector): SituationTag[] {
  const tags: SituationTag[] = [];
  const config = DEFAULT_SITUATIONAL_CONFIG;

  // Determine if action is OK now
  if (vector.overall_confidence >= config.action_confidence_threshold) {
    tags.push('now_ok');
  }

  // Check for short interaction preference
  if (
    vector.availability_context.interaction_mode === 'quick' ||
    vector.readiness_context.energy_level === 'low' ||
    vector.readiness_context.energy_level === 'depleted' ||
    vector.time_context.is_late_night
  ) {
    tags.push('suggest_short');
  }

  // Check for high engagement readiness
  if (
    vector.availability_context.availability_level === 'free' &&
    vector.readiness_context.energy_level === 'high' &&
    vector.readiness_context.readiness_level === 'ready_for_action'
  ) {
    tags.push('high_engagement_ok');
  }

  // Check for recommendation deferral
  if (
    vector.overall_confidence < config.action_confidence_threshold ||
    vector.time_context.is_late_night ||
    vector.readiness_context.readiness_level === 'resting'
  ) {
    tags.push('defer_recommendation');
  }

  // Check for light exploration mode
  if (
    vector.readiness_context.readiness_level === 'ready_for_exploration' ||
    vector.readiness_context.readiness_level === 'passive_only'
  ) {
    tags.push('explore_light');
  }

  // Check for avoiding heavy decisions
  if (
    vector.time_context.is_late_night ||
    vector.readiness_context.energy_level === 'depleted' ||
    vector.readiness_context.energy_level === 'low' ||
    vector.constraint_flags.some(f => f.type === 'health_constraint' && f.active)
  ) {
    tags.push('avoid_heavy_decisions');
  }

  // Check for focus mode
  if (vector.constraint_flags.some(f => f.type === 'focus_mode' && f.active)) {
    tags.push('focus_mode');
  }

  // Check for quiet hours
  if (
    vector.time_context.is_late_night ||
    vector.constraint_flags.some(f => f.type === 'quiet_mode' && f.active)
  ) {
    tags.push('quiet_hours');
  }

  // Check for commerce appropriateness
  if (
    vector.overall_confidence >= config.commerce_confidence_threshold &&
    !vector.time_context.is_late_night &&
    vector.readiness_context.readiness_level !== 'resting' &&
    vector.readiness_context.readiness_level !== 'passive_only'
  ) {
    tags.push('commerce_ok');
  } else {
    tags.push('commerce_deferred');
  }

  // Check for booking appropriateness
  if (
    vector.overall_confidence >= config.booking_confidence_threshold &&
    vector.availability_context.availability_level !== 'very_busy' &&
    vector.readiness_context.readiness_level === 'ready_for_action'
  ) {
    tags.push('booking_ok');
  } else {
    tags.push('booking_deferred');
  }

  return tags;
}

// =============================================================================
// VTID-01126: Action Envelope Generation
// =============================================================================

/**
 * Generate the action envelope based on situation vector
 */
function generateActionEnvelope(vector: SituationVector): ActionEnvelope {
  const tags = generateSituationTags(vector);
  const config = DEFAULT_SITUATIONAL_CONFIG;

  const allowedActions: AllowedAction[] = [];
  const blockedActions: Array<{ action: string; reason: string; unblock_condition?: string }> = [];

  // Information actions are always allowed
  allowedActions.push({
    action: 'provide_information',
    category: 'information',
    confidence: 95,
    reason: 'Information requests are always appropriate',
    priority: 1,
    max_depth: tags.includes('suggest_short') ? 'light' : 'medium'
  });

  // Suggestions based on tags
  if (tags.includes('now_ok') || tags.includes('explore_light')) {
    allowedActions.push({
      action: 'make_suggestion',
      category: 'suggestion',
      confidence: vector.overall_confidence,
      reason: 'User situation allows for suggestions',
      priority: 2,
      max_depth: tags.includes('suggest_short') ? 'light' : 'medium',
      time_limit_minutes: tags.includes('suggest_short') ? 5 : undefined
    });
  } else {
    blockedActions.push({
      action: 'make_suggestion',
      reason: 'Low situation confidence - defer suggestions',
      unblock_condition: 'Wait for higher confidence or explicit request'
    });
  }

  // Actions based on readiness
  if (tags.includes('high_engagement_ok')) {
    allowedActions.push({
      action: 'take_action',
      category: 'action',
      confidence: vector.overall_confidence,
      reason: 'User is ready for active engagement',
      priority: 3,
      max_depth: 'deep'
    });
  } else if (!tags.includes('avoid_heavy_decisions')) {
    allowedActions.push({
      action: 'take_action',
      category: 'action',
      confidence: Math.max(vector.overall_confidence - 10, 40),
      reason: 'Light actions permitted',
      priority: 3,
      max_depth: 'light'
    });
  } else {
    blockedActions.push({
      action: 'take_action',
      reason: 'User situation indicates heavy decisions should be avoided',
      unblock_condition: 'Wait for better energy/availability'
    });
  }

  // Booking based on tags
  if (tags.includes('booking_ok')) {
    allowedActions.push({
      action: 'initiate_booking',
      category: 'booking',
      confidence: vector.overall_confidence,
      reason: 'User availability and readiness support booking',
      priority: 4,
      max_depth: 'medium'
    });
  } else {
    blockedActions.push({
      action: 'initiate_booking',
      reason: 'Booking deferred due to availability/readiness constraints',
      unblock_condition: 'Wait for confirmed availability'
    });
  }

  // Commerce based on tags
  if (tags.includes('commerce_ok')) {
    allowedActions.push({
      action: 'commerce_recommendation',
      category: 'commerce',
      confidence: vector.overall_confidence,
      reason: 'Situation confidence meets commerce threshold',
      priority: 5,
      max_depth: 'medium'
    });
  } else {
    blockedActions.push({
      action: 'commerce_recommendation',
      reason: 'Commerce/monetization deferred due to situation constraints',
      unblock_condition: 'Higher confidence or explicit user request'
    });
  }

  // Notifications based on quiet mode
  if (!tags.includes('quiet_hours')) {
    allowedActions.push({
      action: 'send_notification',
      category: 'notification',
      confidence: vector.overall_confidence,
      reason: 'Not in quiet hours',
      priority: 6,
      max_depth: 'light'
    });
  } else {
    blockedActions.push({
      action: 'send_notification',
      reason: 'Quiet hours - notifications deferred',
      unblock_condition: 'Wait for quiet hours to end'
    });
  }

  // Calculate envelope expiration
  const expiresAt = new Date(Date.now() + config.envelope_ttl_minutes * 60 * 1000).toISOString();

  return {
    allowed_actions: allowedActions.sort((a, b) => a.priority - b.priority),
    blocked_actions: blockedActions,
    active_tags: tags,
    envelope_confidence: vector.overall_confidence,
    expires_at: expiresAt,
    vector_id: vector.vector_id
  };
}

// =============================================================================
// VTID-01126: Bundle Hash Generation
// =============================================================================

/**
 * Generate deterministic hash for situational awareness bundle
 */
function generateBundleHash(
  vectorId: string,
  userId: string,
  computedAt: string
): string {
  const hashInput = JSON.stringify({
    vector_id: vectorId,
    user_id: userId,
    computed_at: computedAt
  });

  return createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
}

/**
 * Generate determinism key for verification
 */
function generateDeterminismKey(input: SituationalAwarenessInput): string {
  const key = JSON.stringify({
    user_id: input.user_id,
    tenant_id: input.tenant_id,
    timezone: input.timezone || 'UTC',
    explicit_availability: input.explicit_availability || null,
    explicit_constraints: input.explicit_constraints?.sort() || []
  });

  return createHash('sha256').update(key).digest('hex').substring(0, 12);
}

// =============================================================================
// VTID-01126: Main Entry Points
// =============================================================================

/**
 * Compute situational awareness bundle
 *
 * This is the MAIN ENTRY POINT for situational awareness.
 * All downstream intelligence should call this to understand the user's situation.
 *
 * DETERMINISTIC: Same inputs -> same output
 */
export async function computeSituationalAwareness(
  input: SituationalAwarenessInput
): Promise<SituationalAwarenessResponse> {
  const startTime = Date.now();
  const computedAt = new Date().toISOString();

  console.log(`${LOG_PREFIX} Computing situational awareness for user ${input.user_id.substring(0, 8)}...`);

  try {
    // Assemble situation vector
    const situationVector = assembleSituationVector(input);

    // Generate action envelope
    const actionEnvelope = generateActionEnvelope(situationVector);

    // Generate bundle metadata
    const bundleId = `sa_${Date.now()}_${input.user_id.substring(0, 8)}`;
    const bundleHash = generateBundleHash(situationVector.vector_id, input.user_id, computedAt);
    const determinismKey = generateDeterminismKey(input);
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex').substring(0, 12);

    // Build the complete bundle
    const bundle: SituationalAwarenessBundle = {
      bundle_id: bundleId,
      bundle_hash: bundleHash,
      computed_at: computedAt,
      computation_duration_ms: Date.now() - startTime,
      situation_vector: situationVector,
      action_envelope: actionEnvelope,
      user_id: input.user_id,
      tenant_id: input.tenant_id,
      session_id: input.session_id,
      sources: {
        context_bundle_used: !!input.context_bundle_id,
        intent_bundle_used: !!input.intent,
        signal_bundle_used: !!input.emotional_cognitive_signals,
        preference_bundle_used: !!input.preferences,
        calendar_used: !!input.calendar_hints,
        location_used: !!input.location_hints
      },
      metadata: {
        engine_version: ENGINE_VERSION,
        determinism_key: determinismKey,
        input_hash: inputHash
      },
      disclaimer: SITUATION_DISCLAIMER
    };

    console.log(`${LOG_PREFIX} Computed bundle ${bundleId} in ${bundle.computation_duration_ms}ms (confidence: ${situationVector.overall_confidence}%)`);

    // Emit OASIS event for traceability
    await emitOasisEvent({
      vtid: VTID,
      type: 'd32.situational.awareness.computed' as any,
      source: 'gateway-d32',
      status: 'success',
      message: `Situational awareness computed: confidence=${situationVector.overall_confidence}%`,
      payload: {
        bundle_id: bundleId,
        bundle_hash: bundleHash,
        user_id: input.user_id,
        tenant_id: input.tenant_id,
        overall_confidence: situationVector.overall_confidence,
        time_window: situationVector.time_context.time_window,
        availability: situationVector.availability_context.availability_level,
        energy: situationVector.readiness_context.energy_level,
        active_tags: actionEnvelope.active_tags,
        duration_ms: bundle.computation_duration_ms
      }
    }).catch(err => console.warn(`${LOG_PREFIX} OASIS event failed:`, err.message));

    return { ok: true, bundle };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing situational awareness:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd32.situational.awareness.failed' as any,
      source: 'gateway-d32',
      status: 'error',
      message: `Situational awareness computation failed: ${errorMessage}`,
      payload: { error: errorMessage, user_id: input.user_id }
    }).catch(() => {});

    return { ok: false, error: errorMessage };
  }
}

/**
 * Score a list of candidate actions against the current situation
 *
 * Every candidate action/recommendation must be scored against the situation:
 * - Appropriate now
 * - Better later
 * - Not appropriate
 */
export async function scoreActions(
  actions: Array<{ action: string; action_type: string; domain?: string }>,
  input: SituationalAwarenessInput
): Promise<ActionScoringResponse> {
  try {
    // First compute the situation
    const situationVector = assembleSituationVector(input);
    const tags = generateSituationTags(situationVector);

    const scoredActions: ScoredAction[] = [];

    for (const action of actions) {
      const factors: AppropriatenessFactor[] = [];
      let appropriateness: AppropriatenessLevel = 'appropriate_now';
      let confidence = situationVector.overall_confidence;
      let reason = '';

      // Score based on action type
      switch (action.action_type) {
        case 'booking':
          if (tags.includes('booking_ok')) {
            factors.push({
              factor: 'availability',
              impact: 'positive',
              weight: 0.4,
              description: 'User has sufficient availability'
            });
          } else {
            appropriateness = 'better_later';
            confidence = Math.max(confidence - 20, 30);
            reason = 'User availability or readiness is insufficient for booking';
            factors.push({
              factor: 'availability',
              impact: 'negative',
              weight: 0.4,
              description: 'User is too busy or not ready for booking'
            });
          }
          break;

        case 'purchase':
          if (tags.includes('commerce_ok')) {
            factors.push({
              factor: 'commerce_appropriate',
              impact: 'positive',
              weight: 0.5,
              description: 'Situation supports commerce'
            });
          } else {
            appropriateness = 'better_later';
            confidence = Math.max(confidence - 25, 25);
            reason = 'Commerce deferred due to situation constraints';
            factors.push({
              factor: 'commerce_appropriate',
              impact: 'negative',
              weight: 0.5,
              description: 'Situation does not support commerce right now'
            });
          }
          break;

        case 'recommendation':
          if (tags.includes('defer_recommendation')) {
            appropriateness = 'better_later';
            confidence = Math.max(confidence - 15, 35);
            reason = 'Recommendations should be deferred';
            factors.push({
              factor: 'timing',
              impact: 'negative',
              weight: 0.3,
              description: 'Current timing is not ideal for recommendations'
            });
          } else {
            factors.push({
              factor: 'timing',
              impact: 'positive',
              weight: 0.3,
              description: 'Good timing for recommendations'
            });
          }
          break;

        case 'notification':
          if (tags.includes('quiet_hours')) {
            appropriateness = 'not_appropriate';
            confidence = 85;
            reason = 'Quiet hours active - notifications blocked';
            factors.push({
              factor: 'quiet_mode',
              impact: 'negative',
              weight: 0.8,
              description: 'User is in quiet mode'
            });
          }
          break;

        default:
          // Default scoring for unknown action types
          if (tags.includes('now_ok')) {
            factors.push({
              factor: 'general_availability',
              impact: 'positive',
              weight: 0.5,
              description: 'General situation is favorable'
            });
          }
      }

      // Add time-based factors
      if (situationVector.time_context.is_late_night) {
        factors.push({
          factor: 'time_of_day',
          impact: 'negative',
          weight: 0.2,
          description: 'Late night - prefer lighter interactions'
        });
        if (action.action_type !== 'information') {
          if (appropriateness === 'appropriate_now') {
            appropriateness = 'better_later';
          }
          confidence = Math.max(confidence - 10, 30);
        }
      }

      // Add energy-based factors
      if (situationVector.readiness_context.energy_level === 'depleted') {
        factors.push({
          factor: 'energy_level',
          impact: 'negative',
          weight: 0.3,
          description: 'User energy is depleted'
        });
        if (action.action_type !== 'information') {
          if (appropriateness === 'appropriate_now') {
            appropriateness = 'better_later';
          }
        }
      } else if (situationVector.readiness_context.energy_level === 'high') {
        factors.push({
          factor: 'energy_level',
          impact: 'positive',
          weight: 0.3,
          description: 'User energy is high'
        });
      }

      // Build reason if not already set
      if (!reason) {
        if (appropriateness === 'appropriate_now') {
          reason = 'Situation is favorable for this action';
        } else if (appropriateness === 'better_later') {
          reason = 'Current situation suggests deferring this action';
        } else {
          reason = 'Action is not appropriate in current situation';
        }
      }

      scoredActions.push({
        action: action.action,
        action_type: action.action_type as any,
        domain: action.domain as any,
        appropriateness,
        confidence,
        reason,
        factors,
        lighter_alternative: appropriateness !== 'appropriate_now' ?
          `Consider a lighter version of "${action.action}"` : undefined
      });
    }

    return {
      ok: true,
      scored_actions: scoredActions,
      situation_vector: situationVector
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error scoring actions:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Override a situational inference with user correction
 *
 * User corrections immediately override inferred state (spec requirement).
 * Situational inference must be reversible.
 */
export async function overrideSituation(
  userId: string,
  tenantId: string,
  overrides: {
    availability_level?: AvailabilityLevel;
    energy_level?: EnergyLevel;
    constraints?: SituationalConstraintType[];
    clear_constraints?: boolean;
  }
): Promise<SituationOverrideResponse> {
  console.log(`${LOG_PREFIX} Processing situation override for user ${userId.substring(0, 8)}...`);

  try {
    // Build input with explicit overrides
    const input: SituationalAwarenessInput = {
      user_id: userId,
      tenant_id: tenantId,
      explicit_availability: overrides.availability_level,
      explicit_constraints: overrides.clear_constraints ? [] : overrides.constraints
    };

    // Recompute with overrides
    const result = await computeSituationalAwareness(input);

    if (!result.ok || !result.bundle) {
      return { ok: false, error: result.error || 'Failed to recompute with overrides' };
    }

    // Emit override event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd32.situation.overridden' as any,
      source: 'gateway-d32',
      status: 'info',
      message: `Situation overridden by user correction`,
      payload: {
        user_id: userId,
        tenant_id: tenantId,
        overrides
      }
    }).catch(() => {});

    return {
      ok: true,
      message: 'Situation updated with user overrides',
      updated_vector: result.bundle.situation_vector
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error overriding situation:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

// =============================================================================
// VTID-01126: ORB Integration Functions
// =============================================================================

/**
 * Get situation context for ORB system prompt injection
 *
 * This function computes situational awareness and formats it for
 * injection into the ORB system prompt.
 */
export async function getOrbSituationContext(
  input: SituationalAwarenessInput
): Promise<{ context: string; orbContext: OrbSituationContext; bundleId: string } | null> {
  try {
    const result = await computeSituationalAwareness(input);

    if (!result.ok || !result.bundle) {
      console.warn(`${LOG_PREFIX} Failed to compute situational awareness for ORB`);
      return null;
    }

    const orbContext = toOrbSituationContext(result.bundle);
    const context = formatSituationContextForPrompt(orbContext);

    return {
      context,
      orbContext,
      bundleId: result.bundle.bundle_id
    };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error getting ORB situation context:`, error);
    return null;
  }
}

/**
 * Process a turn and get complete situational context for ORB
 *
 * Convenience function that combines all inputs and returns formatted context.
 */
export async function processTurnForOrb(
  userId: string,
  tenantId: string,
  sessionId?: string,
  message?: string,
  emotionalSignals?: SituationalAwarenessInput['emotional_cognitive_signals'],
  timezone?: string
): Promise<{ context: string; orbContext: OrbSituationContext; bundleId: string } | null> {
  return getOrbSituationContext({
    user_id: userId,
    tenant_id: tenantId,
    session_id: sessionId,
    current_message: message,
    emotional_cognitive_signals: emotionalSignals,
    timezone
  });
}

// =============================================================================
// VTID-01126: Verification Functions
// =============================================================================

/**
 * Verify situational awareness bundle integrity
 */
export function verifyBundleIntegrity(bundle: SituationalAwarenessBundle): boolean {
  const expectedHash = generateBundleHash(
    bundle.situation_vector.vector_id,
    bundle.user_id,
    bundle.computed_at
  );
  return expectedHash === bundle.bundle_hash;
}

/**
 * Verify determinism of situational awareness computation
 */
export async function verifyDeterminism(
  input: SituationalAwarenessInput
): Promise<{ match: boolean; differences: string[] }> {
  const result1 = await computeSituationalAwareness(input);
  const result2 = await computeSituationalAwareness(input);

  const differences: string[] = [];

  if (!result1.ok || !result2.ok) {
    differences.push('One or both computations failed');
    return { match: false, differences };
  }

  const bundle1 = result1.bundle!;
  const bundle2 = result2.bundle!;

  if (bundle1.metadata.determinism_key !== bundle2.metadata.determinism_key) {
    differences.push('Determinism key mismatch');
  }

  if (bundle1.situation_vector.overall_confidence !== bundle2.situation_vector.overall_confidence) {
    differences.push('Overall confidence mismatch');
  }

  const tags1 = bundle1.action_envelope.active_tags.sort().join(',');
  const tags2 = bundle2.action_envelope.active_tags.sort().join(',');
  if (tags1 !== tags2) {
    differences.push('Active tags mismatch');
  }

  return {
    match: differences.length === 0,
    differences
  };
}

// =============================================================================
// VTID-01126: Exports
// =============================================================================

export {
  toOrbSituationContext,
  formatSituationContextForPrompt
};

export type {
  SituationalAwarenessBundle,
  SituationalAwarenessInput,
  SituationalAwarenessResponse,
  SituationVector,
  TimeContext,
  LocationContext,
  AvailabilityContext,
  EnergyReadinessContext,
  ConstraintFlag,
  ActionEnvelope,
  AllowedAction,
  ScoredAction,
  ActionScoringResponse,
  SituationOverrideResponse,
  OrbSituationContext
};

export {
  VTID,
  ENGINE_VERSION,
  DEFAULT_SITUATIONAL_CONFIG
};
