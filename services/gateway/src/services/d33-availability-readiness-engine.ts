/**
 * VTID-01127: D33 Availability, Time-Window & Readiness Engine
 *
 * Determines how much and how deep the system should act right now.
 * Refines situational awareness into action depth control.
 *
 * Core question: "Is this a moment for a quick nudge, a short flow, or a deep engagement?"
 *
 * Prevents:
 *   - Cognitive overload
 *   - Mistimed prompts
 *   - Premature monetization
 *
 * Hard Constraints (Non-Negotiable):
 *   - Default to LOWER depth when uncertain
 *   - Never stack multiple asks in low availability
 *   - Monetization requires readiness_score >= threshold
 *   - User overrides always win immediately
 *
 * Determinism Rules:
 *   - Same inputs -> same output
 *   - No generative interpretation
 *   - Rule-based inference only
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  AvailabilityLevel,
  TimeWindow,
  ActionDepth,
  AvailabilityTag,
  AvailabilityComputeInput,
  AvailabilityAssessment,
  AvailabilityFactor,
  TimeWindowAssessment,
  TimeWindowFactor,
  ReadinessAssessment,
  ReadinessFactor,
  ReadinessRiskFlag,
  AvailabilityReadinessBundle,
  ComputeAvailabilityResponse,
  GetCurrentAvailabilityResponse,
  OverrideAvailabilityResponse,
  AvailabilityGuardrailContext,
  D33_THRESHOLDS,
  ACTION_DEPTH_PROFILES,
  D33_DISCLAIMER
} from '../types/availability-readiness';

// =============================================================================
// Constants
// =============================================================================

const VTID = 'VTID-01127';
const LOG_PREFIX = '[D33-Engine]';

// =============================================================================
// In-Memory Cache (Session-Scoped)
// =============================================================================

interface CachedBundle {
  bundle: AvailabilityReadinessBundle;
  computed_at: number;
  expires_at: number;
}

interface UserOverride {
  id: string;
  availability?: AvailabilityLevel;
  time_available_minutes?: number;
  readiness?: 'ready' | 'not_now' | 'busy';
  created_at: number;
  expires_at: number;
}

const bundleCache = new Map<string, CachedBundle>();
const overrideCache = new Map<string, UserOverride>();

// Cache TTL: 5 minutes for bundles
const BUNDLE_CACHE_TTL_MS = 5 * 60 * 1000;

// =============================================================================
// Core Computation: Availability Inference
// =============================================================================

/**
 * Infer availability level from multiple signals (conservative fusion)
 * Uses a weighted scoring approach where negative signals dominate
 */
function inferAvailability(input: AvailabilityComputeInput): AvailabilityAssessment {
  const factors: AvailabilityFactor[] = [];
  let score = 0;        // Ranges from -100 to +100
  let confidence = 50;  // Start at neutral confidence

  // 1. Time of day / weekday vs weekend
  if (input.time_context) {
    const { current_hour, is_weekend, day_of_week } = input.time_context;

    // Late night (22:00 - 06:00) suggests lower availability
    if (current_hour >= 22 || current_hour < 6) {
      score -= 30;
      confidence += 10;
      factors.push({
        source: 'time_context',
        signal: `Late night hour (${current_hour}:00)`,
        contribution: -0.3,
        confidence: 70
      });
    }
    // Early morning (6-8) - mixed
    else if (current_hour >= 6 && current_hour < 8) {
      score -= 10;
      factors.push({
        source: 'time_context',
        signal: 'Early morning',
        contribution: -0.1,
        confidence: 50
      });
    }
    // Peak productive hours (9-17) - higher availability
    else if (current_hour >= 9 && current_hour < 17 && !is_weekend) {
      score += 10;
      factors.push({
        source: 'time_context',
        signal: 'Work hours (weekday)',
        contribution: 0.1,
        confidence: 60
      });
    }
    // Evening (17-22) - moderate availability
    else if (current_hour >= 17 && current_hour < 22) {
      score += 5;
      factors.push({
        source: 'time_context',
        signal: 'Evening hours',
        contribution: 0.05,
        confidence: 50
      });
    }

    // Weekend bonus
    if (is_weekend) {
      score += 10;
      factors.push({
        source: 'time_context',
        signal: 'Weekend',
        contribution: 0.1,
        confidence: 60
      });
    }
  }

  // 2. Session telemetry
  if (input.telemetry) {
    const { avg_response_time_seconds, interaction_count, session_length_minutes, recent_response_times } = input.telemetry;

    // Fast responses suggest high engagement
    if (avg_response_time_seconds < D33_THRESHOLDS.FAST_RESPONSE_THRESHOLD) {
      score += 25;
      confidence += 15;
      factors.push({
        source: 'telemetry',
        signal: `Fast responses (avg ${avg_response_time_seconds.toFixed(1)}s)`,
        contribution: 0.25,
        confidence: 80
      });
    }
    // Slow responses suggest distraction
    else if (avg_response_time_seconds > D33_THRESHOLDS.SLOW_RESPONSE_THRESHOLD) {
      score -= 25;
      confidence += 10;
      factors.push({
        source: 'telemetry',
        signal: `Slow responses (avg ${avg_response_time_seconds.toFixed(1)}s)`,
        contribution: -0.25,
        confidence: 70
      });
    }

    // High interaction count suggests engagement
    if (interaction_count > 5) {
      score += 15;
      factors.push({
        source: 'telemetry',
        signal: `Active session (${interaction_count} interactions)`,
        contribution: 0.15,
        confidence: 70
      });
    }

    // Long session suggests deep engagement
    if (session_length_minutes > D33_THRESHOLDS.LONG_SESSION_THRESHOLD) {
      score += 10;
      factors.push({
        source: 'telemetry',
        signal: `Long session (${session_length_minutes.toFixed(0)} min)`,
        contribution: 0.1,
        confidence: 65
      });
    }

    // Check for response time trend (slowing down = fatigue)
    if (recent_response_times && recent_response_times.length >= 3) {
      const recentAvg = recent_response_times.slice(-3).reduce((a, b) => a + b, 0) / 3;
      if (recentAvg > avg_response_time_seconds * 1.5) {
        score -= 20;
        factors.push({
          source: 'telemetry',
          signal: 'Slowing response trend',
          contribution: -0.2,
          confidence: 65
        });
      }
    }
  }

  // 3. Calendar hints (strong signal)
  if (input.calendar) {
    if (input.calendar.is_in_meeting) {
      score -= 50;
      confidence += 25;
      factors.push({
        source: 'calendar',
        signal: 'In meeting',
        contribution: -0.5,
        confidence: 95
      });
    } else if (input.calendar.has_upcoming_event && input.calendar.minutes_to_next_event) {
      if (input.calendar.minutes_to_next_event < 5) {
        score -= 40;
        confidence += 20;
        factors.push({
          source: 'calendar',
          signal: `Event in ${input.calendar.minutes_to_next_event} min`,
          contribution: -0.4,
          confidence: 90
        });
      } else if (input.calendar.minutes_to_next_event < 15) {
        score -= 20;
        factors.push({
          source: 'calendar',
          signal: `Event in ${input.calendar.minutes_to_next_event} min`,
          contribution: -0.2,
          confidence: 80
        });
      }
    }

    if (input.calendar.calendar_availability === 'free') {
      score += 15;
      factors.push({
        source: 'calendar',
        signal: 'Calendar shows free',
        contribution: 0.15,
        confidence: 75
      });
    }
  }

  // 4. D28 emotional/cognitive signals
  if (input.cognitive_state === 'overloaded' || input.cognitive_state === 'fatigued') {
    score -= 30;
    confidence += 10;
    factors.push({
      source: 'd28_cognitive',
      signal: `Cognitive state: ${input.cognitive_state}`,
      contribution: -0.3,
      confidence: 70
    });
  } else if (input.cognitive_state === 'focused' || input.cognitive_state === 'engaged') {
    score += 20;
    factors.push({
      source: 'd28_cognitive',
      signal: `Cognitive state: ${input.cognitive_state}`,
      contribution: 0.2,
      confidence: 70
    });
  }

  if (input.engagement_level === 'high') {
    score += 20;
    factors.push({
      source: 'd28_engagement',
      signal: 'High engagement',
      contribution: 0.2,
      confidence: 75
    });
  } else if (input.engagement_level === 'low') {
    score -= 20;
    factors.push({
      source: 'd28_engagement',
      signal: 'Low engagement',
      contribution: -0.2,
      confidence: 70
    });
  }

  // 5. D27 preferences
  if (input.quiet_hours_active) {
    score -= 40;
    confidence += 20;
    factors.push({
      source: 'd27_preferences',
      signal: 'Quiet hours active',
      contribution: -0.4,
      confidence: 95
    });
  }

  // 6. Hesitation signal
  if (input.is_hesitant) {
    score -= 15;
    factors.push({
      source: 'd28_hesitation',
      signal: 'User seems hesitant',
      contribution: -0.15,
      confidence: 60
    });
  }

  // Convert score to level (conservative thresholds)
  let level: AvailabilityLevel;
  if (factors.length === 0) {
    level = 'unknown';
    confidence = 30;
  } else if (score >= 30) {
    level = 'high';
  } else if (score >= -10) {
    level = 'medium';
  } else {
    level = 'low';
  }

  // Cap confidence
  confidence = Math.min(95, Math.max(20, confidence));

  return {
    level,
    confidence,
    factors
  };
}

// =============================================================================
// Core Computation: Time Window Detection
// =============================================================================

/**
 * Detect viable action window based on signals
 */
function detectTimeWindow(input: AvailabilityComputeInput): TimeWindowAssessment {
  const factors: TimeWindowFactor[] = [];
  let estimatedMinutes: number | undefined;

  // Priority 1: Calendar constraints (most reliable)
  if (input.calendar) {
    if (input.calendar.is_in_meeting) {
      return {
        window: 'immediate',
        confidence: 95,
        estimated_minutes: 1,
        factors: [{
          source: 'calendar',
          signal: 'In meeting - minimal time only',
          contribution: -1.0
        }]
      };
    }

    if (input.calendar.has_upcoming_event && input.calendar.minutes_to_next_event !== undefined) {
      estimatedMinutes = input.calendar.minutes_to_next_event;

      if (estimatedMinutes <= D33_THRESHOLDS.TIME_IMMEDIATE_MAX) {
        return {
          window: 'immediate',
          confidence: 90,
          estimated_minutes: estimatedMinutes,
          factors: [{
            source: 'calendar',
            signal: `Event in ${estimatedMinutes} minutes`,
            contribution: -0.8
          }]
        };
      } else if (estimatedMinutes <= D33_THRESHOLDS.TIME_SHORT_MAX) {
        return {
          window: 'short',
          confidence: 85,
          estimated_minutes: estimatedMinutes,
          factors: [{
            source: 'calendar',
            signal: `Event in ${estimatedMinutes} minutes`,
            contribution: 0
          }]
        };
      } else {
        factors.push({
          source: 'calendar',
          signal: `${estimatedMinutes} minutes until next event`,
          contribution: 0.5
        });
      }
    }
  }

  // Priority 2: Session telemetry trends
  if (input.telemetry) {
    const { session_length_minutes, avg_response_time_seconds, interaction_mode } = input.telemetry;

    // Voice mode typically means shorter windows
    if (interaction_mode === 'voice') {
      factors.push({
        source: 'telemetry',
        signal: 'Voice mode (typically shorter)',
        contribution: -0.3
      });
    }

    // Long session suggests user has time
    if (session_length_minutes > D33_THRESHOLDS.LONG_SESSION_THRESHOLD) {
      factors.push({
        source: 'telemetry',
        signal: `Long session (${session_length_minutes.toFixed(0)}min)`,
        contribution: 0.4
      });
    } else if (session_length_minutes < D33_THRESHOLDS.SHORT_SESSION_THRESHOLD) {
      factors.push({
        source: 'telemetry',
        signal: 'Very short session',
        contribution: -0.2
      });
    }

    // Very fast responses might mean user is in a hurry
    if (avg_response_time_seconds < 2) {
      factors.push({
        source: 'telemetry',
        signal: 'Very rapid responses (might be rushed)',
        contribution: -0.2
      });
    }
  }

  // Priority 3: User preference hints
  if (input.preferred_interaction_depth === 'minimal') {
    factors.push({
      source: 'preferences',
      signal: 'User prefers minimal interactions',
      contribution: -0.4
    });
  } else if (input.preferred_interaction_depth === 'detailed') {
    factors.push({
      source: 'preferences',
      signal: 'User prefers detailed interactions',
      contribution: 0.3
    });
  }

  // Priority 4: Quiet hours
  if (input.quiet_hours_active) {
    return {
      window: 'defer',
      confidence: 95,
      factors: [{
        source: 'preferences',
        signal: 'Quiet hours active - defer actions',
        contribution: -1.0
      }]
    };
  }

  // Calculate net contribution
  const netContribution = factors.reduce((sum, f) => sum + f.contribution, 0);

  // Determine window from net contribution
  let window: TimeWindow;
  let confidence: number;

  if (netContribution <= -0.5) {
    window = 'immediate';
    confidence = 70;
  } else if (netContribution <= 0) {
    window = 'short';
    confidence = 60;
  } else {
    window = 'extended';
    confidence = 55;
  }

  // If no strong signals, default to short (conservative)
  if (factors.length === 0) {
    window = 'short';
    confidence = 40;
  }

  return {
    window,
    confidence,
    estimated_minutes: estimatedMinutes,
    factors
  };
}

// =============================================================================
// Core Computation: Readiness Scoring
// =============================================================================

/**
 * Calculate cognitive/behavioral readiness score (0.0 - 1.0)
 */
function calculateReadiness(input: AvailabilityComputeInput): ReadinessAssessment {
  const factors: ReadinessFactor[] = [];
  const riskFlags: ReadinessRiskFlag[] = [];
  let score = 0.5; // Start neutral

  // 1. Cognitive load from D28
  if (input.cognitive_state === 'overloaded') {
    score -= 0.25;
    factors.push({
      source: 'd28_cognitive',
      signal: 'Cognitive overload detected',
      impact: -0.25
    });
    riskFlags.push({
      type: 'cognitive_overload',
      severity: 'high',
      reason: 'D28 detected cognitive overload state'
    });
  } else if (input.cognitive_state === 'fatigued') {
    score -= 0.15;
    factors.push({
      source: 'd28_cognitive',
      signal: 'Cognitive fatigue detected',
      impact: -0.15
    });
    riskFlags.push({
      type: 'cognitive_overload',
      severity: 'medium',
      reason: 'D28 detected fatigue'
    });
  } else if (input.cognitive_state === 'focused') {
    score += 0.15;
    factors.push({
      source: 'd28_cognitive',
      signal: 'User appears focused',
      impact: 0.15
    });
  }

  // 2. Emotional tone from D28
  if (input.emotional_state === 'stressed' || input.emotional_state === 'anxious') {
    score -= 0.2;
    factors.push({
      source: 'd28_emotional',
      signal: `Emotional state: ${input.emotional_state}`,
      impact: -0.2
    });
    riskFlags.push({
      type: 'emotional_stress',
      severity: 'medium',
      reason: `D28 detected ${input.emotional_state} state`
    });
  } else if (input.emotional_state === 'frustrated') {
    score -= 0.25;
    factors.push({
      source: 'd28_emotional',
      signal: 'User appears frustrated',
      impact: -0.25
    });
    riskFlags.push({
      type: 'emotional_stress',
      severity: 'high',
      reason: 'User frustration detected - avoid additional asks'
    });
  } else if (input.emotional_state === 'motivated' || input.emotional_state === 'calm') {
    score += 0.1;
    factors.push({
      source: 'd28_emotional',
      signal: `Positive emotional state: ${input.emotional_state}`,
      impact: 0.1
    });
  }

  // 3. Decision fatigue risk (inferred from session length + interaction count)
  if (input.telemetry) {
    const { interaction_count, session_length_minutes } = input.telemetry;

    // High interaction count suggests potential decision fatigue
    if (interaction_count > 10) {
      const fatiguePenalty = Math.min(0.2, (interaction_count - 10) * 0.02);
      score -= fatiguePenalty;
      factors.push({
        source: 'decision_fatigue',
        signal: `Many interactions (${interaction_count}) - possible fatigue`,
        impact: -fatiguePenalty
      });
      riskFlags.push({
        type: 'decision_fatigue',
        severity: interaction_count > 15 ? 'high' : 'medium',
        reason: `${interaction_count} interactions may indicate decision fatigue`
      });
    }

    // Very long session
    if (session_length_minutes > 30) {
      score -= 0.1;
      factors.push({
        source: 'session_fatigue',
        signal: `Long session (${session_length_minutes.toFixed(0)} min)`,
        impact: -0.1
      });
    }
  }

  // 4. Health/energy soft signals
  if (input.health_context) {
    if (input.health_context.energy_indicator === 'low') {
      score -= 0.15;
      factors.push({
        source: 'health_context',
        signal: 'Low energy indicator',
        impact: -0.15
      });
      riskFlags.push({
        type: 'low_energy',
        severity: 'medium',
        reason: 'Health context indicates low energy'
      });
    } else if (input.health_context.energy_indicator === 'high') {
      score += 0.1;
      factors.push({
        source: 'health_context',
        signal: 'High energy indicator',
        impact: 0.1
      });
    }

    if (input.health_context.recent_sleep_quality !== undefined && input.health_context.recent_sleep_quality < 50) {
      score -= 0.1;
      factors.push({
        source: 'health_context',
        signal: `Poor recent sleep (${input.health_context.recent_sleep_quality}%)`,
        impact: -0.1
      });
    }

    if (input.health_context.stress_level !== undefined && input.health_context.stress_level > 70) {
      score -= 0.15;
      factors.push({
        source: 'health_context',
        signal: `High stress level (${input.health_context.stress_level}%)`,
        impact: -0.15
      });
      riskFlags.push({
        type: 'emotional_stress',
        severity: 'medium',
        reason: 'Health context indicates elevated stress'
      });
    }
  }

  // 5. Urgency signal (from D28)
  if (input.is_urgent) {
    // Urgency can actually boost readiness for immediate action
    score += 0.1;
    factors.push({
      source: 'd28_urgency',
      signal: 'User expressed urgency',
      impact: 0.1
    });
    // But also flag time pressure
    riskFlags.push({
      type: 'time_pressure',
      severity: 'low',
      reason: 'User urgency may limit depth of engagement'
    });
  }

  // 6. Hesitation signal
  if (input.is_hesitant) {
    score -= 0.1;
    factors.push({
      source: 'd28_hesitation',
      signal: 'User appears hesitant',
      impact: -0.1
    });
  }

  // 7. Engagement level
  if (input.engagement_level === 'high') {
    score += 0.15;
    factors.push({
      source: 'd28_engagement',
      signal: 'High engagement level',
      impact: 0.15
    });
  } else if (input.engagement_level === 'low') {
    score -= 0.15;
    factors.push({
      source: 'd28_engagement',
      signal: 'Low engagement level',
      impact: -0.15
    });
  }

  // Clamp score to [0, 1]
  score = Math.max(0, Math.min(1, score));

  // Calculate confidence based on number of signals
  let confidence = 40 + (factors.length * 5);
  confidence = Math.min(90, confidence);

  return {
    score,
    confidence,
    factors,
    risk_flags: riskFlags
  };
}

// =============================================================================
// Action Depth Controller
// =============================================================================

/**
 * Translate availability + time window + readiness into allowed action depth
 */
function determineActionDepth(
  availability: AvailabilityAssessment,
  timeWindow: TimeWindowAssessment,
  readiness: ReadinessAssessment
): { actionDepth: ActionDepth; availabilityTag: AvailabilityTag } {

  // Determine base tag from availability level
  let tag: AvailabilityTag;

  if (timeWindow.window === 'defer') {
    tag = 'defer_actions';
  } else if (availability.level === 'low' || timeWindow.window === 'immediate') {
    tag = 'quick_only';
  } else if (availability.level === 'medium' || timeWindow.window === 'short') {
    tag = 'light_flow_ok';
  } else if (availability.level === 'high' && timeWindow.window === 'extended') {
    tag = 'deep_flow_ok';
  } else if (availability.level === 'unknown') {
    // Default to lower depth when uncertain
    tag = 'quick_only';
  } else {
    tag = 'light_flow_ok';
  }

  // Get base action depth from profile
  let actionDepth = { ...ACTION_DEPTH_PROFILES[tag] };

  // Apply readiness modifiers
  if (readiness.score < D33_THRESHOLDS.READINESS_MONETIZATION_MIN) {
    // Block monetization actions
    actionDepth.allow_payment = false;
    actionDepth.allow_booking = false;
  }

  if (readiness.score < D33_THRESHOLDS.READINESS_DEEP_FLOW_MIN && tag === 'deep_flow_ok') {
    // Downgrade from deep to light
    tag = 'light_flow_ok';
    actionDepth = { ...ACTION_DEPTH_PROFILES[tag] };
  }

  if (readiness.score < D33_THRESHOLDS.READINESS_LIGHT_FLOW_MIN && tag === 'light_flow_ok') {
    // Downgrade from light to quick
    tag = 'quick_only';
    actionDepth = { ...ACTION_DEPTH_PROFILES[tag] };
  }

  // High-severity risk flags force conservative approach
  const hasHighRisk = readiness.risk_flags.some(f => f.severity === 'high');
  if (hasHighRisk && tag !== 'defer_actions') {
    tag = 'quick_only';
    actionDepth = { ...ACTION_DEPTH_PROFILES[tag] };
  }

  return { actionDepth, availabilityTag: tag };
}

// =============================================================================
// User Override Handling
// =============================================================================

/**
 * Apply user override to assessment
 */
function applyUserOverride(
  override: AvailabilityComputeInput['user_override'],
  availability: AvailabilityAssessment,
  timeWindow: TimeWindowAssessment,
  readiness: ReadinessAssessment
): {
  availability: AvailabilityAssessment;
  timeWindow: TimeWindowAssessment;
  readiness: ReadinessAssessment;
  wasOverride: boolean;
} {
  if (!override) {
    return { availability, timeWindow, readiness, wasOverride: false };
  }

  let wasOverride = false;

  // Override availability
  if (override.availability) {
    availability = {
      level: override.availability,
      confidence: 100,
      factors: [{
        source: 'user_override',
        signal: `User set availability to ${override.availability}`,
        contribution: 1.0,
        confidence: 100
      }]
    };
    wasOverride = true;
  }

  // Override time window based on minutes
  if (override.time_available_minutes !== undefined) {
    let window: TimeWindow;
    if (override.time_available_minutes <= D33_THRESHOLDS.TIME_IMMEDIATE_MAX) {
      window = 'immediate';
    } else if (override.time_available_minutes <= D33_THRESHOLDS.TIME_SHORT_MAX) {
      window = 'short';
    } else {
      window = 'extended';
    }

    timeWindow = {
      window,
      confidence: 100,
      estimated_minutes: override.time_available_minutes,
      factors: [{
        source: 'user_override',
        signal: `User specified ${override.time_available_minutes} minutes available`,
        contribution: 1.0
      }]
    };
    wasOverride = true;
  }

  // Override readiness
  if (override.readiness) {
    let score: number;
    switch (override.readiness) {
      case 'ready': score = 0.9; break;
      case 'not_now': score = 0.2; break;
      case 'busy': score = 0.1; break;
    }

    readiness = {
      score,
      confidence: 100,
      factors: [{
        source: 'user_override',
        signal: `User indicated: ${override.readiness}`,
        impact: score - 0.5
      }],
      risk_flags: []
    };
    wasOverride = true;
  }

  return { availability, timeWindow, readiness, wasOverride };
}

// =============================================================================
// Main Compute Function
// =============================================================================

/**
 * Compute availability, time-window, and readiness from input signals
 * Main entry point for D33 engine
 */
export async function computeAvailabilityReadiness(
  input: AvailabilityComputeInput
): Promise<ComputeAvailabilityResponse> {
  const startTime = Date.now();
  const computedAt = new Date().toISOString();

  try {
    // Check for active user override
    const sessionKey = input.session_id || 'default';
    const activeOverride = overrideCache.get(sessionKey);

    if (activeOverride && activeOverride.expires_at > Date.now()) {
      // Merge active override into input
      input.user_override = {
        ...input.user_override,
        availability: activeOverride.availability || input.user_override?.availability,
        time_available_minutes: activeOverride.time_available_minutes ?? input.user_override?.time_available_minutes,
        readiness: activeOverride.readiness || input.user_override?.readiness
      };
    }

    // 1. Infer availability
    let availability = inferAvailability(input);

    // 2. Detect time window
    let timeWindow = detectTimeWindow(input);

    // 3. Calculate readiness
    let readiness = calculateReadiness(input);

    // 4. Apply user overrides (always win)
    const { availability: overriddenAvailability, timeWindow: overriddenTimeWindow, readiness: overriddenReadiness, wasOverride } =
      applyUserOverride(input.user_override, availability, timeWindow, readiness);

    availability = overriddenAvailability;
    timeWindow = overriddenTimeWindow;
    readiness = overriddenReadiness;

    // 5. Determine action depth
    const { actionDepth, availabilityTag } = determineActionDepth(availability, timeWindow, readiness);

    // 6. Build bundle
    const bundle: AvailabilityReadinessBundle = {
      availability,
      time_window: timeWindow,
      readiness,
      action_depth: actionDepth,
      availability_tag: availabilityTag,
      computed_at: computedAt,
      session_id: input.session_id,
      turn_id: input.turn_id,
      was_user_override: wasOverride,
      disclaimer: D33_DISCLAIMER
    };

    // 7. Cache result
    if (input.session_id) {
      bundleCache.set(input.session_id, {
        bundle,
        computed_at: Date.now(),
        expires_at: Date.now() + BUNDLE_CACHE_TTL_MS
      });
    }

    // 8. Emit OASIS event
    const duration = Date.now() - startTime;
    await emitOasisEvent({
      vtid: VTID,
      type: 'd33.availability.computed',
      source: 'gateway-d33',
      status: 'success',
      message: `D33 computed: ${availabilityTag} (${availability.level}/${timeWindow.window}/${readiness.score.toFixed(2)})`,
      payload: {
        session_id: input.session_id,
        turn_id: input.turn_id,
        availability_level: availability.level,
        time_window: timeWindow.window,
        readiness_score: readiness.score,
        availability_tag: availabilityTag,
        was_override: wasOverride,
        duration_ms: duration,
        risk_flag_count: readiness.risk_flags.length
      }
    }).catch(err => console.warn(`${LOG_PREFIX} Failed to emit OASIS event:`, err.message));

    console.log(`${LOG_PREFIX} Computed in ${duration}ms: tag=${availabilityTag}, readiness=${readiness.score.toFixed(2)}`);

    return {
      ok: true,
      bundle
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Computation error:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd33.availability.computed',
      source: 'gateway-d33',
      status: 'error',
      message: `D33 computation failed: ${errorMessage}`,
      payload: { error: errorMessage, session_id: input.session_id }
    }).catch(() => {});

    return {
      ok: false,
      error: 'COMPUTATION_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Get current cached availability for a session
 */
export async function getCurrentAvailability(
  sessionId: string
): Promise<GetCurrentAvailabilityResponse> {
  const cached = bundleCache.get(sessionId);

  if (!cached || cached.expires_at < Date.now()) {
    return {
      ok: true,
      cached: false,
      bundle: undefined
    };
  }

  const cacheAgeSeconds = (Date.now() - cached.computed_at) / 1000;

  return {
    ok: true,
    bundle: cached.bundle,
    cached: true,
    cache_age_seconds: cacheAgeSeconds
  };
}

/**
 * Set user override for availability/readiness
 * User overrides always win immediately
 */
export async function setUserOverride(
  sessionId: string,
  override: {
    availability?: AvailabilityLevel;
    time_available_minutes?: number;
    readiness?: 'ready' | 'not_now' | 'busy';
  }
): Promise<OverrideAvailabilityResponse> {
  const overrideId = randomUUID();
  const now = Date.now();
  const expiresAt = now + (D33_THRESHOLDS.OVERRIDE_EXPIRY_MINUTES * 60 * 1000);

  // Get previous level for response
  const previousBundle = bundleCache.get(sessionId);
  const previousLevel = previousBundle?.bundle.availability.level;

  // Store override
  overrideCache.set(sessionId, {
    id: overrideId,
    availability: override.availability,
    time_available_minutes: override.time_available_minutes,
    readiness: override.readiness,
    created_at: now,
    expires_at: expiresAt
  });

  // Invalidate cached bundle so next compute uses override
  bundleCache.delete(sessionId);

  // Emit OASIS event
  await emitOasisEvent({
    vtid: VTID,
    type: 'd33.availability.override',
    source: 'gateway-d33',
    status: 'info',
    message: `User override set for session ${sessionId}`,
    payload: {
      override_id: overrideId,
      session_id: sessionId,
      previous_level: previousLevel,
      new_availability: override.availability,
      new_readiness: override.readiness,
      expires_at: new Date(expiresAt).toISOString()
    }
  }).catch(err => console.warn(`${LOG_PREFIX} Failed to emit override event:`, err.message));

  console.log(`${LOG_PREFIX} User override set: ${sessionId} -> availability=${override.availability}, readiness=${override.readiness}`);

  return {
    ok: true,
    override_id: overrideId,
    previous_level: previousLevel,
    new_level: override.availability,
    expires_at: new Date(expiresAt).toISOString()
  };
}

/**
 * Clear user override
 */
export async function clearUserOverride(sessionId: string): Promise<{ ok: boolean; cleared: boolean }> {
  const had = overrideCache.has(sessionId);
  overrideCache.delete(sessionId);
  bundleCache.delete(sessionId); // Also clear cached bundle

  if (had) {
    console.log(`${LOG_PREFIX} User override cleared: ${sessionId}`);
  }

  return { ok: true, cleared: had };
}

/**
 * Get guardrail context for downstream engines
 */
export function getGuardrailContext(bundle: AvailabilityReadinessBundle): AvailabilityGuardrailContext {
  return {
    max_steps: bundle.action_depth.max_steps,
    max_questions: bundle.action_depth.max_questions,
    max_recommendations: bundle.action_depth.max_recommendations,
    allow_booking: bundle.action_depth.allow_booking,
    allow_payment: bundle.action_depth.allow_payment,
    availability_tag: bundle.availability_tag,
    readiness_score: bundle.readiness.score,
    time_window: bundle.time_window.window
  };
}

// =============================================================================
// Failure Mode Handlers
// =============================================================================

/**
 * Check if we should auto-downgrade based on hesitation signals
 * Called when user shows signs of being overwhelmed
 */
export async function checkForAutoDowngrade(
  sessionId: string,
  hesitationSignal: boolean
): Promise<{ downgraded: boolean; newTag?: AvailabilityTag }> {
  if (!hesitationSignal) {
    return { downgraded: false };
  }

  const cached = bundleCache.get(sessionId);
  if (!cached) {
    return { downgraded: false };
  }

  const currentTag = cached.bundle.availability_tag;

  // Downgrade by one level
  let newTag: AvailabilityTag;
  switch (currentTag) {
    case 'deep_flow_ok':
      newTag = 'light_flow_ok';
      break;
    case 'light_flow_ok':
      newTag = 'quick_only';
      break;
    default:
      return { downgraded: false };
  }

  // Update cached bundle
  const updatedBundle: AvailabilityReadinessBundle = {
    ...cached.bundle,
    availability_tag: newTag,
    action_depth: ACTION_DEPTH_PROFILES[newTag]
  };

  bundleCache.set(sessionId, {
    bundle: updatedBundle,
    computed_at: Date.now(),
    expires_at: Date.now() + BUNDLE_CACHE_TTL_MS
  });

  console.log(`${LOG_PREFIX} Auto-downgraded ${sessionId}: ${currentTag} -> ${newTag}`);

  await emitOasisEvent({
    vtid: VTID,
    type: 'd33.guardrail.enforced',
    source: 'gateway-d33',
    status: 'info',
    message: `Auto-downgrade on hesitation: ${currentTag} -> ${newTag}`,
    payload: {
      session_id: sessionId,
      previous_tag: currentTag,
      new_tag: newTag,
      reason: 'hesitation_signal'
    }
  }).catch(() => {});

  return { downgraded: true, newTag };
}

/**
 * Prompt lightweight correction ("Too much right now?")
 * Returns true if we should show the correction prompt
 */
export function shouldPromptLightweightCorrection(bundle: AvailabilityReadinessBundle): boolean {
  // Show if:
  // 1. Low readiness but not from user override
  // 2. High-severity risk flags present
  if (bundle.was_user_override) {
    return false;
  }

  if (bundle.readiness.score < 0.4) {
    return true;
  }

  if (bundle.readiness.risk_flags.some(f => f.severity === 'high')) {
    return true;
  }

  return false;
}

// =============================================================================
// Cache Cleanup
// =============================================================================

/**
 * Clean up expired cache entries
 */
function cleanupCaches(): void {
  const now = Date.now();

  for (const [key, value] of bundleCache.entries()) {
    if (value.expires_at < now) {
      bundleCache.delete(key);
    }
  }

  for (const [key, value] of overrideCache.entries()) {
    if (value.expires_at < now) {
      overrideCache.delete(key);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupCaches, 5 * 60 * 1000);

// =============================================================================
// Exports
// =============================================================================

export {
  inferAvailability,
  detectTimeWindow,
  calculateReadiness,
  determineActionDepth
};

export type {
  AvailabilityReadinessBundle,
  AvailabilityGuardrailContext
};
