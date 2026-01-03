/**
 * VTID-01139: D45 Predictive Risk Windows & Opportunity Forecasting Engine
 *
 * Core Intelligence Engine that forecasts short-term and mid-term windows where
 * the user is statistically more likely to experience risk or opportunity.
 *
 * This engine answers: "When is the next sensitive window — and why?"
 *
 * Core Principles:
 *   - Forecasts ≠ facts — use probabilistic language only
 *   - No fear framing or deterministic language
 *   - Explainability mandatory for all windows
 *   - No autonomous execution or irreversible actions
 *   - All outputs logged to OASIS
 *
 * Determinism Rules:
 *   - Same input signals → same window prediction
 *   - Same historical patterns → same precedent matching
 *   - Rule-based thresholds, no generative inference at this layer
 *
 * Position in Intelligence Stack:
 *   D43 Longitudinal Adaptation → D44 Predictive Signals → D45 Forecasting → D46+
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  WindowType,
  ForecastDomain,
  TimeHorizon,
  RecommendedMode,
  SignalConfidence,
  WindowStatus,
  PredictiveSignal,
  HistoricalPrecedent,
  WindowDriver,
  PredictiveWindow,
  PredictiveWindowFull,
  ForecastInputBundle,
  SignalConvergence,
  ForecastResult,
  ComputeForecastRequest,
  GetWindowsRequest,
  GetWindowsResponse,
  AcknowledgeWindowRequest,
  AcknowledgeWindowResponse,
  GetWindowDetailsResponse,
  FORECAST_THRESHOLDS,
  DOMAIN_RISK_FACTORS,
  MODE_SELECTION_RULES,
  EXPLAINABILITY_TEMPLATES,
  TIME_HORIZON_METADATA
} from '../types/predictive-risk-forecasting';
import {
  TrendAnalysis,
  DriftEvent,
  LongitudinalDomain
} from '../types/longitudinal-adaptation';

// =============================================================================
// VTID-01139: Constants
// =============================================================================

export const VTID = 'VTID-01139';
const LOG_PREFIX = '[D45-Engine]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

// =============================================================================
// VTID-01139: Environment Detection
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
// VTID-01139: Supabase Client Factory
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
// VTID-01139: OASIS Event Emission
// =============================================================================

async function emitD45Event(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as any,
      source: 'd45-predictive-forecasting-engine',
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
// VTID-01139: Core Analysis Functions (Deterministic)
// =============================================================================

/**
 * Map longitudinal domain to forecast domain
 */
function mapToForecastDomain(longitudinalDomain: LongitudinalDomain): ForecastDomain | null {
  const mapping: Record<LongitudinalDomain, ForecastDomain> = {
    'health': 'health',
    'preference': 'behavior',
    'goal': 'cognitive',
    'engagement': 'behavior',
    'social': 'social',
    'monetization': 'routine',
    'communication': 'social',
    'autonomy': 'cognitive'
  };
  return mapping[longitudinalDomain] || null;
}

/**
 * Classify signal confidence level
 */
function classifyConfidence(confidence: number): SignalConfidence {
  if (confidence >= FORECAST_THRESHOLDS.HIGH_CONFIDENCE_THRESHOLD) {
    return 'high';
  } else if (confidence >= FORECAST_THRESHOLDS.MEDIUM_CONFIDENCE_THRESHOLD) {
    return 'medium';
  }
  return 'low';
}

/**
 * Convert trend to predictive signal
 */
function trendToSignal(trend: TrendAnalysis): PredictiveSignal | null {
  const forecastDomain = mapToForecastDomain(trend.domain);
  if (!forecastDomain) return null;

  // Determine if this is a risk or opportunity indicator
  let signalType: 'risk_indicator' | 'opportunity_indicator' = 'risk_indicator';

  // Decreasing health, increasing cognitive load = risk
  // Increasing engagement, stable social = opportunity
  if (trend.direction === 'decreasing') {
    if (forecastDomain === 'health' || forecastDomain === 'social') {
      signalType = 'risk_indicator';
    } else {
      signalType = 'opportunity_indicator';
    }
  } else if (trend.direction === 'increasing') {
    if (forecastDomain === 'health' || forecastDomain === 'social') {
      signalType = 'opportunity_indicator';
    } else if (forecastDomain === 'cognitive') {
      signalType = 'risk_indicator';  // Increasing cognitive load = risk
    }
  }

  return {
    signal_id: crypto.randomUUID(),
    source: 'd43_trend',
    domain: forecastDomain,
    signal_type: signalType,
    confidence: trend.confidence,
    magnitude: trend.magnitude,
    description: `${trend.direction} trend in ${trend.domain} over ${trend.time_span_days} days`,
    detected_at: trend.last_observation,
    metadata: {
      trend_key: trend.key,
      velocity: trend.velocity,
      data_points: trend.data_points_count
    }
  };
}

/**
 * Convert drift event to predictive signal
 */
function driftToSignal(drift: DriftEvent): PredictiveSignal | null {
  if (drift.type === 'stable') return null;

  // Find primary domain
  const primaryDomain = drift.domains_affected[0];
  const forecastDomain = primaryDomain ? mapToForecastDomain(primaryDomain) : null;
  if (!forecastDomain) return null;

  // Drift events generally indicate risk of instability
  const signalType = drift.type === 'regression' ? 'opportunity_indicator' : 'risk_indicator';

  return {
    signal_id: crypto.randomUUID(),
    source: 'd43_trend',
    domain: forecastDomain,
    signal_type: signalType,
    confidence: drift.confidence,
    magnitude: drift.magnitude,
    description: `${drift.type} drift detected: ${drift.evidence_summary || 'pattern change'}`,
    detected_at: drift.detected_at,
    metadata: {
      drift_type: drift.type,
      domains_affected: drift.domains_affected,
      is_seasonal: drift.is_seasonal_pattern
    }
  };
}

/**
 * Check if signals meet generation threshold
 */
function meetsGenerationThreshold(signals: PredictiveSignal[]): boolean {
  const highConfidenceCount = signals.filter(
    s => classifyConfidence(s.confidence) === 'high'
  ).length;

  const mediumConfidenceCount = signals.filter(
    s => classifyConfidence(s.confidence) === 'medium'
  ).length;

  // Per spec: ≥1 high-confidence signal OR ≥2 medium-confidence signals
  return highConfidenceCount >= FORECAST_THRESHOLDS.MIN_HIGH_CONFIDENCE_SIGNALS ||
         mediumConfidenceCount >= FORECAST_THRESHOLDS.MIN_MEDIUM_CONFIDENCE_SIGNALS;
}

/**
 * Calculate combined confidence from multiple signals
 */
function calculateCombinedConfidence(signals: PredictiveSignal[]): number {
  if (signals.length === 0) return 0;

  // Weight by magnitude and original confidence
  let totalWeight = 0;
  let weightedConfidence = 0;

  for (const signal of signals) {
    const weight = signal.magnitude / 100;
    weightedConfidence += signal.confidence * weight;
    totalWeight += weight;
  }

  let baseConfidence = totalWeight > 0
    ? weightedConfidence / totalWeight
    : signals.reduce((acc, s) => acc + s.confidence, 0) / signals.length;

  // Apply convergence boost if multiple signals
  if (signals.length >= 2) {
    const boost = Math.min(
      FORECAST_THRESHOLDS.MAX_CONVERGENCE_BOOST,
      FORECAST_THRESHOLDS.CONVERGENCE_BOOST * (signals.length - 1)
    );
    baseConfidence = Math.min(100, baseConfidence + boost);
  }

  return Math.round(baseConfidence);
}

/**
 * Determine time horizon based on signal characteristics
 */
function determineTimeHorizon(
  signals: PredictiveSignal[],
  confidence: number
): TimeHorizon {
  // Higher confidence and more signals = can forecast further
  if (confidence >= FORECAST_THRESHOLDS.MIN_CONFIDENCE_LONG && signals.length >= 3) {
    return 'long';
  } else if (confidence >= FORECAST_THRESHOLDS.MIN_CONFIDENCE_MID && signals.length >= 2) {
    return 'mid';
  }
  return 'short';
}

/**
 * Calculate window time bounds
 */
function calculateWindowBounds(
  horizon: TimeHorizon,
  baseTime: Date = new Date()
): { start: Date; end: Date } {
  const meta = TIME_HORIZON_METADATA[horizon];
  const start = new Date(baseTime);
  const end = new Date(baseTime);

  if (meta.min_hours) {
    start.setHours(start.getHours() + meta.min_hours);
    end.setHours(end.getHours() + (meta.max_hours || meta.min_hours * 2));
  } else if (meta.min_days) {
    start.setDate(start.getDate() + meta.min_days);
    end.setDate(end.getDate() + (meta.max_days || meta.min_days * 2));
  }

  return { start, end };
}

/**
 * Determine recommended mode based on confidence and timing
 */
function determineRecommendedMode(
  confidence: number,
  hoursUntilStart: number
): RecommendedMode {
  // High confidence + near-term = gentle_prep
  if (confidence >= MODE_SELECTION_RULES.gentle_prep.min_confidence &&
      hoursUntilStart <= MODE_SELECTION_RULES.gentle_prep.max_hours_ahead) {
    return 'gentle_prep';
  }

  // Medium confidence or further out = reflection
  if (confidence >= MODE_SELECTION_RULES.reflection.min_confidence) {
    return 'reflection';
  }

  // Default to awareness
  return 'awareness';
}

/**
 * Generate explainability text (probabilistic wording only)
 */
function generateExplainabilityText(
  windowType: WindowType,
  domain: ForecastDomain,
  confidence: number,
  signalCount: number
): string {
  const templates = EXPLAINABILITY_TEMPLATES[windowType];
  const domainInfo = DOMAIN_RISK_FACTORS[domain];
  const confidenceLevel = classifyConfidence(confidence);

  let template: string;
  if (confidenceLevel === 'high') {
    template = templates.high_confidence;
  } else if (confidenceLevel === 'medium') {
    template = templates.medium_confidence;
  } else {
    template = templates.low_confidence;
  }

  return template
    .replace('{signal_count}', signalCount.toString())
    .replace('{domain}', domainInfo.label.toLowerCase());
}

/**
 * Generate historical precedent description
 */
function generatePrecedentDescription(
  windowType: WindowType,
  domain: ForecastDomain,
  similarPatterns: number
): string {
  if (similarPatterns === 0) {
    return 'No directly matching historical patterns found; forecast based on current signals.';
  }

  const domainInfo = DOMAIN_RISK_FACTORS[domain];
  const examples = windowType === 'risk'
    ? domainInfo.risk_examples
    : domainInfo.opportunity_examples;

  const example = examples[0] || (windowType === 'risk' ? 'sensitivity period' : 'favorable window');

  return `Similar ${example} patterns observed ${similarPatterns} time(s) in your history.`;
}

// =============================================================================
// VTID-01139: Window Generation (Deterministic)
// =============================================================================

/**
 * Generate a predictive window from signals
 */
function generateWindow(
  signals: PredictiveSignal[],
  windowType: WindowType,
  domain: ForecastDomain,
  historicalMatches: number = 0
): PredictiveWindow | null {
  if (!meetsGenerationThreshold(signals)) {
    return null;
  }

  const confidence = calculateCombinedConfidence(signals);
  const horizon = determineTimeHorizon(signals, confidence);

  // Check minimum confidence for horizon
  const requiredConfidence = TIME_HORIZON_METADATA[horizon].required_confidence;
  if (confidence < requiredConfidence) {
    return null;
  }

  const { start, end } = calculateWindowBounds(horizon);
  const hoursUntilStart = (start.getTime() - Date.now()) / (1000 * 60 * 60);

  const windowId = crypto.randomUUID();
  const recommendedMode = determineRecommendedMode(confidence, hoursUntilStart);
  const explainabilityText = generateExplainabilityText(
    windowType,
    domain,
    confidence,
    signals.length
  );
  const historicalPrecedent = generatePrecedentDescription(
    windowType,
    domain,
    historicalMatches
  );

  return {
    window_id: windowId,
    window_type: windowType,
    domain,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    confidence,
    drivers: signals.map(s => s.signal_id),
    historical_precedent: historicalPrecedent,
    recommended_mode: recommendedMode,
    explainability_text: explainabilityText
  };
}

/**
 * Group signals by domain and type for window generation
 */
function groupSignalsForWindows(
  signals: PredictiveSignal[]
): Map<string, PredictiveSignal[]> {
  const groups = new Map<string, PredictiveSignal[]>();

  for (const signal of signals) {
    const key = `${signal.domain}:${signal.signal_type}`;
    const existing = groups.get(key) || [];
    existing.push(signal);
    groups.set(key, existing);
  }

  return groups;
}

// =============================================================================
// VTID-01139: Public API Functions
// =============================================================================

/**
 * Compute forecast for the current user
 */
export async function computeForecast(
  request: ComputeForecastRequest,
  authToken?: string
): Promise<ForecastResult> {
  const startTime = Date.now();
  const forecastId = crypto.randomUUID();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, windows: [], risk_windows: [], opportunity_windows: [], signals_analyzed: 0, patterns_matched: 0, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    // 1. Fetch trends from D43
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - request.historical_days);

    const { data: dataPoints, error: dpError } = await supabase.rpc('d43_get_data_points', {
      p_domains: null,
      p_since: cutoffDate.toISOString(),
      p_limit: 1000
    });

    if (dpError) {
      console.warn(`${LOG_PREFIX} Failed to fetch D43 data points:`, dpError.message);
    }

    // 2. Collect signals from available data
    const signals: PredictiveSignal[] = [];

    // For now, generate synthetic signals based on data point patterns
    // In production, this would integrate with D44 predictive signals
    if (dataPoints && dataPoints.length > 0) {
      // Group by domain and analyze
      const domainGroups = new Map<string, any[]>();
      for (const dp of dataPoints) {
        const existing = domainGroups.get(dp.domain) || [];
        existing.push(dp);
        domainGroups.set(dp.domain, existing);
      }

      for (const [domain, points] of domainGroups) {
        if (points.length >= 5) {
          // Generate trend-based signal
          const recentPoints = points.slice(0, 10);
          const avgConfidence = recentPoints.reduce((acc, p) => acc + (p.confidence || 70), 0) / recentPoints.length;
          const forecastDomain = mapToForecastDomain(domain as LongitudinalDomain);

          if (forecastDomain && avgConfidence >= 50) {
            // Determine risk vs opportunity based on simple heuristics
            const isRisk = points.some((p: any) => p.numeric_value && p.numeric_value < 50);

            signals.push({
              signal_id: crypto.randomUUID(),
              source: 'd43_trend',
              domain: forecastDomain,
              signal_type: isRisk ? 'risk_indicator' : 'opportunity_indicator',
              confidence: Math.round(avgConfidence),
              magnitude: Math.min(100, points.length * 5),
              description: `Pattern analysis from ${points.length} data points in ${domain}`,
              detected_at: new Date().toISOString()
            });
          }
        }
      }
    }

    // 3. Group signals and generate windows
    const signalGroups = groupSignalsForWindows(signals);
    const riskWindows: PredictiveWindow[] = [];
    const opportunityWindows: PredictiveWindow[] = [];

    for (const [key, groupSignals] of signalGroups) {
      const [domain, signalType] = key.split(':');
      const windowType: WindowType = signalType === 'risk_indicator' ? 'risk' : 'opportunity';

      // Filter by request parameters
      if (request.domains && !request.domains.includes(domain as ForecastDomain)) {
        continue;
      }
      if (windowType === 'risk' && !request.include_risks) {
        continue;
      }
      if (windowType === 'opportunity' && !request.include_opportunities) {
        continue;
      }

      const window = generateWindow(
        groupSignals,
        windowType,
        domain as ForecastDomain,
        0 // Historical matches would come from pattern analysis
      );

      if (window) {
        // Check horizon filter
        const horizon = determineTimeHorizon(groupSignals, window.confidence);
        if (request.horizons.includes(horizon)) {
          if (windowType === 'risk') {
            riskWindows.push(window);
          } else {
            opportunityWindows.push(window);
          }
        }
      }
    }

    // 4. Store windows in database
    const allWindows = [...riskWindows, ...opportunityWindows];
    for (const window of allWindows) {
      try {
        await supabase.rpc('d45_store_window', {
          p_window: window
        });
      } catch (storeErr) {
        console.warn(`${LOG_PREFIX} Failed to store window:`, storeErr);
      }
    }

    // 5. Emit OASIS events
    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Forecast computed in ${duration}ms: ${riskWindows.length} risk, ${opportunityWindows.length} opportunity windows`);

    await emitD45Event(
      'd45.forecast.computed',
      'success',
      `Forecast computed: ${allWindows.length} windows generated`,
      {
        forecast_id: forecastId,
        risk_windows_count: riskWindows.length,
        opportunity_windows_count: opportunityWindows.length,
        signals_analyzed: signals.length,
        duration_ms: duration
      }
    );

    // Emit individual window events
    for (const window of riskWindows) {
      await emitD45Event(
        'd45.window.risk_detected',
        'info',
        `Risk window detected: ${window.domain}`,
        {
          window_id: window.window_id,
          domain: window.domain,
          confidence: window.confidence,
          start_time: window.start_time,
          end_time: window.end_time
        }
      );
    }

    for (const window of opportunityWindows) {
      await emitD45Event(
        'd45.window.opportunity_detected',
        'info',
        `Opportunity window detected: ${window.domain}`,
        {
          window_id: window.window_id,
          domain: window.domain,
          confidence: window.confidence,
          start_time: window.start_time,
          end_time: window.end_time
        }
      );
    }

    // Calculate next update time
    const nextUpdate = new Date();
    nextUpdate.setHours(nextUpdate.getHours() + FORECAST_THRESHOLDS.WINDOW_STALE_HOURS);

    return {
      ok: true,
      forecast_id: forecastId,
      windows: allWindows,
      risk_windows: riskWindows,
      opportunity_windows: opportunityWindows,
      signals_analyzed: signals.length,
      patterns_matched: 0,
      computed_at: new Date().toISOString(),
      next_update_suggested: nextUpdate.toISOString()
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing forecast:`, errorMessage);
    return {
      ok: false,
      windows: [],
      risk_windows: [],
      opportunity_windows: [],
      signals_analyzed: 0,
      patterns_matched: 0,
      error: errorMessage
    };
  }
}

/**
 * Get active windows for the current user
 */
export async function getWindows(
  request: GetWindowsRequest,
  authToken?: string
): Promise<GetWindowsResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d45_get_windows', {
      p_window_types: request.window_types || null,
      p_domains: request.domains || null,
      p_status: request.status || null,
      p_include_past: request.include_past,
      p_limit: request.limit + 1,  // Fetch one extra to check for more
      p_offset: request.offset
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (get_windows):`, error);
      return { ok: false, error: error.message };
    }

    const hasMore = data && data.length > request.limit;
    const windows = (data || []).slice(0, request.limit);

    return {
      ok: true,
      windows: windows.map((w: any) => ({
        window_id: w.id || w.window_id,
        window_type: w.window_type,
        domain: w.domain,
        start_time: w.start_time,
        end_time: w.end_time,
        confidence: w.confidence,
        drivers: w.drivers || [],
        historical_precedent: w.historical_precedent || '',
        recommended_mode: w.recommended_mode,
        explainability_text: w.explainability_text
      })),
      total_count: windows.length,
      has_more: hasMore
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting windows:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get details for a specific window
 */
export async function getWindowDetails(
  windowId: string,
  authToken?: string
): Promise<GetWindowDetailsResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d45_get_window_details', {
      p_window_id: windowId
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (get_window_details):`, error);
      return { ok: false, error: error.message };
    }

    if (!data) {
      return { ok: false, error: 'NOT_FOUND' };
    }

    return {
      ok: true,
      window: data as PredictiveWindowFull
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting window details:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Acknowledge a window (user has seen it)
 */
export async function acknowledgeWindow(
  request: AcknowledgeWindowRequest,
  authToken?: string
): Promise<AcknowledgeWindowResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d45_acknowledge_window', {
      p_window_id: request.window_id,
      p_feedback: request.feedback || null,
      p_notes: request.notes || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (acknowledge_window):`, error);
      return { ok: false, error: error.message };
    }

    const acknowledgedAt = new Date().toISOString();

    await emitD45Event(
      'd45.window.acknowledged',
      'success',
      `Window acknowledged by user`,
      {
        window_id: request.window_id,
        feedback: request.feedback,
        acknowledged_at: acknowledgedAt
      }
    );

    return {
      ok: true,
      window_id: request.window_id,
      acknowledged_at: acknowledgedAt
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error acknowledging window:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Invalidate a window (new data superseded it)
 */
export async function invalidateWindow(
  windowId: string,
  reason: string,
  authToken?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { error } = await supabase.rpc('d45_invalidate_window', {
      p_window_id: windowId,
      p_reason: reason
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (invalidate_window):`, error);
      return { ok: false, error: error.message };
    }

    await emitD45Event(
      'd45.window.invalidated',
      'info',
      `Window invalidated: ${reason}`,
      {
        window_id: windowId,
        invalidation_reason: reason,
        invalidated_at: new Date().toISOString()
      }
    );

    return { ok: true };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error invalidating window:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

// =============================================================================
// VTID-01139: Convenience Functions for ORB Integration
// =============================================================================

/**
 * Get forecast context for ORB system prompt injection
 *
 * Returns a formatted string describing upcoming risk/opportunity windows
 * for injection into conversation context.
 */
export async function getForecastContextForOrb(
  authToken?: string
): Promise<{ context: string; windows: PredictiveWindow[] } | null> {
  try {
    const result = await getWindows({
      status: ['upcoming', 'active'],
      include_past: false,
      limit: 5,
      offset: 0
    }, authToken);

    if (!result.ok || !result.windows || result.windows.length === 0) {
      return null;
    }

    const contextLines: string[] = [];
    const riskWindows = result.windows.filter(w => w.window_type === 'risk');
    const oppWindows = result.windows.filter(w => w.window_type === 'opportunity');

    if (riskWindows.length > 0) {
      const highestRisk = riskWindows.sort((a, b) => b.confidence - a.confidence)[0];
      const domainInfo = DOMAIN_RISK_FACTORS[highestRisk.domain];
      contextLines.push(
        `Upcoming ${domainInfo.label.toLowerCase()} sensitivity period may be approaching. ` +
        `Consider the user's ${domainInfo.description.toLowerCase()} in recommendations.`
      );
    }

    if (oppWindows.length > 0) {
      const highestOpp = oppWindows.sort((a, b) => b.confidence - a.confidence)[0];
      const domainInfo = DOMAIN_RISK_FACTORS[highestOpp.domain];
      contextLines.push(
        `Favorable window for ${domainInfo.label.toLowerCase()} activities may be approaching.`
      );
    }

    return {
      context: contextLines.join(' '),
      windows: result.windows
    };

  } catch (err) {
    console.error(`${LOG_PREFIX} Error getting forecast context for ORB:`, err);
    return null;
  }
}

/**
 * Check if current moment is within any risk window
 */
export async function isInRiskWindow(
  authToken?: string
): Promise<{ inRiskWindow: boolean; activeRisks: PredictiveWindow[] }> {
  try {
    const result = await getWindows({
      window_types: ['risk'],
      status: ['active'],
      include_past: false,
      limit: 10,
      offset: 0
    }, authToken);

    if (!result.ok || !result.windows) {
      return { inRiskWindow: false, activeRisks: [] };
    }

    const now = new Date();
    const activeRisks = result.windows.filter(w => {
      const start = new Date(w.start_time);
      const end = new Date(w.end_time);
      return now >= start && now <= end;
    });

    return {
      inRiskWindow: activeRisks.length > 0,
      activeRisks
    };

  } catch (err) {
    console.error(`${LOG_PREFIX} Error checking risk window:`, err);
    return { inRiskWindow: false, activeRisks: [] };
  }
}

/**
 * Check if current moment is within any opportunity window
 */
export async function isInOpportunityWindow(
  authToken?: string
): Promise<{ inOpportunityWindow: boolean; activeOpportunities: PredictiveWindow[] }> {
  try {
    const result = await getWindows({
      window_types: ['opportunity'],
      status: ['active'],
      include_past: false,
      limit: 10,
      offset: 0
    }, authToken);

    if (!result.ok || !result.windows) {
      return { inOpportunityWindow: false, activeOpportunities: [] };
    }

    const now = new Date();
    const activeOpportunities = result.windows.filter(w => {
      const start = new Date(w.start_time);
      const end = new Date(w.end_time);
      return now >= start && now <= end;
    });

    return {
      inOpportunityWindow: activeOpportunities.length > 0,
      activeOpportunities
    };

  } catch (err) {
    console.error(`${LOG_PREFIX} Error checking opportunity window:`, err);
    return { inOpportunityWindow: false, activeOpportunities: [] };
  }
}

// =============================================================================
// VTID-01139: Exports
// =============================================================================

export {
  mapToForecastDomain,
  classifyConfidence,
  trendToSignal,
  driftToSignal,
  meetsGenerationThreshold,
  calculateCombinedConfidence,
  determineTimeHorizon,
  calculateWindowBounds,
  determineRecommendedMode,
  generateExplainabilityText,
  generatePrecedentDescription,
  generateWindow,
  groupSignalsForWindows,
  FORECAST_THRESHOLDS,
  DOMAIN_RISK_FACTORS,
  MODE_SELECTION_RULES,
  EXPLAINABILITY_TEMPLATES,
  TIME_HORIZON_METADATA
};

export type {
  WindowType,
  ForecastDomain,
  TimeHorizon,
  RecommendedMode,
  SignalConfidence,
  WindowStatus,
  PredictiveSignal,
  HistoricalPrecedent,
  WindowDriver,
  PredictiveWindow,
  PredictiveWindowFull,
  ForecastInputBundle,
  SignalConvergence,
  ForecastResult
};

export default {
  VTID,
  computeForecast,
  getWindows,
  getWindowDetails,
  acknowledgeWindow,
  invalidateWindow,
  getForecastContextForOrb,
  isInRiskWindow,
  isInOpportunityWindow
};
