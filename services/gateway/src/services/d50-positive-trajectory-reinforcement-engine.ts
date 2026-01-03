/**
 * VTID-01144: D50 Positive Trajectory Reinforcement & Momentum Engine
 *
 * Core Intelligence Engine that identifies positive trajectories and reinforces
 * them gently to help users continue what is already working.
 *
 * This engine answers: "What's going well, and how can it be sustained?"
 *
 * Core Principles:
 *   - Positive-only reinforcement (no correction)
 *   - No comparison with others
 *   - No gamification pressure
 *   - No behavioral enforcement
 *   - Focus on continuation, not escalation
 *   - Explainability mandatory
 *   - All outputs logged to OASIS
 *
 * Reinforcement Rules:
 *   - Positive trend sustained ≥ 7 days
 *   - Confidence ≥ 80%
 *   - Reinforcement is specific, not generic
 *   - Not repeated within last 21 days
 *
 * Determinism Rules:
 *   - Same positive signals → same eligibility
 *   - Same trajectory data → same reinforcement
 *   - Rule-based, no generative inference at this layer
 *
 * Position in Intelligence Stack:
 *   D43 Longitudinal Trends → D50 Reinforcement → Output Generation
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import { getTrends, detectDrift, DRIFT_THRESHOLDS } from './d43-longitudinal-adaptation-engine';
import {
  TrajectoryType,
  Reinforcement,
  StoredReinforcement,
  EligibilityResult,
  PositiveSignal,
  OpportunityWindow,
  ReinforcementInputBundle,
  CheckEligibilityRequest,
  CheckEligibilityResponse,
  GenerateReinforcementRequest,
  GenerateReinforcementResponse,
  DismissReinforcementRequest,
  DismissReinforcementResponse,
  GetReinforcementHistoryRequest,
  GetReinforcementHistoryResponse,
  GetMomentumStateRequest,
  GetMomentumStateResponse,
  MomentumState,
  REINFORCEMENT_THRESHOLDS,
  TRAJECTORY_TYPE_METADATA,
  FRAMING_RULES,
  DOMAIN_TO_TRAJECTORY_MAP,
  DerivedPositiveSignal,
  TrajectoryTrendAnalysis
} from '../types/positive-trajectory-reinforcement';
import {
  LongitudinalDomain,
  TrendAnalysis,
  LongitudinalSignalBundle
} from '../types/longitudinal-adaptation';

// =============================================================================
// VTID-01144: Constants
// =============================================================================

export const VTID = 'VTID-01144';
const LOG_PREFIX = '[D50-Engine]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

/**
 * All trajectory types for iteration
 */
const ALL_TRAJECTORY_TYPES: TrajectoryType[] = [
  'health', 'routine', 'social', 'emotional', 'learning', 'consistency'
];

// =============================================================================
// VTID-01144: Environment Detection
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
// VTID-01144: Supabase Client Factory
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
// VTID-01144: OASIS Event Emission
// =============================================================================

async function emitD50Event(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as any,
      source: 'd50-reinforcement-engine',
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
// VTID-01144: Trend Analysis & Signal Derivation (Deterministic)
// =============================================================================

/**
 * Map a longitudinal domain to a trajectory type
 */
function domainToTrajectoryType(domain: LongitudinalDomain): TrajectoryType | null {
  return DOMAIN_TO_TRAJECTORY_MAP[domain] || null;
}

/**
 * Determine if a trend represents a positive trajectory
 */
function isTrendPositive(trend: TrendAnalysis): boolean {
  // For most domains, increasing is positive
  // But we need to consider the context
  const direction = trend.direction;
  const magnitude = trend.magnitude;

  // Stable with high data points is positive (consistency)
  // Check this first since stable trends naturally have low magnitude
  if (direction === 'stable' && trend.data_points_count >= 10) {
    return true;
  }

  // For non-stable trends, must have sufficient magnitude
  if (magnitude < REINFORCEMENT_THRESHOLDS.MIN_TREND_MAGNITUDE) {
    return false;
  }

  // Positive directions
  if (direction === 'increasing') {
    return true;
  }

  return false;
}

/**
 * Calculate days sustained from trend analysis
 */
function calculateDaysSustained(trend: TrendAnalysis): number {
  return trend.time_span_days;
}

/**
 * Derive positive signals from D43 trend data
 */
function derivePositiveSignalsFromTrends(
  signals: LongitudinalSignalBundle
): DerivedPositiveSignal[] {
  const derived: DerivedPositiveSignal[] = [];

  const trendKeys = [
    'preference_trend', 'goal_trend', 'engagement_trend',
    'social_trend', 'monetization_trend', 'health_trend',
    'communication_trend', 'autonomy_trend'
  ] as const;

  for (const trendKey of trendKeys) {
    const trend = signals[trendKey] as TrendAnalysis | null | undefined;
    if (!trend) continue;

    const trajectoryType = domainToTrajectoryType(trend.domain);
    if (!trajectoryType) continue;

    if (isTrendPositive(trend)) {
      const sustainedDays = calculateDaysSustained(trend);

      derived.push({
        source: 'trend',
        trend_domain: trend.domain,
        trajectory_type: trajectoryType,
        confidence: trend.confidence,
        evidence: `${trend.direction} trend in ${trend.domain} over ${sustainedDays} days (${trend.data_points_count} observations)`,
        sustained_days: sustainedDays
      });
    }
  }

  return derived;
}

/**
 * Convert trend to trajectory trend analysis
 */
function toTrajectoryTrendAnalysis(
  trend: TrendAnalysis,
  trajectoryType: TrajectoryType
): TrajectoryTrendAnalysis {
  return {
    ...trend,
    trajectory_type: trajectoryType,
    is_positive: isTrendPositive(trend),
    sustained_days: calculateDaysSustained(trend)
  };
}

// =============================================================================
// VTID-01144: Eligibility Checking (Deterministic)
// =============================================================================

/**
 * Check if reinforcement was recently given for this trajectory type
 */
async function getLastReinforcementInfo(
  supabase: SupabaseClient,
  trajectoryType: TrajectoryType
): Promise<{ lastDate: Date | null; daysSince: number | null }> {
  try {
    const { data, error } = await supabase.rpc('d50_get_last_reinforcement', {
      p_trajectory_type: trajectoryType
    });

    if (error || !data?.found) {
      return { lastDate: null, daysSince: null };
    }

    return {
      lastDate: new Date(data.generated_at),
      daysSince: data.days_since
    };
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting last reinforcement:`, err);
    return { lastDate: null, daysSince: null };
  }
}

/**
 * Check eligibility for a single trajectory type
 */
async function checkSingleTrajectoryEligibility(
  signals: DerivedPositiveSignal[],
  trajectoryType: TrajectoryType,
  supabase: SupabaseClient
): Promise<EligibilityResult> {
  // Find signals for this trajectory type
  const relevantSignals = signals.filter(s => s.trajectory_type === trajectoryType);

  if (relevantSignals.length === 0) {
    return {
      eligible: false,
      trajectory_type: trajectoryType,
      confidence: 0,
      days_sustained: 0,
      last_reinforcement_date: null,
      days_since_last_reinforcement: null,
      rejection_reason: 'No positive signals detected for this trajectory type',
      evidence_summary: null
    };
  }

  // Get the best signal (highest confidence with sufficient duration)
  const bestSignal = relevantSignals
    .filter(s => s.sustained_days >= REINFORCEMENT_THRESHOLDS.MIN_SUSTAINED_DAYS)
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (!bestSignal) {
    const maxDays = Math.max(...relevantSignals.map(s => s.sustained_days));
    return {
      eligible: false,
      trajectory_type: trajectoryType,
      confidence: Math.max(...relevantSignals.map(s => s.confidence)),
      days_sustained: maxDays,
      last_reinforcement_date: null,
      days_since_last_reinforcement: null,
      rejection_reason: `Trend not sustained long enough (${maxDays} days, need ${REINFORCEMENT_THRESHOLDS.MIN_SUSTAINED_DAYS})`,
      evidence_summary: relevantSignals[0]?.evidence || null
    };
  }

  // Check confidence threshold
  if (bestSignal.confidence < REINFORCEMENT_THRESHOLDS.MIN_CONFIDENCE) {
    return {
      eligible: false,
      trajectory_type: trajectoryType,
      confidence: bestSignal.confidence,
      days_sustained: bestSignal.sustained_days,
      last_reinforcement_date: null,
      days_since_last_reinforcement: null,
      rejection_reason: `Confidence too low (${bestSignal.confidence}%, need ${REINFORCEMENT_THRESHOLDS.MIN_CONFIDENCE}%)`,
      evidence_summary: bestSignal.evidence
    };
  }

  // Check last reinforcement date
  const { lastDate, daysSince } = await getLastReinforcementInfo(supabase, trajectoryType);

  if (daysSince !== null && daysSince < REINFORCEMENT_THRESHOLDS.MIN_DAYS_BETWEEN_REINFORCEMENTS) {
    return {
      eligible: false,
      trajectory_type: trajectoryType,
      confidence: bestSignal.confidence,
      days_sustained: bestSignal.sustained_days,
      last_reinforcement_date: lastDate?.toISOString() || null,
      days_since_last_reinforcement: daysSince,
      rejection_reason: `Recent reinforcement (${daysSince} days ago, need ${REINFORCEMENT_THRESHOLDS.MIN_DAYS_BETWEEN_REINFORCEMENTS} days gap)`,
      evidence_summary: bestSignal.evidence
    };
  }

  // Eligible!
  return {
    eligible: true,
    trajectory_type: trajectoryType,
    confidence: bestSignal.confidence,
    days_sustained: bestSignal.sustained_days,
    last_reinforcement_date: lastDate?.toISOString() || null,
    days_since_last_reinforcement: daysSince,
    rejection_reason: null,
    evidence_summary: bestSignal.evidence
  };
}

// =============================================================================
// VTID-01144: Reinforcement Generation (Deterministic)
// =============================================================================

/**
 * Generate specific observation text (what_is_working)
 * Uses templates but fills with specific data
 */
function generateWhatIsWorking(
  trajectoryType: TrajectoryType,
  signal: DerivedPositiveSignal
): string {
  const templates = TRAJECTORY_TYPE_METADATA[trajectoryType].message_templates.what_is_working;
  const template = templates[0]; // Deterministic: always use first template

  // Fill in placeholders with actual data
  let message = template
    .replace('{days}', signal.sustained_days.toString())
    .replace('{behavior}', signal.trend_domain)
    .replace('{area}', signal.trend_domain)
    .replace('{pattern}', signal.trend_domain)
    .replace('{context}', 'your daily activities')
    .replace('{skill}', signal.trend_domain);

  // Ensure it doesn't exceed word limit
  const words = message.split(' ');
  if (words.length > FRAMING_RULES.MAX_OBSERVATION_WORDS) {
    message = words.slice(0, FRAMING_RULES.MAX_OBSERVATION_WORDS).join(' ');
  }

  // Validate no prohibited phrases
  const lowerMessage = message.toLowerCase();
  for (const phrase of FRAMING_RULES.PROHIBITED_PHRASES) {
    if (lowerMessage.includes(phrase)) {
      console.warn(`${LOG_PREFIX} Message contained prohibited phrase: ${phrase}`);
      // Remove or replace the phrase
      message = message.replace(new RegExp(phrase, 'gi'), 'notably');
    }
  }

  return message;
}

/**
 * Generate explanation text (why_it_matters)
 */
function generateWhyItMatters(
  trajectoryType: TrajectoryType,
  signal: DerivedPositiveSignal
): string {
  const templates = TRAJECTORY_TYPE_METADATA[trajectoryType].message_templates.why_it_matters;
  const template = templates[0]; // Deterministic: always use first template

  let message = template;

  // Ensure it doesn't exceed word limit
  const words = message.split(' ');
  if (words.length > FRAMING_RULES.MAX_EXPLANATION_WORDS) {
    message = words.slice(0, FRAMING_RULES.MAX_EXPLANATION_WORDS).join(' ');
  }

  // Validate no prohibited phrases
  const lowerMessage = message.toLowerCase();
  for (const phrase of FRAMING_RULES.PROHIBITED_PHRASES) {
    if (lowerMessage.includes(phrase)) {
      message = message.replace(new RegExp(phrase, 'gi'), 'notably');
    }
  }

  return message;
}

/**
 * Generate optional focus suggestion
 * Returns null if no appropriate focus is available
 */
function generateSuggestedFocus(
  trajectoryType: TrajectoryType,
  signal: DerivedPositiveSignal
): string | null {
  // Focus on continuation, not escalation
  // Only provide if there's a clear, non-directive suggestion
  const focusSuggestions: Record<TrajectoryType, string | null> = {
    health: null, // No directive for health
    routine: 'Consider what makes this routine sustainable for you.',
    social: null, // No directive for social
    emotional: null, // No directive for emotional
    learning: 'Reflect on what aspects of this learning approach work for you.',
    consistency: null // No directive for consistency
  };

  const focus = focusSuggestions[trajectoryType];

  if (focus && focus.split(' ').length > FRAMING_RULES.MAX_FOCUS_WORDS) {
    return null; // Too long, skip
  }

  return focus;
}

/**
 * Build a reinforcement from signals (core generation logic)
 */
function buildReinforcement(
  trajectoryType: TrajectoryType,
  signal: DerivedPositiveSignal
): Reinforcement {
  const reinforcementId = crypto.randomUUID();

  return {
    reinforcement_id: reinforcementId,
    trajectory_type: trajectoryType,
    confidence: signal.confidence,
    what_is_working: generateWhatIsWorking(trajectoryType, signal),
    why_it_matters: generateWhyItMatters(trajectoryType, signal),
    suggested_focus: generateSuggestedFocus(trajectoryType, signal),
    dismissible: true
  };
}

// =============================================================================
// VTID-01144: Momentum Calculation (Deterministic)
// =============================================================================

/**
 * Calculate overall momentum state from eligibility results
 */
function calculateOverallMomentum(
  eligibilityResults: EligibilityResult[]
): 'building' | 'stable' | 'fragile' | 'unknown' {
  const eligible = eligibilityResults.filter(r => r.eligible);
  const withData = eligibilityResults.filter(r => r.days_sustained > 0);

  if (withData.length === 0) {
    return 'unknown';
  }

  const eligibleRatio = eligible.length / withData.length;
  const avgConfidence = withData.reduce((sum, r) => sum + r.confidence, 0) / withData.length;
  const avgDaysSustained = withData.reduce((sum, r) => sum + r.days_sustained, 0) / withData.length;

  // Building: multiple eligible, high confidence, long sustained
  if (eligibleRatio >= 0.4 && avgConfidence >= 75 && avgDaysSustained >= 10) {
    return 'building';
  }

  // Stable: some eligible, moderate confidence
  if (eligibleRatio >= 0.2 || avgConfidence >= 60) {
    return 'stable';
  }

  // Fragile: few eligible, low confidence
  if (withData.length > 0) {
    return 'fragile';
  }

  return 'unknown';
}

// =============================================================================
// VTID-01144: Public API Functions
// =============================================================================

/**
 * Check eligibility for reinforcement across trajectory types
 */
export async function checkEligibility(
  request: CheckEligibilityRequest,
  authToken?: string
): Promise<CheckEligibilityResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return {
        ok: false,
        eligible_trajectories: [],
        any_eligible: false,
        next_possible_reinforcement: null,
        error: clientError || 'SERVICE_UNAVAILABLE'
      };
    }

    // Get trends from D43
    const trendsResult = await getTrends({
      time_window_days: REINFORCEMENT_THRESHOLDS.LOOKBACK_DAYS,
      min_data_points: REINFORCEMENT_THRESHOLDS.MIN_DATA_POINTS_FOR_TRAJECTORY
    }, authToken);

    if (!trendsResult.ok || !trendsResult.signals) {
      return {
        ok: true,
        eligible_trajectories: [],
        any_eligible: false,
        next_possible_reinforcement: null
      };
    }

    // Derive positive signals from trends
    const derivedSignals = derivePositiveSignalsFromTrends(trendsResult.signals);

    // Check which trajectory types to evaluate
    const trajectoryTypes = request.trajectory_types || ALL_TRAJECTORY_TYPES;

    // Check eligibility for each trajectory type
    const eligibilityResults: EligibilityResult[] = [];
    for (const trajectoryType of trajectoryTypes) {
      const result = await checkSingleTrajectoryEligibility(
        derivedSignals,
        trajectoryType,
        supabase
      );
      eligibilityResults.push(result);
    }

    // Calculate next possible reinforcement date
    const ineligibleWithDate = eligibilityResults
      .filter(r => !r.eligible && r.days_since_last_reinforcement !== null)
      .map(r => {
        const daysUntilEligible = REINFORCEMENT_THRESHOLDS.MIN_DAYS_BETWEEN_REINFORCEMENTS -
          (r.days_since_last_reinforcement || 0);
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + Math.max(0, daysUntilEligible));
        return nextDate;
      });

    const nextPossible = ineligibleWithDate.length > 0
      ? new Date(Math.min(...ineligibleWithDate.map(d => d.getTime()))).toISOString()
      : null;

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Eligibility checked in ${duration}ms`);

    await emitD50Event(
      'd50.eligibility.checked',
      'success',
      `Eligibility checked for ${trajectoryTypes.length} trajectory types`,
      {
        trajectory_types_checked: trajectoryTypes,
        eligible_count: eligibilityResults.filter(r => r.eligible).length,
        total_signals_derived: derivedSignals.length,
        duration_ms: duration
      }
    );

    return {
      ok: true,
      eligible_trajectories: eligibilityResults,
      any_eligible: eligibilityResults.some(r => r.eligible),
      next_possible_reinforcement: nextPossible
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error checking eligibility:`, errorMessage);
    return {
      ok: false,
      eligible_trajectories: [],
      any_eligible: false,
      next_possible_reinforcement: null,
      error: errorMessage
    };
  }
}

/**
 * Generate a positive reinforcement
 */
export async function generateReinforcement(
  request: GenerateReinforcementRequest,
  authToken?: string
): Promise<GenerateReinforcementResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return {
        ok: false,
        delivered: false,
        error: clientError || 'SERVICE_UNAVAILABLE'
      };
    }

    // Check daily limit
    const { data: todayCount, error: countError } = await supabase.rpc('d50_count_today_reinforcements');
    if (!countError && todayCount >= REINFORCEMENT_THRESHOLDS.MAX_DAILY_REINFORCEMENTS) {
      return {
        ok: false,
        delivered: false,
        error: `Daily reinforcement limit reached (${REINFORCEMENT_THRESHOLDS.MAX_DAILY_REINFORCEMENTS})`
      };
    }

    // Check eligibility
    const trajectoryTypes = request.trajectory_type ? [request.trajectory_type] : undefined;
    const eligibilityResponse = await checkEligibility({
      trajectory_types: trajectoryTypes,
      include_evidence: true
    }, authToken);

    if (!eligibilityResponse.ok) {
      return {
        ok: false,
        delivered: false,
        error: eligibilityResponse.error
      };
    }

    // Find the best eligible trajectory
    const eligibleResults = eligibilityResponse.eligible_trajectories.filter(r => r.eligible);

    if (eligibleResults.length === 0) {
      const reasons = eligibilityResponse.eligible_trajectories
        .map(r => `${r.trajectory_type}: ${r.rejection_reason}`)
        .join('; ');
      return {
        ok: false,
        delivered: false,
        error: `No eligible trajectories: ${reasons}`
      };
    }

    // Pick the best one (highest confidence, then longest sustained)
    const bestEligible = eligibleResults.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.days_sustained - a.days_sustained;
    })[0];

    // Get trends again to build the reinforcement
    const trendsResult = await getTrends({
      time_window_days: REINFORCEMENT_THRESHOLDS.LOOKBACK_DAYS,
      min_data_points: REINFORCEMENT_THRESHOLDS.MIN_DATA_POINTS_FOR_TRAJECTORY
    }, authToken);

    const derivedSignals = trendsResult.signals
      ? derivePositiveSignalsFromTrends(trendsResult.signals)
      : [];

    const signal = derivedSignals.find(s =>
      s.trajectory_type === bestEligible.trajectory_type &&
      s.confidence >= REINFORCEMENT_THRESHOLDS.MIN_CONFIDENCE &&
      s.sustained_days >= REINFORCEMENT_THRESHOLDS.MIN_SUSTAINED_DAYS
    );

    if (!signal) {
      return {
        ok: false,
        delivered: false,
        error: 'Signal not found for eligible trajectory'
      };
    }

    // Build the reinforcement
    const reinforcement = buildReinforcement(bestEligible.trajectory_type!, signal);

    // Store the reinforcement
    const contextSnapshot = request.include_context_snapshot
      ? {
          eligibility: bestEligible,
          signal: { ...signal },
          trends_computed_at: trendsResult.signals?.computed_at
        }
      : {};

    const { data: storeResult, error: storeError } = await supabase.rpc('d50_store_reinforcement', {
      p_trajectory_type: reinforcement.trajectory_type,
      p_confidence: reinforcement.confidence,
      p_what_is_working: reinforcement.what_is_working,
      p_why_it_matters: reinforcement.why_it_matters,
      p_suggested_focus: reinforcement.suggested_focus,
      p_source_signals: [],
      p_source_trends: [signal.trend_domain],
      p_context_snapshot: contextSnapshot,
      p_dismissible: reinforcement.dismissible
    });

    if (storeError) {
      console.error(`${LOG_PREFIX} Failed to store reinforcement:`, storeError);
      return {
        ok: false,
        delivered: false,
        error: storeError.message
      };
    }

    const reinforcementId = storeResult?.reinforcement_id || reinforcement.reinforcement_id;

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Reinforcement generated in ${duration}ms: ${reinforcement.trajectory_type}`);

    await emitD50Event(
      'd50.reinforcement.generated',
      'success',
      `Reinforcement generated for ${reinforcement.trajectory_type}`,
      {
        reinforcement_id: reinforcementId,
        trajectory_type: reinforcement.trajectory_type,
        confidence: reinforcement.confidence,
        days_sustained: signal.sustained_days,
        duration_ms: duration
      }
    );

    return {
      ok: true,
      reinforcement: {
        ...reinforcement,
        reinforcement_id: reinforcementId
      },
      reinforcement_id: reinforcementId,
      delivered: false // Not delivered until explicitly marked
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error generating reinforcement:`, errorMessage);
    return {
      ok: false,
      delivered: false,
      error: errorMessage
    };
  }
}

/**
 * Mark a reinforcement as delivered
 */
export async function markDelivered(
  reinforcementId: string,
  authToken?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d50_mark_delivered', {
      p_reinforcement_id: reinforcementId
    });

    if (error) {
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'UNKNOWN_ERROR' };
    }

    await emitD50Event(
      'd50.reinforcement.delivered',
      'success',
      `Reinforcement delivered`,
      {
        reinforcement_id: reinforcementId
      }
    );

    return { ok: true };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

/**
 * Dismiss a reinforcement
 */
export async function dismissReinforcement(
  request: DismissReinforcementRequest,
  authToken?: string
): Promise<DismissReinforcementResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d50_dismiss_reinforcement', {
      p_reinforcement_id: request.reinforcement_id,
      p_reason: request.reason || null
    });

    if (error) {
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'UNKNOWN_ERROR' };
    }

    await emitD50Event(
      'd50.reinforcement.dismissed',
      'info',
      `Reinforcement dismissed`,
      {
        reinforcement_id: request.reinforcement_id,
        reason: request.reason || 'no_reason'
      }
    );

    return {
      ok: true,
      reinforcement_id: request.reinforcement_id,
      dismissed_at: new Date().toISOString()
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get reinforcement history
 */
export async function getReinforcementHistory(
  request: GetReinforcementHistoryRequest,
  authToken?: string
): Promise<GetReinforcementHistoryResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d50_get_recent_reinforcements', {
      p_trajectory_types: request.trajectory_types || null,
      p_include_dismissed: request.include_dismissed,
      p_limit: request.limit
    });

    if (error) {
      return { ok: false, error: error.message };
    }

    return {
      ok: true,
      reinforcements: data || [],
      count: data?.length || 0
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get current momentum state
 */
export async function getMomentumState(
  request: GetMomentumStateRequest,
  authToken?: string
): Promise<GetMomentumStateResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    // Get eligibility for all trajectory types
    const eligibilityResponse = await checkEligibility({
      include_evidence: true
    }, authToken);

    if (!eligibilityResponse.ok) {
      return { ok: false, error: eligibilityResponse.error };
    }

    // Get recent reinforcements if requested
    let recentReinforcements: StoredReinforcement[] = [];
    if (request.include_recent) {
      const historyResponse = await getReinforcementHistory({
        limit: 5,
        include_dismissed: false
      }, authToken);

      if (historyResponse.ok && historyResponse.reinforcements) {
        recentReinforcements = historyResponse.reinforcements;
      }
    }

    // Build trajectory summaries
    const trajectorySummaries = eligibilityResponse.eligible_trajectories.map(e => {
      const status: 'positive' | 'stable' | 'insufficient_data' =
        e.days_sustained > 0
          ? (e.eligible ? 'positive' : 'stable')
          : 'insufficient_data';
      return {
        trajectory_type: e.trajectory_type!,
        status,
        days_sustained: e.days_sustained,
        last_reinforced_at: e.last_reinforcement_date ?? null,
        eligible_for_reinforcement: e.eligible
      };
    });

    // Calculate overall momentum
    const overallMomentum = calculateOverallMomentum(eligibilityResponse.eligible_trajectories);

    const state: MomentumState = {
      overall_momentum: overallMomentum,
      trajectory_summaries: trajectorySummaries,
      recent_reinforcements: recentReinforcements,
      next_opportunity: eligibilityResponse.next_possible_reinforcement
    };

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Momentum state computed in ${duration}ms`);

    await emitD50Event(
      'd50.momentum.computed',
      'success',
      `Momentum state: ${overallMomentum}`,
      {
        overall_momentum: overallMomentum,
        eligible_count: trajectorySummaries.filter(t => t.eligible_for_reinforcement).length,
        total_trajectories: trajectorySummaries.length,
        duration_ms: duration
      }
    );

    return {
      ok: true,
      state,
      computed_at: new Date().toISOString()
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting momentum state:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get reinforcement context for ORB system prompt injection
 *
 * Returns a formatted string for ORB to understand the user's positive momentum.
 */
export async function getReinforcementContextForOrb(
  authToken?: string
): Promise<{ context: string; hasPositiveTrajectories: boolean } | null> {
  try {
    const momentumResponse = await getMomentumState({
      include_eligible: true,
      include_recent: false
    }, authToken);

    if (!momentumResponse.ok || !momentumResponse.state) {
      return null;
    }

    const state = momentumResponse.state;
    const contextLines: string[] = [];

    // Add overall momentum context
    switch (state.overall_momentum) {
      case 'building':
        contextLines.push('User shows building positive momentum across multiple areas.');
        break;
      case 'stable':
        contextLines.push('User maintains stable positive patterns.');
        break;
      case 'fragile':
        contextLines.push('Some positive patterns detected but not yet well-established.');
        break;
      case 'unknown':
        contextLines.push('Insufficient data to assess momentum.');
        break;
    }

    // Add specific positive trajectories
    const positiveTrajectories = state.trajectory_summaries
      .filter(t => t.status === 'positive' || (t.status === 'stable' && t.days_sustained >= 7));

    if (positiveTrajectories.length > 0) {
      const areas = positiveTrajectories.map(t =>
        TRAJECTORY_TYPE_METADATA[t.trajectory_type].label
      ).join(', ');
      contextLines.push(`Sustained positive patterns in: ${areas}.`);
    }

    return {
      context: contextLines.join(' '),
      hasPositiveTrajectories: positiveTrajectories.length > 0
    };

  } catch (err) {
    console.error(`${LOG_PREFIX} Error getting reinforcement context for ORB:`, err);
    return null;
  }
}

// =============================================================================
// VTID-01144: Exports
// =============================================================================

export {
  derivePositiveSignalsFromTrends,
  isTrendPositive,
  calculateDaysSustained,
  domainToTrajectoryType,
  buildReinforcement,
  calculateOverallMomentum,
  generateWhatIsWorking,
  generateWhyItMatters,
  REINFORCEMENT_THRESHOLDS,
  TRAJECTORY_TYPE_METADATA,
  FRAMING_RULES
};

export type {
  TrajectoryType,
  Reinforcement,
  StoredReinforcement,
  EligibilityResult,
  PositiveSignal,
  OpportunityWindow,
  MomentumState
};

export default {
  VTID,
  checkEligibility,
  generateReinforcement,
  markDelivered,
  dismissReinforcement,
  getReinforcementHistory,
  getMomentumState,
  getReinforcementContextForOrb
};
