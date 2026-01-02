/**
 * VTID-01137: D43 Longitudinal Adaptation, Drift Detection & Personal Evolution Engine
 *
 * Core Intelligence Engine that ensures the system evolves with the user over time
 * instead of locking them into outdated assumptions.
 *
 * D43 detects personal drift, life changes, and evolving preferences, and adapts
 * intelligence accordingly - safely, gradually, and transparently.
 *
 * It answers: "Is who this person is today the same as who they were weeks or months ago?"
 *
 * Core Principles:
 *   - Never overwrite core preferences abruptly
 *   - Preserve historical context
 *   - Allow regression to prior state
 *   - Treat change as exploration unless confirmed
 *   - Prefer user confirmation for major shifts
 *
 * Determinism Rules:
 *   - Same longitudinal signals → same drift detection
 *   - Same drift events → same adaptation plan
 *   - Rule-based, no generative inference at this layer
 *
 * Position in Intelligence Stack:
 *   D31 Response Framing → D43 Longitudinal Adaptation → Output Generation
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  LongitudinalDomain,
  DriftType,
  EvolutionTag,
  AdaptationStrategy,
  LongitudinalDataPoint,
  TrendAnalysis,
  TrendDirection,
  LongitudinalSignalBundle,
  DriftEvent,
  DriftDetectionResult,
  DomainAdaptation,
  AdaptationPlan,
  PreferenceSnapshot,
  RecordDataPointRequest,
  RecordDataPointResponse,
  GetTrendsRequest,
  GetTrendsResponse,
  DetectDriftRequest,
  GetAdaptationPlansResponse,
  ApproveAdaptationRequest,
  ApproveAdaptationResponse,
  RollbackAdaptationRequest,
  RollbackAdaptationResponse,
  GetEvolutionStateResponse,
  AcknowledgeDriftRequest,
  AcknowledgeDriftResponse,
  DRIFT_THRESHOLDS,
  SENSITIVITY_PRESETS
} from '../types/longitudinal-adaptation';

// =============================================================================
// VTID-01137: Constants
// =============================================================================

export const VTID = 'VTID-01137';
const LOG_PREFIX = '[D43-Engine]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

// =============================================================================
// VTID-01137: Environment Detection
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
// VTID-01137: Supabase Client Factory
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
// VTID-01137: OASIS Event Emission
// =============================================================================

async function emitD43Event(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as any,
      source: 'd43-longitudinal-engine',
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
// VTID-01137: Core Trend Analysis (Deterministic)
// =============================================================================

/**
 * Calculate trend direction from a series of numeric values
 * Uses simple linear regression for determinism
 */
function calculateTrendDirection(values: number[]): {
  direction: TrendDirection;
  slope: number;
  r_squared: number;
} {
  if (values.length < 2) {
    return { direction: 'unknown', slope: 0, r_squared: 0 };
  }

  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;
  let ssRes = 0;
  let ssTot = 0;

  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (values[i] - yMean);
    denominator += (i - xMean) * (i - xMean);
  }

  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;

  // Calculate R-squared
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    ssRes += (values[i] - predicted) ** 2;
    ssTot += (values[i] - yMean) ** 2;
  }

  const r_squared = ssTot !== 0 ? 1 - (ssRes / ssTot) : 0;

  // Determine direction based on slope magnitude
  let direction: TrendDirection;
  const normalizedSlope = slope / (yMean || 1); // Normalize to percentage change

  if (Math.abs(normalizedSlope) < 0.01) {
    direction = 'stable';
  } else if (r_squared < 0.3) {
    direction = 'oscillating';
  } else if (normalizedSlope > 0) {
    direction = 'increasing';
  } else {
    direction = 'decreasing';
  }

  return { direction, slope, r_squared };
}

/**
 * Analyze trend for a specific domain and key
 */
function analyzeTrend(
  dataPoints: LongitudinalDataPoint[],
  domain: LongitudinalDomain,
  key: string
): TrendAnalysis | null {
  if (dataPoints.length < DRIFT_THRESHOLDS.MIN_DATA_POINTS_FOR_TREND) {
    return null;
  }

  // Filter to relevant data points
  const relevantPoints = dataPoints
    .filter(dp => dp.domain === domain && dp.key === key && dp.numeric_value !== null)
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());

  if (relevantPoints.length < DRIFT_THRESHOLDS.MIN_DATA_POINTS_FOR_TREND) {
    return null;
  }

  const numericValues = relevantPoints.map(p => p.numeric_value as number);
  const { direction, slope, r_squared } = calculateTrendDirection(numericValues);

  const firstDate = new Date(relevantPoints[0].recorded_at);
  const lastDate = new Date(relevantPoints[relevantPoints.length - 1].recorded_at);
  const timeSpanDays = Math.ceil((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24));

  // Calculate magnitude as percentage change from first to last
  const firstValue = numericValues[0];
  const lastValue = numericValues[numericValues.length - 1];
  const magnitude = firstValue !== 0
    ? Math.min(100, Math.abs(((lastValue - firstValue) / firstValue) * 100))
    : (lastValue !== 0 ? 100 : 0);

  // Velocity is the slope normalized by time
  const velocity = timeSpanDays > 0 ? slope / timeSpanDays : 0;

  // Confidence based on R-squared and data point count
  const dataConfidence = Math.min(100, relevantPoints.length * 5);
  const confidence = Math.round((r_squared * 100 * 0.6) + (dataConfidence * 0.4));

  return {
    domain,
    key,
    direction,
    magnitude: Math.round(magnitude),
    velocity,
    data_points_count: relevantPoints.length,
    time_span_days: timeSpanDays,
    first_observation: relevantPoints[0].recorded_at,
    last_observation: relevantPoints[relevantPoints.length - 1].recorded_at,
    confidence,
    baseline_value: relevantPoints[0].value,
    current_value: relevantPoints[relevantPoints.length - 1].value
  };
}

// =============================================================================
// VTID-01137: Drift Detection (Deterministic)
// =============================================================================

/**
 * Detect drift type based on trend characteristics
 */
function detectDriftType(
  trend: TrendAnalysis,
  sensitivity: 'low' | 'medium' | 'high'
): { type: DriftType; confidence: number } {
  const preset = SENSITIVITY_PRESETS[sensitivity];

  // Not enough data or low magnitude = stable
  if (trend.magnitude < preset.magnitude_threshold) {
    return { type: 'stable', confidence: 100 - trend.magnitude };
  }

  // Check for abrupt change (high magnitude in short time)
  if (trend.time_span_days <= DRIFT_THRESHOLDS.ABRUPT_DRIFT_MAX_DAYS && trend.magnitude > 40) {
    return { type: 'abrupt', confidence: Math.min(95, trend.confidence + 10) };
  }

  // Check for seasonal pattern (oscillating with moderate magnitude)
  if (trend.direction === 'oscillating' && trend.time_span_days >= DRIFT_THRESHOLDS.SEASONAL_CYCLE_DAYS * 2) {
    return { type: 'seasonal', confidence: Math.min(85, trend.confidence) };
  }

  // Check for gradual drift (sustained change over time)
  if (trend.time_span_days >= DRIFT_THRESHOLDS.GRADUAL_DRIFT_MIN_DAYS) {
    if (trend.direction === 'increasing' || trend.direction === 'decreasing') {
      return { type: 'gradual', confidence: trend.confidence };
    }
  }

  // Low confidence changes are experimental
  if (trend.confidence < preset.confidence_threshold) {
    return { type: 'experimental', confidence: trend.confidence };
  }

  // Check for regression (return to baseline)
  const baselineNum = typeof trend.baseline_value === 'number' ? trend.baseline_value : null;
  const currentNum = typeof trend.current_value === 'number' ? trend.current_value : null;
  if (baselineNum !== null && currentNum !== null) {
    const deviation = Math.abs(currentNum - baselineNum) / Math.abs(baselineNum || 1);
    if (deviation < 0.1 && trend.magnitude > 20) {
      return { type: 'regression', confidence: Math.min(80, trend.confidence) };
    }
  }

  return { type: 'gradual', confidence: trend.confidence };
}

/**
 * Determine evolution tags from drift events
 */
function deriveEvolutionTags(driftEvents: DriftEvent[]): EvolutionTag[] {
  const tags = new Set<EvolutionTag>();

  if (driftEvents.length === 0) {
    tags.add('stable_preferences');
    return Array.from(tags);
  }

  for (const event of driftEvents) {
    switch (event.type) {
      case 'stable':
        tags.add('stable_preferences');
        break;
      case 'gradual':
      case 'abrupt':
        tags.add('drift_detected');
        if (event.magnitude >= 60) {
          tags.add('major_shift_candidate');
        }
        break;
      case 'experimental':
        tags.add('exploration_phase');
        break;
      case 'seasonal':
        tags.add('seasonal_pattern');
        break;
      case 'regression':
        tags.add('regression_detected');
        break;
    }
  }

  // Remove stable if any drift is detected
  if (tags.has('drift_detected') || tags.has('major_shift_candidate')) {
    tags.delete('stable_preferences');
  }

  return Array.from(tags);
}

/**
 * Calculate overall stability score
 */
function calculateStabilityScore(driftEvents: DriftEvent[]): number {
  if (driftEvents.length === 0) {
    return 100;
  }

  // Average inverse of magnitude weighted by confidence
  let totalWeight = 0;
  let weightedStability = 0;

  for (const event of driftEvents) {
    if (event.type !== 'stable') {
      const weight = event.confidence / 100;
      const stability = 100 - event.magnitude;
      weightedStability += stability * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) {
    return 100;
  }

  return Math.round(weightedStability / totalWeight);
}

// =============================================================================
// VTID-01137: Adaptation Planning (Deterministic)
// =============================================================================

/**
 * Determine adaptation strategy based on drift characteristics
 */
function determineAdaptationStrategy(
  driftType: DriftType,
  magnitude: number,
  confidence: number
): AdaptationStrategy {
  // High confidence, high magnitude changes get staged adoption
  if (confidence >= DRIFT_THRESHOLDS.AUTO_ADAPT_CONFIDENCE && magnitude >= 50) {
    return 'staged_adoption';
  }

  // Medium confidence or lower magnitude gets parallel hypothesis
  if (confidence >= DRIFT_THRESHOLDS.CONFIRMATION_REQUIRED_ABOVE) {
    if (driftType === 'gradual') {
      return 'soft_reweight';
    }
    if (driftType === 'experimental') {
      return 'parallel_hypothesis';
    }
    return 'confirm_with_user';
  }

  // Low confidence means we need more data
  if (confidence < DRIFT_THRESHOLDS.CONFIRMATION_REQUIRED_ABOVE) {
    return 'hold';
  }

  // Regression means rollback might be appropriate
  if (driftType === 'regression') {
    return 'rollback';
  }

  return 'soft_reweight';
}

/**
 * Build adaptation plan from drift events
 */
function buildAdaptationPlan(
  driftEvents: DriftEvent[],
  triggeredBy: 'drift_detection' | 'user_feedback' | 'scheduled' | 'manual'
): Omit<AdaptationPlan, 'id' | 'created_at' | 'updated_at'> | null {
  // Filter to actionable drift events
  const actionableEvents = driftEvents.filter(
    e => e.type !== 'stable' &&
         e.magnitude >= DRIFT_THRESHOLDS.MIN_MAGNITUDE_FOR_ADAPTATION &&
         e.confidence >= DRIFT_THRESHOLDS.MIN_CONFIDENCE
  );

  if (actionableEvents.length === 0) {
    return null;
  }

  const domainAdaptations: DomainAdaptation[] = [];
  let requiresConfirmation = false;
  let totalConfidence = 0;

  for (const event of actionableEvents) {
    const strategy = determineAdaptationStrategy(event.type, event.magnitude, event.confidence);

    if (strategy === 'confirm_with_user') {
      requiresConfirmation = true;
    }

    // Create adaptation for each affected domain
    for (const domain of event.domains_affected) {
      domainAdaptations.push({
        domain,
        strategy,
        strength: Math.round(event.magnitude * (event.confidence / 100)),
        old_value: null,  // Would be populated from preference snapshot
        new_value: null,  // Would be populated from latest observation
        confidence: event.confidence,
        requires_confirmation: strategy === 'confirm_with_user',
        reason: `${event.type} drift detected with ${event.magnitude}% magnitude`
      });
    }

    totalConfidence += event.confidence;
  }

  const avgConfidence = Math.round(totalConfidence / actionableEvents.length);
  const maxMagnitude = Math.max(...actionableEvents.map(e => e.magnitude));
  const adaptationStrength = Math.round(maxMagnitude * (avgConfidence / 100));

  // Determine if user confirmation is needed
  if (avgConfidence < DRIFT_THRESHOLDS.AUTO_ADAPT_CONFIDENCE || maxMagnitude >= 60) {
    requiresConfirmation = true;
  }

  const rollbackUntil = new Date();
  rollbackUntil.setDate(rollbackUntil.getDate() + DRIFT_THRESHOLDS.ROLLBACK_WINDOW_DAYS);

  return {
    domains_to_update: domainAdaptations,
    adaptation_strength: adaptationStrength,
    confirmation_needed: requiresConfirmation,
    confidence: avgConfidence,
    triggered_by_drift_id: actionableEvents[0]?.id || null,
    triggered_by: triggeredBy,
    status: requiresConfirmation ? 'pending_confirmation' : 'proposed',
    proposed_at: new Date().toISOString(),
    applied_at: null,
    can_rollback: true,
    rollback_until: rollbackUntil.toISOString()
  };
}

// =============================================================================
// VTID-01137: Public API Functions
// =============================================================================

/**
 * Record a longitudinal data point
 */
export async function recordDataPoint(
  request: RecordDataPointRequest,
  authToken?: string
): Promise<RecordDataPointResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d43_record_data_point', {
      p_domain: request.domain,
      p_key: request.key,
      p_value: request.value,
      p_numeric_value: request.numeric_value || null,
      p_source: request.source,
      p_confidence: request.confidence,
      p_metadata: request.metadata || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (record_data_point):`, error);
      return { ok: false, error: error.message };
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Recorded data point in ${duration}ms: ${request.domain}/${request.key}`);

    await emitD43Event(
      'd43.data_point.recorded',
      'success',
      `Data point recorded: ${request.domain}/${request.key}`,
      {
        domain: request.domain,
        key: request.key,
        data_point_id: data?.id,
        duration_ms: duration
      }
    );

    return {
      ok: true,
      data_point_id: data?.id,
      domain: request.domain,
      key: request.key
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error recording data point:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get longitudinal trends for specified domains
 */
export async function getTrends(
  request: GetTrendsRequest,
  authToken?: string
): Promise<GetTrendsResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    // Fetch data points from the past N days
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - request.time_window_days);

    const { data: dataPoints, error } = await supabase.rpc('d43_get_data_points', {
      p_domains: request.domains || null,
      p_since: cutoffDate.toISOString(),
      p_limit: 1000
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (get_data_points):`, error);
      return { ok: false, error: error.message };
    }

    if (!dataPoints || dataPoints.length < request.min_data_points) {
      return {
        ok: true,
        signals: {
          computed_at: new Date().toISOString()
        },
        data_points_count: dataPoints?.length || 0,
        time_span_days: request.time_window_days
      };
    }

    // Group data points by domain and find primary key per domain
    const domainGroups = new Map<LongitudinalDomain, LongitudinalDataPoint[]>();
    for (const dp of dataPoints as LongitudinalDataPoint[]) {
      const existing = domainGroups.get(dp.domain) || [];
      existing.push(dp);
      domainGroups.set(dp.domain, existing);
    }

    // Analyze trends for each domain
    const signals: LongitudinalSignalBundle = {
      computed_at: new Date().toISOString()
    };

    for (const [domain, points] of domainGroups) {
      // Get the most common key for this domain
      const keyCounts = new Map<string, number>();
      for (const p of points) {
        keyCounts.set(p.key, (keyCounts.get(p.key) || 0) + 1);
      }
      const primaryKey = [...keyCounts.entries()]
        .sort((a, b) => b[1] - a[1])[0]?.[0];

      if (primaryKey) {
        const trend = analyzeTrend(points, domain, primaryKey);
        if (trend) {
          const trendKey = `${domain}_trend` as keyof LongitudinalSignalBundle;
          (signals as any)[trendKey] = trend;
        }
      }
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Computed trends in ${duration}ms, ${dataPoints.length} data points`);

    await emitD43Event(
      'd43.trend.computed',
      'success',
      `Trends computed for ${domainGroups.size} domains`,
      {
        domains_analyzed: Array.from(domainGroups.keys()),
        data_points_count: dataPoints.length,
        duration_ms: duration
      }
    );

    return {
      ok: true,
      signals,
      data_points_count: dataPoints.length,
      time_span_days: request.time_window_days
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting trends:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Detect drift across domains
 */
export async function detectDrift(
  request: DetectDriftRequest,
  authToken?: string
): Promise<DriftDetectionResult> {
  const startTime = Date.now();

  try {
    // First get the trends
    const trendsResult = await getTrends({
      domains: request.domains,
      time_window_days: request.time_window_days,
      min_data_points: SENSITIVITY_PRESETS[request.sensitivity].min_data_points
    }, authToken);

    if (!trendsResult.ok || !trendsResult.signals) {
      return {
        ok: false,
        drift_detected: false,
        events: [],
        overall_stability: 100,
        evolution_tags: ['stable_preferences'],
        error: trendsResult.error
      };
    }

    const driftEvents: DriftEvent[] = [];
    const signals = trendsResult.signals;
    const now = new Date().toISOString();

    // Analyze each trend for drift
    const trendKeys = [
      'preference_trend', 'goal_trend', 'engagement_trend',
      'social_trend', 'monetization_trend', 'health_trend',
      'communication_trend', 'autonomy_trend'
    ] as const;

    for (const trendKey of trendKeys) {
      const trend = signals[trendKey] as TrendAnalysis | null | undefined;
      if (!trend) continue;

      const { type: driftType, confidence } = detectDriftType(trend, request.sensitivity);

      if (driftType !== 'stable' && confidence >= DRIFT_THRESHOLDS.MIN_CONFIDENCE) {
        const event: DriftEvent = {
          id: crypto.randomUUID(),
          type: driftType,
          magnitude: trend.magnitude,
          confidence,
          domains_affected: [trend.domain],
          detected_at: now,
          evidence_summary: `${trend.direction} trend detected over ${trend.time_span_days} days with ${trend.data_points_count} observations`,
          data_points_analyzed: trend.data_points_count,
          time_window_days: trend.time_span_days,
          trigger_hypothesis: driftType === 'abrupt' ? 'Possible life event or context change' : null,
          is_seasonal_pattern: driftType === 'seasonal',
          acknowledged_by_user: false,
          acknowledged_at: null,
          created_at: now,
          updated_at: now
        };

        driftEvents.push(event);
      }
    }

    const evolutionTags = deriveEvolutionTags(driftEvents);
    const overallStability = calculateStabilityScore(driftEvents);

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Drift detection completed in ${duration}ms, ${driftEvents.length} events detected`);

    // Emit event if drift was detected
    if (driftEvents.length > 0) {
      await emitD43Event(
        'd43.drift.detected',
        'info',
        `Drift detected in ${driftEvents.length} domain(s)`,
        {
          drift_count: driftEvents.length,
          domains_affected: [...new Set(driftEvents.flatMap(e => e.domains_affected))],
          evolution_tags: evolutionTags,
          overall_stability: overallStability,
          duration_ms: duration
        }
      );
    }

    return {
      ok: true,
      drift_detected: driftEvents.length > 0,
      events: driftEvents,
      overall_stability: overallStability,
      evolution_tags: evolutionTags,
      recommendation: driftEvents.length > 0
        ? 'Consider reviewing adaptation plans for detected changes'
        : 'No significant drift detected, preferences appear stable'
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error detecting drift:`, errorMessage);
    return {
      ok: false,
      drift_detected: false,
      events: [],
      overall_stability: 100,
      evolution_tags: [],
      error: errorMessage
    };
  }
}

/**
 * Get current evolution state for a user
 */
export async function getEvolutionState(authToken?: string): Promise<GetEvolutionStateResponse> {
  try {
    // Detect drift with medium sensitivity over last 30 days
    const driftResult = await detectDrift({
      sensitivity: 'medium',
      time_window_days: 30
    }, authToken);

    if (!driftResult.ok) {
      return { ok: false, error: driftResult.error };
    }

    // Get pending adaptations
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data: pendingPlans, error: planError } = await supabase.rpc('d43_get_pending_adaptations', {
      p_limit: 5
    });

    // Find last major change
    const majorEvents = driftResult.events.filter(e => e.magnitude >= 60);
    const lastMajorChange = majorEvents.length > 0
      ? majorEvents.sort((a, b) =>
          new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime()
        )[0].detected_at
      : undefined;

    return {
      ok: true,
      evolution_tags: driftResult.evolution_tags,
      overall_stability: driftResult.overall_stability,
      active_drift_events: driftResult.events,
      pending_adaptations: planError ? [] : (pendingPlans || []),
      last_major_change: lastMajorChange
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting evolution state:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Generate an adaptation plan from detected drift
 */
export async function generateAdaptationPlan(
  driftEvents: DriftEvent[],
  triggeredBy: 'drift_detection' | 'user_feedback' | 'scheduled' | 'manual' = 'drift_detection',
  authToken?: string
): Promise<{ ok: boolean; plan?: AdaptationPlan; error?: string }> {
  try {
    const planData = buildAdaptationPlan(driftEvents, triggeredBy);

    if (!planData) {
      return { ok: true, plan: undefined };  // No adaptation needed
    }

    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    // Store the plan
    const { data, error } = await supabase.rpc('d43_create_adaptation_plan', {
      p_plan: planData
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (create_adaptation_plan):`, error);
      return { ok: false, error: error.message };
    }

    console.log(`${LOG_PREFIX} Adaptation plan created: ${data?.id}`);

    await emitD43Event(
      'd43.adaptation.proposed',
      'info',
      `Adaptation plan proposed for ${planData.domains_to_update.length} domain(s)`,
      {
        plan_id: data?.id,
        domains_to_update: planData.domains_to_update.map(d => d.domain),
        adaptation_strength: planData.adaptation_strength,
        confirmation_needed: planData.confirmation_needed
      }
    );

    return { ok: true, plan: data };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error generating adaptation plan:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Approve or reject an adaptation plan
 */
export async function approveAdaptation(
  request: ApproveAdaptationRequest,
  authToken?: string
): Promise<ApproveAdaptationResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const newStatus = request.confirm ? 'approved' : 'rejected';

    const { data, error } = await supabase.rpc('d43_update_adaptation_status', {
      p_plan_id: request.plan_id,
      p_status: newStatus,
      p_apply: request.confirm
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (update_adaptation_status):`, error);
      return { ok: false, error: error.message };
    }

    const eventType = request.confirm ? 'd43.adaptation.approved' : 'd43.adaptation.rejected';
    await emitD43Event(
      eventType,
      'success',
      `Adaptation plan ${request.confirm ? 'approved and applied' : 'rejected'}`,
      {
        plan_id: request.plan_id,
        status: newStatus
      }
    );

    return {
      ok: true,
      plan_id: request.plan_id,
      status: newStatus,
      applied_at: request.confirm ? new Date().toISOString() : undefined
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error approving adaptation:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Rollback a previously applied adaptation
 */
export async function rollbackAdaptation(
  request: RollbackAdaptationRequest,
  authToken?: string
): Promise<RollbackAdaptationResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d43_rollback_adaptation', {
      p_plan_id: request.plan_id,
      p_reason: request.reason || 'User requested rollback'
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (rollback_adaptation):`, error);
      return { ok: false, error: error.message };
    }

    console.log(`${LOG_PREFIX} Adaptation rolled back: ${request.plan_id}`);

    await emitD43Event(
      'd43.adaptation.rolled_back',
      'info',
      `Adaptation plan rolled back`,
      {
        plan_id: request.plan_id,
        reason: request.reason
      }
    );

    return {
      ok: true,
      plan_id: request.plan_id,
      rolled_back_at: new Date().toISOString(),
      snapshot_restored: data?.snapshot_id
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error rolling back adaptation:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Acknowledge a drift event with user response
 */
export async function acknowledgeDrift(
  request: AcknowledgeDriftRequest,
  authToken?: string
): Promise<AcknowledgeDriftResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d43_acknowledge_drift', {
      p_drift_id: request.drift_id,
      p_response: request.response
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (acknowledge_drift):`, error);
      return { ok: false, error: error.message };
    }

    // Trigger adaptation if user confirmed the change
    let adaptationTriggered = false;
    if (request.response === 'confirm_change') {
      // Would trigger adaptation plan creation
      adaptationTriggered = true;
    }

    await emitD43Event(
      'd43.drift.acknowledged',
      'success',
      `Drift acknowledged by user: ${request.response}`,
      {
        drift_id: request.drift_id,
        user_response: request.response,
        adaptation_triggered: adaptationTriggered
      }
    );

    return {
      ok: true,
      drift_id: request.drift_id,
      response_recorded: request.response,
      adaptation_triggered: adaptationTriggered
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error acknowledging drift:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Create a preference snapshot for rollback
 */
export async function createSnapshot(
  snapshotType: 'before_adaptation' | 'periodic' | 'user_requested',
  adaptationPlanId?: string,
  authToken?: string
): Promise<{ ok: boolean; snapshot_id?: string; error?: string }> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d43_create_snapshot', {
      p_snapshot_type: snapshotType,
      p_adaptation_plan_id: adaptationPlanId || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (create_snapshot):`, error);
      return { ok: false, error: error.message };
    }

    console.log(`${LOG_PREFIX} Snapshot created: ${data?.id}`);

    await emitD43Event(
      'd43.snapshot.created',
      'success',
      `Preference snapshot created: ${snapshotType}`,
      {
        snapshot_id: data?.id,
        snapshot_type: snapshotType,
        adaptation_plan_id: adaptationPlanId
      }
    );

    return { ok: true, snapshot_id: data?.id };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error creating snapshot:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

// =============================================================================
// VTID-01137: Convenience Functions for ORB Integration
// =============================================================================

/**
 * Get evolution context for ORB system prompt injection
 *
 * Returns a formatted string describing the user's evolution state
 * for injection into personalization decisions.
 */
export async function getEvolutionContextForOrb(
  authToken?: string
): Promise<{ context: string; tags: EvolutionTag[] } | null> {
  try {
    const state = await getEvolutionState(authToken);

    if (!state.ok || !state.evolution_tags) {
      return null;
    }

    const contextLines: string[] = [];

    // Add stability indicator
    if (state.overall_stability !== undefined) {
      if (state.overall_stability >= 80) {
        contextLines.push('User preferences are stable and well-established.');
      } else if (state.overall_stability >= 60) {
        contextLines.push('Some preference changes detected; proceed with current understanding but be adaptive.');
      } else {
        contextLines.push('Significant preference evolution detected; confirm assumptions when relevant.');
      }
    }

    // Add evolution tag context
    if (state.evolution_tags.includes('exploration_phase')) {
      contextLines.push('User appears to be exploring new interests or behaviors.');
    }
    if (state.evolution_tags.includes('major_shift_candidate')) {
      contextLines.push('Major preference shift may be occurring; avoid over-relying on historical patterns.');
    }
    if (state.evolution_tags.includes('regression_detected')) {
      contextLines.push('User may be returning to previously held preferences.');
    }

    // Add pending adaptation note
    if (state.pending_adaptations && state.pending_adaptations.length > 0) {
      contextLines.push(`${state.pending_adaptations.length} preference update(s) pending user confirmation.`);
    }

    return {
      context: contextLines.join(' '),
      tags: state.evolution_tags
    };

  } catch (err) {
    console.error(`${LOG_PREFIX} Error getting evolution context for ORB:`, err);
    return null;
  }
}

/**
 * Record behavioral signal for longitudinal tracking
 *
 * Convenience function for ORB to record user behaviors
 * that contribute to longitudinal analysis.
 */
export async function recordBehavioralSignal(
  domain: LongitudinalDomain,
  key: string,
  value: unknown,
  numericValue?: number,
  authToken?: string
): Promise<boolean> {
  const result = await recordDataPoint({
    domain,
    key,
    value,
    numeric_value: numericValue,
    source: 'behavioral',
    confidence: 70
  }, authToken);

  return result.ok;
}

// =============================================================================
// VTID-01137: Exports
// =============================================================================

export {
  calculateTrendDirection,
  analyzeTrend,
  detectDriftType,
  deriveEvolutionTags,
  calculateStabilityScore,
  determineAdaptationStrategy,
  buildAdaptationPlan,
  DRIFT_THRESHOLDS,
  SENSITIVITY_PRESETS
};

export type {
  LongitudinalDomain,
  DriftType,
  EvolutionTag,
  AdaptationStrategy,
  LongitudinalDataPoint,
  TrendAnalysis,
  TrendDirection,
  LongitudinalSignalBundle,
  DriftEvent,
  DriftDetectionResult,
  DomainAdaptation,
  AdaptationPlan,
  PreferenceSnapshot
};

export default {
  VTID,
  recordDataPoint,
  getTrends,
  detectDrift,
  getEvolutionState,
  generateAdaptationPlan,
  approveAdaptation,
  rollbackAdaptation,
  acknowledgeDrift,
  createSnapshot,
  getEvolutionContextForOrb,
  recordBehavioralSignal
};
