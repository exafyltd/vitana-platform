/**
 * VTID-01139: D45 Predictive Risk Windows & Opportunity Forecasting Engine
 *
 * Type definitions for the Predictive Risk Forecasting system that forecasts
 * short-term and mid-term windows where the user is statistically more likely
 * to experience risk or opportunity.
 *
 * This engine answers: "When is the next sensitive window — and why?"
 *
 * Core Philosophy:
 *   - Forecasts ≠ facts — use probabilistic language only
 *   - No fear framing or deterministic language
 *   - Explainability mandatory for all windows
 *   - User safety is paramount
 *   - No autonomous execution or irreversible actions
 *
 * Determinism Rules:
 *   - Same input signals → same window prediction
 *   - Same historical patterns → same precedent matching
 *   - Rule-based thresholds, no creative inference at this layer
 */

import { z } from 'zod';
import { LongitudinalDomain, TrendAnalysis, DriftEvent } from './longitudinal-adaptation';

// =============================================================================
// VTID-01139: Core Domain Types
// =============================================================================

/**
 * Window type - risk or opportunity
 */
export const WindowType = z.enum([
  'risk',        // Elevated probability of negative outcomes
  'opportunity'  // Elevated probability of positive leverage
]);
export type WindowType = z.infer<typeof WindowType>;

/**
 * Risk/opportunity domains tracked
 */
export const ForecastDomain = z.enum([
  'health',      // Health & recovery risks/opportunities
  'behavior',    // Behavioral pattern risks/opportunities
  'social',      // Social interaction risks/opportunities
  'cognitive',   // Cognitive load & performance risks/opportunities
  'routine'      // Routine disruption risks/opportunities
]);
export type ForecastDomain = z.infer<typeof ForecastDomain>;

/**
 * Time horizons for forecasting
 */
export const TimeHorizon = z.enum([
  'short',  // 24-72 hours
  'mid',    // 7-21 days
  'long'    // 30-90 days (requires ≥85% confidence)
]);
export type TimeHorizon = z.infer<typeof TimeHorizon>;

/**
 * Recommended engagement mode for a window
 */
export const RecommendedMode = z.enum([
  'awareness',     // Simply be aware, no action needed
  'reflection',    // Consider and reflect on the situation
  'gentle_prep'    // Light preparation may be beneficial
]);
export type RecommendedMode = z.infer<typeof RecommendedMode>;

/**
 * Signal confidence levels
 */
export const SignalConfidence = z.enum([
  'low',     // < 50%
  'medium',  // 50-79%
  'high'     // ≥ 80%
]);
export type SignalConfidence = z.infer<typeof SignalConfidence>;

/**
 * Window lifecycle status
 */
export const WindowStatus = z.enum([
  'active',      // Window is currently in the forecasted period
  'upcoming',    // Window is in the future
  'passed',      // Window time has passed
  'invalidated', // Window was superseded by new data
  'acknowledged' // User has seen/acknowledged the window
]);
export type WindowStatus = z.infer<typeof WindowStatus>;

// =============================================================================
// VTID-01139: Predictive Signal Types
// =============================================================================

/**
 * A predictive signal from upstream systems (D43/D44)
 */
export const PredictiveSignalSchema = z.object({
  signal_id: z.string().uuid(),
  source: z.enum(['d43_trend', 'd44_signal', 'historical_pattern', 'calendar', 'behavioral']),
  domain: ForecastDomain,
  signal_type: z.enum(['risk_indicator', 'opportunity_indicator', 'pattern_match', 'anomaly']),
  confidence: z.number().min(0).max(100),
  magnitude: z.number().min(0).max(100),
  description: z.string().max(500),
  detected_at: z.string().datetime(),
  expires_at: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional()
});
export type PredictiveSignal = z.infer<typeof PredictiveSignalSchema>;

/**
 * Historical pattern match
 */
export const HistoricalPrecedentSchema = z.object({
  pattern_id: z.string().uuid(),
  pattern_type: z.string(),
  matched_period: z.object({
    start: z.string().datetime(),
    end: z.string().datetime()
  }),
  similarity_score: z.number().min(0).max(100),
  outcome: z.enum(['risk_materialized', 'opportunity_realized', 'neutral', 'unknown']),
  description: z.string().max(500)
});
export type HistoricalPrecedent = z.infer<typeof HistoricalPrecedentSchema>;

// =============================================================================
// VTID-01139: Predictive Window Types
// =============================================================================

/**
 * A single driver for a predictive window
 */
export const WindowDriverSchema = z.object({
  driver_type: z.enum(['signal', 'trend', 'pattern', 'calendar', 'convergence']),
  reference_id: z.string(),  // signal_id, trend_ref, pattern_id, etc.
  contribution: z.number().min(0).max(100),  // How much this driver contributes
  description: z.string().max(300)
});
export type WindowDriver = z.infer<typeof WindowDriverSchema>;

/**
 * Core predictive window structure (strict output format per spec)
 */
export const PredictiveWindowSchema = z.object({
  window_id: z.string().uuid(),
  window_type: WindowType,
  domain: ForecastDomain,
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  confidence: z.number().min(0).max(100),
  drivers: z.array(z.string()),  // References to signal_id/trend_ref
  historical_precedent: z.string().max(500),  // Short description
  recommended_mode: RecommendedMode,
  explainability_text: z.string().max(1000)  // Plain language explanation
});
export type PredictiveWindow = z.infer<typeof PredictiveWindowSchema>;

/**
 * Extended window with full metadata (internal use)
 */
export const PredictiveWindowFullSchema = PredictiveWindowSchema.extend({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  time_horizon: TimeHorizon,
  status: WindowStatus,
  driver_details: z.array(WindowDriverSchema).optional(),
  precedent_details: HistoricalPrecedentSchema.optional(),
  severity: z.number().min(0).max(100).optional(),  // For risk windows
  leverage: z.number().min(0).max(100).optional(),  // For opportunity windows
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  acknowledged_at: z.string().datetime().optional(),
  invalidated_at: z.string().datetime().optional(),
  invalidation_reason: z.string().optional()
});
export type PredictiveWindowFull = z.infer<typeof PredictiveWindowFullSchema>;

// =============================================================================
// VTID-01139: Forecast Computation Types
// =============================================================================

/**
 * Input bundle for forecast computation
 */
export const ForecastInputBundleSchema = z.object({
  // Required inputs
  trends: z.array(z.object({
    domain: LongitudinalDomain,
    trend: z.unknown()  // TrendAnalysis
  })).optional(),
  drift_events: z.array(z.unknown()).optional(),  // DriftEvent[]
  historical_data_days: z.number().int().min(30).max(180).default(90),

  // Optional enrichments
  calendar_density: z.number().min(0).max(100).optional(),
  travel_detected: z.boolean().optional(),
  sleep_quality_score: z.number().min(0).max(100).optional(),
  social_interaction_cadence: z.number().min(0).max(100).optional(),

  // Computation parameters
  horizons: z.array(TimeHorizon).default(['short', 'mid']),
  domains: z.array(ForecastDomain).optional(),
  include_opportunities: z.boolean().default(true),
  include_risks: z.boolean().default(true)
});
export type ForecastInputBundle = z.infer<typeof ForecastInputBundleSchema>;

/**
 * Signal convergence - when multiple signals point to same window
 */
export const SignalConvergenceSchema = z.object({
  convergence_id: z.string().uuid(),
  signals: z.array(PredictiveSignalSchema),
  combined_confidence: z.number().min(0).max(100),
  suggested_window: z.object({
    start: z.string().datetime(),
    end: z.string().datetime()
  }),
  convergence_type: z.enum(['reinforcing', 'conflicting', 'neutral'])
});
export type SignalConvergence = z.infer<typeof SignalConvergenceSchema>;

/**
 * Forecast result
 */
export const ForecastResultSchema = z.object({
  ok: z.boolean(),
  forecast_id: z.string().uuid().optional(),
  windows: z.array(PredictiveWindowSchema).default([]),
  risk_windows: z.array(PredictiveWindowSchema).default([]),
  opportunity_windows: z.array(PredictiveWindowSchema).default([]),
  signals_analyzed: z.number().int().default(0),
  patterns_matched: z.number().int().default(0),
  computed_at: z.string().datetime().optional(),
  next_update_suggested: z.string().datetime().optional(),
  error: z.string().optional()
});
export type ForecastResult = z.infer<typeof ForecastResultSchema>;

// =============================================================================
// VTID-01139: API Request/Response Types
// =============================================================================

/**
 * Compute forecast request
 */
export const ComputeForecastRequestSchema = z.object({
  horizons: z.array(TimeHorizon).default(['short', 'mid']),
  domains: z.array(ForecastDomain).optional(),
  include_opportunities: z.boolean().default(true),
  include_risks: z.boolean().default(true),
  historical_days: z.number().int().min(30).max(180).default(90),
  force_refresh: z.boolean().default(false)
});
export type ComputeForecastRequest = z.infer<typeof ComputeForecastRequestSchema>;

/**
 * Get windows request
 */
export const GetWindowsRequestSchema = z.object({
  window_types: z.array(WindowType).optional(),
  domains: z.array(ForecastDomain).optional(),
  status: z.array(WindowStatus).optional(),
  time_horizon: TimeHorizon.optional(),
  include_past: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0)
});
export type GetWindowsRequest = z.infer<typeof GetWindowsRequestSchema>;

/**
 * Get windows response
 */
export interface GetWindowsResponse {
  ok: boolean;
  windows?: PredictiveWindow[];
  total_count?: number;
  has_more?: boolean;
  error?: string;
}

/**
 * Acknowledge window request
 */
export const AcknowledgeWindowRequestSchema = z.object({
  window_id: z.string().uuid(),
  feedback: z.enum(['helpful', 'not_helpful', 'too_early', 'too_late', 'inaccurate']).optional(),
  notes: z.string().max(500).optional()
});
export type AcknowledgeWindowRequest = z.infer<typeof AcknowledgeWindowRequestSchema>;

/**
 * Acknowledge window response
 */
export interface AcknowledgeWindowResponse {
  ok: boolean;
  window_id?: string;
  acknowledged_at?: string;
  error?: string;
}

/**
 * Get window details request
 */
export const GetWindowDetailsRequestSchema = z.object({
  window_id: z.string().uuid()
});
export type GetWindowDetailsRequest = z.infer<typeof GetWindowDetailsRequestSchema>;

/**
 * Get window details response
 */
export interface GetWindowDetailsResponse {
  ok: boolean;
  window?: PredictiveWindowFull;
  error?: string;
}

// =============================================================================
// VTID-01139: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for predictive forecasting
 */
export const PREDICTIVE_FORECAST_EVENT_TYPES = [
  'd45.forecast.computed',           // Forecast computation completed
  'd45.window.risk_detected',        // Risk window identified
  'd45.window.opportunity_detected', // Opportunity window identified
  'd45.window.acknowledged',         // User acknowledged a window
  'd45.window.invalidated',          // Window invalidated by new data
  'd45.window.materialized',         // Predicted event occurred
  'd45.signals.converged',           // Multiple signals converged
  'd45.pattern.matched'              // Historical pattern matched
] as const;

export type PredictiveForecastEventType = typeof PREDICTIVE_FORECAST_EVENT_TYPES[number];

/**
 * OASIS event payload for predictive forecasting
 */
export interface PredictiveForecastEventPayload {
  vtid: string;
  tenant_id?: string;
  user_id?: string;
  event_type: PredictiveForecastEventType;
  window_type?: WindowType;
  domain?: ForecastDomain;
  confidence?: number;
  window_id?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01139: Configuration & Thresholds
// =============================================================================

/**
 * Window generation thresholds
 */
export const FORECAST_THRESHOLDS = {
  // Minimum confidence to generate a window
  MIN_CONFIDENCE_SHORT: 60,     // Short-term windows
  MIN_CONFIDENCE_MID: 70,       // Mid-term windows
  MIN_CONFIDENCE_LONG: 85,      // Long-term windows (per spec)

  // Signal requirements
  MIN_HIGH_CONFIDENCE_SIGNALS: 1,  // ≥1 high-confidence signal OR
  MIN_MEDIUM_CONFIDENCE_SIGNALS: 2, // ≥2 medium-confidence signals

  // Historical pattern requirements
  PATTERN_SIMILARITY_THRESHOLD: 70,  // Minimum similarity for precedent match
  MIN_HISTORICAL_OCCURRENCES: 2,     // Need at least 2 similar past patterns

  // Time horizon bounds (hours/days)
  SHORT_HORIZON_MIN_HOURS: 24,
  SHORT_HORIZON_MAX_HOURS: 72,
  MID_HORIZON_MIN_DAYS: 7,
  MID_HORIZON_MAX_DAYS: 21,
  LONG_HORIZON_MIN_DAYS: 30,
  LONG_HORIZON_MAX_DAYS: 90,

  // Signal confidence levels
  HIGH_CONFIDENCE_THRESHOLD: 80,
  MEDIUM_CONFIDENCE_THRESHOLD: 50,

  // Convergence thresholds
  CONVERGENCE_BOOST: 15,  // Confidence boost when signals converge
  MAX_CONVERGENCE_BOOST: 25,

  // Window limits
  MAX_ACTIVE_WINDOWS: 10,
  WINDOW_STALE_HOURS: 24  // Recompute if older than this
} as const;

/**
 * Domain-specific risk factors
 */
export const DOMAIN_RISK_FACTORS: Record<ForecastDomain, {
  label: string;
  description: string;
  risk_examples: string[];
  opportunity_examples: string[];
}> = {
  health: {
    label: 'Health & Recovery',
    description: 'Physical and mental health patterns',
    risk_examples: ['burnout period', 'energy depletion', 'recovery needed'],
    opportunity_examples: ['peak energy window', 'recovery opportunity', 'health momentum']
  },
  behavior: {
    label: 'Behavioral Patterns',
    description: 'Habit formation and routine stability',
    risk_examples: ['habit disruption', 'routine breakdown', 'relapse risk'],
    opportunity_examples: ['habit formation window', 'routine optimization', 'behavior change opportunity']
  },
  social: {
    label: 'Social Connection',
    description: 'Social interaction and isolation patterns',
    risk_examples: ['isolation period', 'social fatigue', 'connection deficit'],
    opportunity_examples: ['social alignment', 'connection opportunity', 'community engagement window']
  },
  cognitive: {
    label: 'Cognitive Performance',
    description: 'Mental clarity and decision-making capacity',
    risk_examples: ['cognitive overload', 'decision fatigue', 'focus disruption'],
    opportunity_examples: ['high clarity window', 'learning opportunity', 'strategic thinking window']
  },
  routine: {
    label: 'Routine & Structure',
    description: 'Daily structure and predictability',
    risk_examples: ['schedule disruption', 'routine instability', 'transition stress'],
    opportunity_examples: ['routine establishment', 'structure optimization', 'transition preparation']
  }
};

/**
 * Recommended mode selection rules
 */
export const MODE_SELECTION_RULES = {
  // High confidence + near-term = gentle_prep
  gentle_prep: {
    min_confidence: 75,
    max_hours_ahead: 48
  },
  // Medium confidence or further out = reflection
  reflection: {
    min_confidence: 50,
    max_days_ahead: 14
  },
  // Lower confidence or distant = awareness only
  awareness: {
    min_confidence: 0,
    max_days_ahead: 90
  }
} as const;

/**
 * Explainability text templates (probabilistic wording only)
 */
export const EXPLAINABILITY_TEMPLATES = {
  risk: {
    high_confidence: 'Based on {signal_count} converging indicators and similar past patterns, there may be an elevated likelihood of {domain} challenges during this period.',
    medium_confidence: 'Some patterns suggest a possible {domain} sensitivity during this window. This is based on {signal_count} indicator(s).',
    low_confidence: 'Early signals indicate a potential {domain} consideration for this period. More data will help refine this forecast.'
  },
  opportunity: {
    high_confidence: 'Strong signals suggest this may be a favorable window for {domain} activities, based on {signal_count} positive indicators.',
    medium_confidence: 'Patterns indicate a potentially beneficial period for {domain}, supported by {signal_count} indicator(s).',
    low_confidence: 'Emerging patterns suggest possible {domain} opportunities during this window.'
  }
} as const;

/**
 * Time horizon metadata
 */
export const TIME_HORIZON_METADATA: Record<TimeHorizon, {
  label: string;
  description: string;
  min_hours?: number;
  max_hours?: number;
  min_days?: number;
  max_days?: number;
  required_confidence: number;
}> = {
  short: {
    label: 'Short-term',
    description: 'Next 24-72 hours',
    min_hours: 24,
    max_hours: 72,
    required_confidence: 60
  },
  mid: {
    label: 'Mid-term',
    description: 'Next 7-21 days',
    min_days: 7,
    max_days: 21,
    required_confidence: 70
  },
  long: {
    label: 'Long-term',
    description: 'Next 30-90 days',
    min_days: 30,
    max_days: 90,
    required_confidence: 85
  }
};

/**
 * Window status metadata
 */
export const WINDOW_STATUS_METADATA: Record<WindowStatus, {
  label: string;
  description: string;
  is_terminal: boolean;
}> = {
  active: {
    label: 'Active',
    description: 'Currently within the forecasted window period',
    is_terminal: false
  },
  upcoming: {
    label: 'Upcoming',
    description: 'Window is scheduled for the future',
    is_terminal: false
  },
  passed: {
    label: 'Passed',
    description: 'Window period has ended',
    is_terminal: true
  },
  invalidated: {
    label: 'Invalidated',
    description: 'New data has superseded this forecast',
    is_terminal: true
  },
  acknowledged: {
    label: 'Acknowledged',
    description: 'User has reviewed this window',
    is_terminal: false
  }
};
