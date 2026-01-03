/**
 * VTID-01145: D51 Predictive Fatigue, Burnout & Overload Detection Engine
 *
 * Core Intelligence Engine that detects early patterns of fatigue, cognitive
 * overload, emotional strain, or burnout risk BEFORE they escalate, and
 * surfaces them as gentle awareness signals.
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
 * Detection Rules (all must be met):
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
 *
 * Position in Intelligence Stack:
 *   D43 Longitudinal Trends + D44 Behavioral Signals + D45 Risk Windows → D51 Detection → Awareness Output
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  OverloadDimension,
  OverloadSignalSource,
  PatternType,
  PotentialImpact,
  TimeWindow,
  ObservedPattern,
  UserBaseline,
  BaselineDeviation,
  OverloadDetection,
  DetectionResult,
  ComputeDetectionRequest,
  ComputeDetectionResponse,
  GetDetectionsRequest,
  GetDetectionsResponse,
  DismissDetectionRequest,
  DismissDetectionResponse,
  GetBaselineRequest,
  GetBaselineResponse,
  ExplainDetectionRequest,
  ExplainDetectionResponse,
  DETECTION_THRESHOLDS,
  IMPACT_THRESHOLDS,
  DIMENSION_METADATA,
  buildExplainabilityText,
  containsForbiddenTerms,
  sanitizeExplainabilityText,
  OVERLOAD_DISCLAIMER
} from '../types/overload-detection';

// =============================================================================
// VTID-01145: Constants
// =============================================================================

export const VTID = 'VTID-01145';
const LOG_PREFIX = '[D51-Engine]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

// =============================================================================
// VTID-01145: Environment Detection
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
// VTID-01145: Supabase Client Factory
// =============================================================================

function createServiceClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function createUserClient(token: string): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_ANON_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

async function getClientWithContext(authToken?: string): Promise<{
  supabase: SupabaseClient | null;
  useDevIdentity: boolean;
  error?: string;
}> {
  let supabase: SupabaseClient | null = null;
  let useDevIdentity = false;

  if (authToken) {
    supabase = createUserClient(authToken);
  } else if (isDevSandbox()) {
    supabase = createServiceClient();
    useDevIdentity = true;
  } else {
    return { supabase: null, useDevIdentity: false, error: 'UNAUTHENTICATED' };
  }

  if (!supabase) {
    return { supabase: null, useDevIdentity: false, error: 'SERVICE_UNAVAILABLE' };
  }

  // Bootstrap dev context if needed
  if (useDevIdentity) {
    const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
      p_tenant_id: DEV_IDENTITY.TENANT_ID,
      p_active_role: 'developer'
    });
    if (bootstrapError) {
      console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, bootstrapError.message);
    }
  }

  return { supabase, useDevIdentity };
}

// =============================================================================
// VTID-01145: OASIS Event Emission
// =============================================================================

async function emitD51Event(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as any,
      source: 'd51-overload-detection-engine',
      status,
      message,
      payload: {
        ...payload,
        vtid: VTID
      }
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to emit ${type}:`, err);
  }
}

// =============================================================================
// VTID-01145: Core Detection Logic (Deterministic)
// =============================================================================

/**
 * Calculate deviation from baseline
 */
function calculateBaselineDeviation(
  baseline: UserBaseline,
  currentScore: number
): BaselineDeviation {
  const deviationMagnitude = baseline.baseline_score - currentScore;
  const deviationPercentage = baseline.baseline_score > 0
    ? (deviationMagnitude / baseline.baseline_score) * 100
    : 0;

  // Significance is based on standard deviation and minimum threshold
  const significanceThreshold = Math.max(
    DETECTION_THRESHOLDS.MIN_BASELINE_DEVIATION,
    baseline.standard_deviation * 1.5
  );

  return {
    dimension: baseline.dimension,
    baseline_score: baseline.baseline_score,
    current_score: currentScore,
    deviation_magnitude: deviationMagnitude,
    deviation_percentage: deviationPercentage,
    is_significant: Math.abs(deviationPercentage) >= significanceThreshold,
    significance_threshold: significanceThreshold
  };
}

/**
 * Determine potential impact based on deviation
 */
function determineImpact(deviationPercentage: number): PotentialImpact {
  const absDeviation = Math.abs(deviationPercentage);

  if (absDeviation >= IMPACT_THRESHOLDS.HIGH_DEVIATION_MIN) {
    return 'high';
  } else if (absDeviation >= IMPACT_THRESHOLDS.MEDIUM_DEVIATION_MIN) {
    return 'medium';
  } else {
    return 'low';
  }
}

/**
 * Calculate detection confidence based on evidence quality
 */
function calculateConfidence(
  baseline: UserBaseline,
  signalSources: OverloadSignalSource[],
  patternCount: number,
  deviationPercentage: number
): number {
  let confidence = 50; // Base confidence

  // Stable baseline adds confidence
  if (baseline.is_stable) {
    confidence += 20;
  }

  // More signal sources add confidence (max +15)
  confidence += Math.min(15, signalSources.length * 5);

  // Larger deviation adds confidence (max +10)
  if (Math.abs(deviationPercentage) >= 30) {
    confidence += 10;
  } else if (Math.abs(deviationPercentage) >= 20) {
    confidence += 5;
  }

  // More patterns add confidence (max +10)
  confidence += Math.min(10, patternCount * 5);

  return Math.min(100, confidence);
}

/**
 * Check if detection criteria are met (from spec)
 */
function meetsDetectionCriteria(
  patterns: ObservedPattern[],
  signalSources: OverloadSignalSource[],
  confidence: number,
  deviation: BaselineDeviation
): { meets: boolean; reason: string } {
  // Must have at least 2 observed patterns
  if (patterns.length < 2) {
    return { meets: false, reason: 'Insufficient patterns observed (need at least 2)' };
  }

  // Must have at least 2 independent signal sources
  if (signalSources.length < DETECTION_THRESHOLDS.MIN_SIGNAL_SOURCES) {
    return { meets: false, reason: `Insufficient signal sources (need at least ${DETECTION_THRESHOLDS.MIN_SIGNAL_SOURCES})` };
  }

  // Confidence must be at least 75%
  if (confidence < DETECTION_THRESHOLDS.MIN_CONFIDENCE) {
    return { meets: false, reason: `Confidence too low (${confidence}% < ${DETECTION_THRESHOLDS.MIN_CONFIDENCE}%)` };
  }

  // Must have significant deviation from baseline
  if (!deviation.is_significant) {
    return { meets: false, reason: 'Deviation from baseline not significant' };
  }

  // Check pattern persistence (≥7 days OR ≥3 spikes)
  const persistentPatterns = patterns.filter(p => {
    const daysSinceFirst = Math.ceil(
      (Date.now() - new Date(p.first_observed_at).getTime()) / (1000 * 60 * 60 * 24)
    );
    return daysSinceFirst >= DETECTION_THRESHOLDS.MIN_PERSISTENCE_DAYS ||
           p.observation_count >= DETECTION_THRESHOLDS.MIN_SPIKE_COUNT;
  });

  if (persistentPatterns.length === 0) {
    return {
      meets: false,
      reason: `Pattern not persistent enough (need ${DETECTION_THRESHOLDS.MIN_PERSISTENCE_DAYS} days or ${DETECTION_THRESHOLDS.MIN_SPIKE_COUNT} spikes)`
    };
  }

  return { meets: true, reason: 'All detection criteria met' };
}

/**
 * Map pattern types to dimensions
 */
function getPatternDimension(patternType: PatternType): OverloadDimension {
  const mapping: Record<PatternType, OverloadDimension> = {
    'sustained_low_energy': 'physical',
    'cognitive_decline': 'cognitive',
    'emotional_volatility': 'emotional',
    'routine_rigidity': 'routine',
    'social_withdrawal': 'social',
    'context_thrashing': 'context',
    'recovery_deficit': 'physical',
    'capacity_erosion': 'cognitive',
    'engagement_drop': 'cognitive',
    'stress_accumulation': 'emotional'
  };
  return mapping[patternType] || 'cognitive';
}

// =============================================================================
// VTID-01145: Public API Functions
// =============================================================================

/**
 * Compute baselines for all dimensions
 */
export async function computeBaselines(
  request: GetBaselineRequest = {},
  authToken?: string
): Promise<GetBaselineResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('overload_compute_baselines', {
      p_dimensions: request.dimensions || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (compute_baselines):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'Unknown error' };
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Computed baselines in ${duration}ms`);

    await emitD51Event(
      'overload.baseline.computed',
      'success',
      `Baselines computed for ${data.baselines?.length || 0} dimensions`,
      {
        dimension_count: data.baselines?.length || 0,
        duration_ms: duration
      }
    );

    return {
      ok: true,
      baselines: data.baselines,
      computed_at: data.computed_at
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing baselines:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get current baselines
 */
export async function getBaselines(
  request: GetBaselineRequest = {},
  authToken?: string
): Promise<GetBaselineResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('overload_get_baselines', {
      p_dimensions: request.dimensions || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (get_baselines):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'Unknown error' };
    }

    // If recompute requested, compute first
    if (request.recompute) {
      return computeBaselines(request, authToken);
    }

    return {
      ok: true,
      baselines: data.baselines
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting baselines:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Record an observed pattern
 */
export async function recordPattern(
  patternType: PatternType,
  dimension: OverloadDimension,
  signalSources: OverloadSignalSource[],
  intensity: number = 50,
  trendDirection: 'worsening' | 'stable' | 'improving' = 'stable',
  supportingEvidence?: string,
  authToken?: string
): Promise<{ ok: boolean; pattern_id?: string; error?: string }> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('overload_record_pattern', {
      p_pattern_type: patternType,
      p_dimension: dimension,
      p_signal_sources: signalSources,
      p_intensity: intensity,
      p_trend_direction: trendDirection,
      p_supporting_evidence: supportingEvidence || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (record_pattern):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'Unknown error' };
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Recorded pattern in ${duration}ms: ${patternType}/${dimension}`);

    await emitD51Event(
      'overload.pattern.observed',
      'info',
      `Pattern observed: ${patternType} in ${dimension}`,
      {
        pattern_type: patternType,
        dimension,
        signal_sources: signalSources,
        intensity,
        duration_ms: duration
      }
    );

    return {
      ok: true,
      pattern_id: data.pattern_id
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error recording pattern:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Compute detections - main detection function
 */
export async function computeDetections(
  request: ComputeDetectionRequest = {},
  authToken?: string
): Promise<ComputeDetectionResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const timeWindowDays = request.time_window_days || DETECTION_THRESHOLDS.DEFAULT_TIME_WINDOW_DAYS;

    const { data, error } = await supabase.rpc('overload_detect', {
      p_time_window_days: timeWindowDays,
      p_dimensions: request.dimensions || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (detect):`, error);

      await emitD51Event(
        'overload.detection.failed',
        'error',
        `Detection failed: ${error.message}`,
        {
          error: error.message,
          time_window_days: timeWindowDays
        }
      );

      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'Unknown error' };
    }

    const duration = Date.now() - startTime;
    const detectionCount = data.detections?.length || 0;

    console.log(`${LOG_PREFIX} Computed detections in ${duration}ms: ${detectionCount} found`);

    // Emit OASIS event for detection computation
    await emitD51Event(
      'overload.detection.computed',
      'success',
      `Detection analysis complete: ${detectionCount} detection(s) found`,
      {
        detection_count: detectionCount,
        patterns_observed_count: data.patterns_observed?.length || 0,
        time_window_days: timeWindowDays,
        duration_ms: duration
      }
    );

    // Emit individual detection events
    if (data.detections && data.detections.length > 0) {
      for (const detection of data.detections) {
        await emitD51Event(
          'overload.detected',
          'info',
          `Overload pattern detected in ${detection.dimension}`,
          {
            overload_id: detection.overload_id,
            dimension: detection.dimension,
            confidence: detection.confidence,
            time_window: detection.time_window,
            potential_impact: detection.potential_impact,
            pattern_count: detection.observed_patterns?.length || 0
          }
        );
      }
    }

    return {
      ok: true,
      detections: data.detections || [],
      patterns_observed: data.patterns_observed || []
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing detections:`, errorMessage);

    await emitD51Event(
      'overload.detection.failed',
      'error',
      `Detection failed: ${errorMessage}`,
      {
        error: errorMessage
      }
    );

    return { ok: false, error: errorMessage };
  }
}

/**
 * Get current detections
 */
export async function getDetections(
  request: GetDetectionsRequest = {},
  authToken?: string
): Promise<GetDetectionsResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('overload_get_detections', {
      p_include_dismissed: request.include_dismissed || false,
      p_limit: request.limit || 10
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (get_detections):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'Unknown error' };
    }

    return {
      ok: true,
      detections: data.detections || [],
      count: data.count || 0
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting detections:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Dismiss a detection
 */
export async function dismissDetection(
  request: DismissDetectionRequest,
  authToken?: string
): Promise<DismissDetectionResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('overload_dismiss', {
      p_overload_id: request.overload_id,
      p_reason: request.reason || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (dismiss):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'Unknown error' };
    }

    console.log(`${LOG_PREFIX} Detection dismissed: ${request.overload_id}`);

    await emitD51Event(
      'overload.dismissed',
      'info',
      `Detection dismissed by user`,
      {
        overload_id: request.overload_id,
        reason: request.reason || 'No reason provided'
      }
    );

    return {
      ok: true,
      overload_id: data.overload_id,
      dismissed_at: data.dismissed_at
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error dismissing detection:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Explain a detection
 */
export async function explainDetection(
  request: ExplainDetectionRequest,
  authToken?: string
): Promise<ExplainDetectionResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('overload_explain', {
      p_overload_id: request.overload_id
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (explain):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'Unknown error' };
    }

    // Extract signal sources from patterns
    const signalSources: OverloadSignalSource[] = [];
    if (data.patterns && Array.isArray(data.patterns)) {
      for (const pattern of data.patterns) {
        if (pattern.signal_sources) {
          for (const source of pattern.signal_sources) {
            if (!signalSources.includes(source)) {
              signalSources.push(source);
            }
          }
        }
      }
    }

    return {
      ok: true,
      detection: data.detection,
      patterns: data.patterns,
      baseline_deviation: data.baseline_deviation,
      signal_sources: signalSources,
      explainability_text: data.detection?.explainability_text
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error explaining detection:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

// =============================================================================
// VTID-01145: Signal Integration Functions
// =============================================================================

/**
 * Analyze longitudinal trends for overload patterns
 * Integrates with D43 Longitudinal Adaptation Engine
 */
export async function analyzeFromLongitudinalTrends(
  authToken?: string
): Promise<ObservedPattern[]> {
  const patterns: ObservedPattern[] = [];

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      console.warn(`${LOG_PREFIX} Cannot analyze longitudinal trends: ${clientError}`);
      return patterns;
    }

    // Get D43 data points from last 21 days
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 21);

    const { data: dataPoints, error } = await supabase.rpc('d43_get_data_points', {
      p_domains: ['health', 'engagement'],
      p_since: cutoffDate.toISOString(),
      p_limit: 100
    });

    if (error || !dataPoints || dataPoints.length === 0) {
      return patterns;
    }

    // Analyze for patterns
    const healthPoints = dataPoints.filter((dp: any) => dp.domain === 'health');
    const engagementPoints = dataPoints.filter((dp: any) => dp.domain === 'engagement');

    // Check for sustained low energy pattern
    const lowEnergyPoints = healthPoints.filter((dp: any) =>
      dp.numeric_value !== null && dp.numeric_value < 40
    );

    if (lowEnergyPoints.length >= 3) {
      patterns.push({
        pattern_type: 'sustained_low_energy',
        signal_sources: ['longitudinal_trends'],
        first_observed_at: lowEnergyPoints[0].recorded_at,
        observation_count: lowEnergyPoints.length,
        intensity: Math.round(
          100 - (lowEnergyPoints.reduce((sum: number, dp: any) => sum + dp.numeric_value, 0) / lowEnergyPoints.length)
        ),
        trend_direction: 'stable',
        supporting_evidence: `${lowEnergyPoints.length} low-energy observations in health domain`
      });
    }

    // Check for engagement drop pattern
    const lowEngagementPoints = engagementPoints.filter((dp: any) =>
      dp.numeric_value !== null && dp.numeric_value < 40
    );

    if (lowEngagementPoints.length >= 3) {
      patterns.push({
        pattern_type: 'engagement_drop',
        signal_sources: ['longitudinal_trends'],
        first_observed_at: lowEngagementPoints[0].recorded_at,
        observation_count: lowEngagementPoints.length,
        intensity: Math.round(
          100 - (lowEngagementPoints.reduce((sum: number, dp: any) => sum + dp.numeric_value, 0) / lowEngagementPoints.length)
        ),
        trend_direction: 'stable',
        supporting_evidence: `${lowEngagementPoints.length} low-engagement observations`
      });
    }

  } catch (err) {
    console.warn(`${LOG_PREFIX} Error analyzing longitudinal trends:`, err);
  }

  return patterns;
}

/**
 * Analyze behavioral signals for overload patterns
 * Integrates with D44/D28 Emotional & Cognitive Signals
 */
export async function analyzeFromBehavioralSignals(
  authToken?: string
): Promise<ObservedPattern[]> {
  const patterns: ObservedPattern[] = [];

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      console.warn(`${LOG_PREFIX} Cannot analyze behavioral signals: ${clientError}`);
      return patterns;
    }

    // Get D28 emotional/cognitive signals from last 21 days
    const { data: signals, error } = await supabase
      .from('emotional_cognitive_signals')
      .select('*')
      .eq('decayed', false)
      .gte('created_at', new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: true });

    if (error || !signals || signals.length === 0) {
      return patterns;
    }

    // Analyze for cognitive overload patterns
    const overloadedSignals = signals.filter((s: any) => {
      const cogStates = s.cognitive_states || [];
      return cogStates.some((cs: any) => cs.state === 'overloaded' && cs.score >= 50);
    });

    if (overloadedSignals.length >= 3) {
      patterns.push({
        pattern_type: 'cognitive_decline',
        signal_sources: ['behavioral_signals'],
        first_observed_at: overloadedSignals[0].created_at,
        observation_count: overloadedSignals.length,
        intensity: 65,
        trend_direction: overloadedSignals.length > 5 ? 'worsening' : 'stable',
        supporting_evidence: `${overloadedSignals.length} cognitive overload signals detected`
      });
    }

    // Analyze for emotional volatility patterns
    const stressedSignals = signals.filter((s: any) => {
      const emoStates = s.emotional_states || [];
      return emoStates.some((es: any) =>
        (es.state === 'stressed' || es.state === 'anxious') && es.score >= 50
      );
    });

    if (stressedSignals.length >= 3) {
      patterns.push({
        pattern_type: 'emotional_volatility',
        signal_sources: ['behavioral_signals'],
        first_observed_at: stressedSignals[0].created_at,
        observation_count: stressedSignals.length,
        intensity: 60,
        trend_direction: 'stable',
        supporting_evidence: `${stressedSignals.length} elevated stress/anxiety signals detected`
      });
    }

  } catch (err) {
    console.warn(`${LOG_PREFIX} Error analyzing behavioral signals:`, err);
  }

  return patterns;
}

/**
 * Analyze capacity state for overload patterns
 * Integrates with D37 Health Capacity Engine
 */
export async function analyzeFromCapacityState(
  authToken?: string
): Promise<ObservedPattern[]> {
  const patterns: ObservedPattern[] = [];

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      console.warn(`${LOG_PREFIX} Cannot analyze capacity state: ${clientError}`);
      return patterns;
    }

    // Get capacity states from last 21 days
    const { data: capacityStates, error } = await supabase
      .from('capacity_state')
      .select('*')
      .eq('decayed', false)
      .gte('created_at', new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: true });

    if (error || !capacityStates || capacityStates.length === 0) {
      return patterns;
    }

    // Analyze for capacity erosion pattern
    const lowCapacityStates = capacityStates.filter((cs: any) =>
      cs.capacity_overall < 40
    );

    if (lowCapacityStates.length >= 3) {
      patterns.push({
        pattern_type: 'capacity_erosion',
        signal_sources: ['behavioral_signals'],
        first_observed_at: lowCapacityStates[0].created_at,
        observation_count: lowCapacityStates.length,
        intensity: Math.round(
          100 - (lowCapacityStates.reduce((sum: number, cs: any) => sum + cs.capacity_overall, 0) / lowCapacityStates.length)
        ),
        trend_direction: 'stable',
        supporting_evidence: `${lowCapacityStates.length} low-capacity states observed`
      });
    }

    // Analyze for recovery deficit pattern
    const lowEnergyStates = capacityStates.filter((cs: any) =>
      cs.energy_state === 'low'
    );

    if (lowEnergyStates.length >= 4) {
      patterns.push({
        pattern_type: 'recovery_deficit',
        signal_sources: ['behavioral_signals'],
        first_observed_at: lowEnergyStates[0].created_at,
        observation_count: lowEnergyStates.length,
        intensity: 60,
        trend_direction: lowEnergyStates.length > 7 ? 'worsening' : 'stable',
        supporting_evidence: `${lowEnergyStates.length} low-energy states observed without recovery`
      });
    }

  } catch (err) {
    console.warn(`${LOG_PREFIX} Error analyzing capacity state:`, err);
  }

  return patterns;
}

/**
 * Full analysis pipeline - gather patterns from all sources and record them
 */
export async function analyzeAndRecordPatterns(
  authToken?: string
): Promise<{ ok: boolean; patterns_recorded: number; error?: string }> {
  const startTime = Date.now();
  let patternsRecorded = 0;

  try {
    // Gather patterns from all sources in parallel
    const [longitudinalPatterns, behavioralPatterns, capacityPatterns] = await Promise.all([
      analyzeFromLongitudinalTrends(authToken),
      analyzeFromBehavioralSignals(authToken),
      analyzeFromCapacityState(authToken)
    ]);

    const allPatterns = [...longitudinalPatterns, ...behavioralPatterns, ...capacityPatterns];

    // Record each pattern
    for (const pattern of allPatterns) {
      const dimension = getPatternDimension(pattern.pattern_type);
      const result = await recordPattern(
        pattern.pattern_type,
        dimension,
        pattern.signal_sources,
        pattern.intensity,
        pattern.trend_direction,
        pattern.supporting_evidence,
        authToken
      );

      if (result.ok) {
        patternsRecorded++;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Analysis complete in ${duration}ms: ${patternsRecorded} patterns recorded`);

    return {
      ok: true,
      patterns_recorded: patternsRecorded
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error in analysis pipeline:`, errorMessage);
    return { ok: false, patterns_recorded: patternsRecorded, error: errorMessage };
  }
}

// =============================================================================
// VTID-01145: ORB Integration Functions
// =============================================================================

/**
 * Get overload context for ORB system prompt injection
 *
 * Returns a formatted string describing active overload detections
 * for injection into response modulation decisions.
 */
export async function getOverloadContextForOrb(
  authToken?: string
): Promise<{ context: string; hasActiveDetections: boolean } | null> {
  try {
    const detectionsResult = await getDetections(
      { include_dismissed: false, limit: 5 },
      authToken
    );

    if (!detectionsResult.ok || !detectionsResult.detections) {
      return null;
    }

    const activeDetections = detectionsResult.detections;

    if (activeDetections.length === 0) {
      return { context: '', hasActiveDetections: false };
    }

    const contextLines: string[] = [
      '## Current Awareness Signals (D51)',
      `[${OVERLOAD_DISCLAIMER}]`,
      ''
    ];

    for (const detection of activeDetections) {
      const dimMeta = DIMENSION_METADATA[detection.dimension as OverloadDimension];
      contextLines.push(
        `- ${dimMeta?.label || detection.dimension}: ${detection.potential_impact} impact ` +
        `(${detection.confidence}% confidence)`
      );
    }

    contextLines.push('');
    contextLines.push('### Response Modulation');
    contextLines.push('- Consider gentler pacing and reduced demands');
    contextLines.push('- Avoid suggesting high-intensity activities');
    contextLines.push('- These observations are dismissible by the user');

    return {
      context: contextLines.join('\n'),
      hasActiveDetections: true
    };

  } catch (err) {
    console.error(`${LOG_PREFIX} Error getting overload context for ORB:`, err);
    return null;
  }
}

// =============================================================================
// VTID-01145: Exports
// =============================================================================

export {
  calculateBaselineDeviation,
  determineImpact,
  calculateConfidence,
  meetsDetectionCriteria,
  getPatternDimension,
  DETECTION_THRESHOLDS,
  IMPACT_THRESHOLDS
};

export type {
  OverloadDimension,
  OverloadSignalSource,
  PatternType,
  PotentialImpact,
  TimeWindow,
  ObservedPattern,
  UserBaseline,
  BaselineDeviation,
  OverloadDetection,
  DetectionResult
};

export default {
  VTID,
  computeBaselines,
  getBaselines,
  recordPattern,
  computeDetections,
  getDetections,
  dismissDetection,
  explainDetection,
  analyzeFromLongitudinalTrends,
  analyzeFromBehavioralSignals,
  analyzeFromCapacityState,
  analyzeAndRecordPatterns,
  getOverloadContextForOrb
};
