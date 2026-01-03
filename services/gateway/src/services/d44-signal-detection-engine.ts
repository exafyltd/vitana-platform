/**
 * VTID-01138: D44 Proactive Signal Detection & Early Intervention Engine
 *
 * Core Intelligence Engine that proactively identifies early weak signals
 * indicating potential future risk or opportunity across health, behavior,
 * routines, social patterns, and preferences.
 *
 * It answers: "Something is changing — should the user know now?"
 *
 * Core Principles:
 *   - Detect early, before problems manifest
 *   - Surface insights, not actions (recommendations only)
 *   - Every signal must be explainable in plain language
 *   - Rare but meaningful (no spam)
 *   - Full traceability via OASIS events
 *
 * Detection Rules (Hard):
 *   - Persistent: ≥3 occurrences or ≥7 days
 *   - Directional: trend, not noise
 *   - Confidence: ≥70%
 *   - Evidence: ≥2 independent sources
 *
 * Position in Intelligence Stack:
 *   D43 Longitudinal → D44 Signal Detection → D45+ (future engines)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  SignalType,
  UserImpact,
  SuggestedAction,
  SignalStatus,
  TimeWindow,
  EvidenceType,
  DetectionSource,
  PredictiveSignal,
  SignalEvidence,
  CreateSignalRequest,
  CreateSignalResponse,
  GetSignalsRequest,
  GetSignalsResponse,
  GetSignalDetailsResponse,
  AcknowledgeSignalRequest,
  AcknowledgeSignalResponse,
  DismissSignalRequest,
  DismissSignalResponse,
  RecordInterventionRequest,
  RecordInterventionResponse,
  GetSignalStatsResponse,
  RunDetectionRequest,
  RunDetectionResponse,
  DetectionInput,
  DETECTION_THRESHOLDS,
  SIGNAL_CLASS_RULES,
  SIGNAL_TYPE_METADATA
} from '../types/signal-detection';

// =============================================================================
// VTID-01138: Constants
// =============================================================================

export const VTID = 'VTID-01138';
const LOG_PREFIX = '[D44-Engine]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

// =============================================================================
// VTID-01138: Environment Detection
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
// VTID-01138: Supabase Client Factory
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
// VTID-01138: OASIS Event Emission
// =============================================================================

async function emitD44Event(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as any,
      source: 'd44-signal-detection-engine',
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
// VTID-01138: Detection Logic (Deterministic)
// =============================================================================

/**
 * Analyze trend direction from a series of numeric values
 */
function analyzeTrend(values: number[]): {
  direction: 'increasing' | 'decreasing' | 'stable' | 'oscillating';
  magnitude: number;
  confidence: number;
} {
  if (values.length < 3) {
    return { direction: 'stable', magnitude: 0, confidence: 0 };
  }

  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (values[i] - yMean);
    denominator += (i - xMean) * (i - xMean);
  }

  const slope = denominator !== 0 ? numerator / denominator : 0;
  const normalizedSlope = slope / (Math.abs(yMean) || 1);

  // Calculate variance for oscillation detection
  const variance = values.reduce((sum, v) => sum + (v - yMean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / (Math.abs(yMean) || 1);  // Coefficient of variation

  // Determine direction
  let direction: 'increasing' | 'decreasing' | 'stable' | 'oscillating';
  if (cv > 0.3 && Math.abs(normalizedSlope) < 0.1) {
    direction = 'oscillating';
  } else if (Math.abs(normalizedSlope) < 0.02) {
    direction = 'stable';
  } else if (normalizedSlope > 0) {
    direction = 'increasing';
  } else {
    direction = 'decreasing';
  }

  // Calculate magnitude as percentage change
  const firstValue = values[0];
  const lastValue = values[values.length - 1];
  const magnitude = firstValue !== 0
    ? Math.min(100, Math.abs(((lastValue - firstValue) / firstValue) * 100))
    : (lastValue !== 0 ? 100 : 0);

  // Confidence based on data consistency
  const confidence = Math.min(100, Math.round(
    (1 - cv) * 50 + (values.length / 10) * 50
  ));

  return { direction, magnitude: Math.round(magnitude), confidence: Math.max(0, confidence) };
}

/**
 * Check if change is persistent (≥3 occurrences or ≥7 days)
 */
function isPersistent(
  dataPoints: { recorded_at: string; value: number }[],
  minOccurrences: number = DETECTION_THRESHOLDS.MIN_OCCURRENCES,
  minDays: number = DETECTION_THRESHOLDS.MIN_DAYS
): boolean {
  if (dataPoints.length >= minOccurrences) {
    return true;
  }

  if (dataPoints.length >= 2) {
    const sorted = [...dataPoints].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    );
    const firstDate = new Date(sorted[0].recorded_at);
    const lastDate = new Date(sorted[sorted.length - 1].recorded_at);
    const daySpan = Math.ceil((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24));
    return daySpan >= minDays;
  }

  return false;
}

/**
 * Check if trend is directional (not just noise)
 */
function isDirectional(
  direction: 'increasing' | 'decreasing' | 'stable' | 'oscillating',
  magnitude: number
): boolean {
  // Oscillating is noise, stable is no change
  if (direction === 'oscillating' || direction === 'stable') {
    return false;
  }
  // Need meaningful magnitude
  return magnitude >= 10;
}

/**
 * Count independent evidence sources
 */
function countEvidenceSources(evidence: { type: string; source: string }[]): number {
  const uniqueSources = new Set(evidence.map(e => `${e.type}:${e.source}`));
  return uniqueSources.size;
}

/**
 * Determine user impact based on signal characteristics
 */
function determineImpact(
  signalType: SignalType,
  magnitude: number,
  confidence: number
): UserImpact {
  // High impact for health-related signals with high magnitude
  if (signalType === 'health_drift' || signalType === 'cognitive_load_increase') {
    if (magnitude >= 40 || confidence >= 85) {
      return 'high';
    }
  }

  // High impact for social withdrawal with high magnitude
  if (signalType === 'social_withdrawal' && magnitude >= 50) {
    return 'high';
  }

  // Medium impact for significant changes
  if (magnitude >= 30 || confidence >= 80) {
    return 'medium';
  }

  return 'low';
}

/**
 * Determine suggested action based on signal characteristics
 */
function determineSuggestedAction(
  signalType: SignalType,
  impact: UserImpact
): SuggestedAction {
  // High impact signals need check-in
  if (impact === 'high') {
    return 'check_in';
  }

  // Positive momentum just needs awareness
  if (signalType === 'positive_momentum') {
    return 'awareness';
  }

  // Medium impact needs reflection
  if (impact === 'medium') {
    return 'reflection';
  }

  return 'awareness';
}

/**
 * Generate explainability text for a signal
 */
function generateExplainabilityText(
  signalType: SignalType,
  direction: 'increasing' | 'decreasing' | 'stable' | 'oscillating',
  magnitude: number,
  timeWindow: TimeWindow,
  evidenceCount: number
): string {
  const metadata = SIGNAL_TYPE_METADATA[signalType];
  const timeWindowText = timeWindow.replace('last_', 'the last ').replace('_', ' ');

  const directionText = direction === 'increasing' ? 'increasing' :
                        direction === 'decreasing' ? 'decreasing' :
                        'changing';

  const magnitudeText = magnitude >= 50 ? 'significantly' :
                        magnitude >= 30 ? 'noticeably' :
                        'slightly';

  let explanation = '';

  switch (signalType) {
    case 'health_drift':
      explanation = `Over ${timeWindowText}, your health metrics have been ${magnitudeText} ${directionText}. This pattern was detected across ${evidenceCount} different data points.`;
      break;
    case 'behavioral_drift':
      explanation = `Your behavior patterns have been ${magnitudeText} shifting over ${timeWindowText}. We noticed this change based on ${evidenceCount} observations.`;
      break;
    case 'routine_instability':
      explanation = `Your regular routines appear less stable than usual over ${timeWindowText}. This is based on ${evidenceCount} data points showing more variation.`;
      break;
    case 'cognitive_load_increase':
      explanation = `Signs suggest ${magnitudeText} higher mental load over ${timeWindowText}. This pattern emerged from ${evidenceCount} different indicators.`;
      break;
    case 'social_withdrawal':
      explanation = `Your social interactions have ${magnitudeText} decreased over ${timeWindowText}. We detected this trend from ${evidenceCount} observations.`;
      break;
    case 'social_overload':
      explanation = `You've had ${magnitudeText} more social interactions than usual over ${timeWindowText}. This is based on ${evidenceCount} data points.`;
      break;
    case 'preference_shift':
      explanation = `Your preferences appear to be evolving over ${timeWindowText}. We noticed ${magnitudeText} changes across ${evidenceCount} preference indicators.`;
      break;
    case 'positive_momentum':
      explanation = `Great news! Positive trends detected over ${timeWindowText}. We saw ${magnitudeText} improvements across ${evidenceCount} areas.`;
      break;
    default:
      explanation = `A pattern was detected over ${timeWindowText} based on ${evidenceCount} data points.`;
  }

  return explanation;
}

// =============================================================================
// VTID-01138: Signal Detection Functions
// =============================================================================

/**
 * Detect health drift signal
 */
function detectHealthDrift(
  input: DetectionInput,
  timeWindow: TimeWindow
): { detected: boolean; signal?: Partial<CreateSignalRequest>; evidence?: { type: string; source: string; summary: string }[] } {
  const healthFeatures = input.health_features || [];
  const vitanaScores = input.vitana_scores || [];

  if (healthFeatures.length < SIGNAL_CLASS_RULES.health_drift.min_data_points &&
      vitanaScores.length < SIGNAL_CLASS_RULES.health_drift.min_data_points) {
    return { detected: false };
  }

  // Analyze vitana scores trend
  const evidence: { type: string; source: string; summary: string }[] = [];
  let overallDirection: 'increasing' | 'decreasing' | 'stable' | 'oscillating' = 'stable';
  let overallMagnitude = 0;
  let overallConfidence = 0;

  if (vitanaScores.length >= 3) {
    const scores = vitanaScores.map(s => s.overall_score);
    const trend = analyzeTrend(scores);

    if (isDirectional(trend.direction, trend.magnitude)) {
      overallDirection = trend.direction;
      overallMagnitude = trend.magnitude;
      overallConfidence = trend.confidence;
      evidence.push({
        type: 'health',
        source: 'vitana_scores',
        summary: `Vitana score ${trend.direction} by ${trend.magnitude}%`
      });
    }
  }

  // Analyze health features
  const featureGroups = new Map<string, number[]>();
  for (const feature of healthFeatures) {
    const existing = featureGroups.get(feature.feature_key) || [];
    existing.push(feature.value);
    featureGroups.set(feature.feature_key, existing);
  }

  for (const [key, values] of featureGroups) {
    if (values.length >= 3) {
      const trend = analyzeTrend(values);
      if (isDirectional(trend.direction, trend.magnitude) && trend.confidence >= 60) {
        evidence.push({
          type: 'health',
          source: key,
          summary: `${key} ${trend.direction} by ${trend.magnitude}%`
        });
        if (trend.magnitude > overallMagnitude) {
          overallDirection = trend.direction;
          overallMagnitude = trend.magnitude;
        }
        overallConfidence = Math.max(overallConfidence, trend.confidence);
      }
    }
  }

  // Check detection rules
  if (countEvidenceSources(evidence) < DETECTION_THRESHOLDS.MIN_EVIDENCE_SOURCES) {
    return { detected: false };
  }

  if (overallConfidence < DETECTION_THRESHOLDS.MIN_CONFIDENCE) {
    return { detected: false };
  }

  const impact = determineImpact('health_drift', overallMagnitude, overallConfidence);
  const suggestedAction = determineSuggestedAction('health_drift', impact);

  return {
    detected: true,
    signal: {
      signal_type: 'health_drift',
      confidence: overallConfidence,
      time_window: timeWindow,
      detected_change: `Health metrics ${overallDirection} by ${overallMagnitude}%`,
      user_impact: impact,
      suggested_action: suggestedAction,
      explainability_text: generateExplainabilityText(
        'health_drift',
        overallDirection,
        overallMagnitude,
        timeWindow,
        evidence.length
      ),
      evidence_count: evidence.length,
      domains_analyzed: ['health'],
      data_points_analyzed: healthFeatures.length + vitanaScores.length
    },
    evidence
  };
}

/**
 * Detect social withdrawal signal
 */
function detectSocialWithdrawal(
  input: DetectionInput,
  timeWindow: TimeWindow
): { detected: boolean; signal?: Partial<CreateSignalRequest>; evidence?: { type: string; source: string; summary: string }[] } {
  const relationships = input.relationships || [];
  const diaryEntries = input.diary_entries || [];
  const longitudinalPoints = input.longitudinal_data_points || [];

  const evidence: { type: string; source: string; summary: string }[] = [];
  let withdrawalDetected = false;
  let magnitude = 0;
  let confidence = 0;

  // Check relationship strength trends
  const socialPoints = longitudinalPoints.filter(p => p.domain === 'social');
  if (socialPoints.length >= 3) {
    const values = socialPoints
      .filter(p => p.numeric_value !== undefined)
      .map(p => p.numeric_value as number);

    if (values.length >= 3) {
      const trend = analyzeTrend(values);
      if (trend.direction === 'decreasing' && trend.magnitude >= 20) {
        withdrawalDetected = true;
        magnitude = trend.magnitude;
        confidence = trend.confidence;
        evidence.push({
          type: 'social',
          source: 'longitudinal_social',
          summary: `Social engagement decreased by ${trend.magnitude}%`
        });
      }
    }
  }

  // Check diary sentiment for social mentions
  const socialDiaryEntries = diaryEntries.filter(d =>
    d.topics?.some(t => t.toLowerCase().includes('social') ||
                       t.toLowerCase().includes('friend') ||
                       t.toLowerCase().includes('family'))
  );

  if (socialDiaryEntries.length >= 2) {
    const negativeCount = socialDiaryEntries.filter(d => d.sentiment === 'negative').length;
    if (negativeCount >= socialDiaryEntries.length * 0.5) {
      evidence.push({
        type: 'diary',
        source: 'social_mentions',
        summary: `${negativeCount} negative social mentions in diary`
      });
      if (!withdrawalDetected) {
        withdrawalDetected = true;
        magnitude = Math.round((negativeCount / socialDiaryEntries.length) * 100);
        confidence = 65;
      }
    }
  }

  // Check detection rules
  if (!withdrawalDetected) {
    return { detected: false };
  }

  if (countEvidenceSources(evidence) < DETECTION_THRESHOLDS.MIN_EVIDENCE_SOURCES) {
    return { detected: false };
  }

  if (confidence < DETECTION_THRESHOLDS.MIN_CONFIDENCE) {
    return { detected: false };
  }

  const impact = determineImpact('social_withdrawal', magnitude, confidence);
  const suggestedAction = determineSuggestedAction('social_withdrawal', impact);

  return {
    detected: true,
    signal: {
      signal_type: 'social_withdrawal',
      confidence,
      time_window: timeWindow,
      detected_change: `Social interactions decreased by ${magnitude}%`,
      user_impact: impact,
      suggested_action: suggestedAction,
      explainability_text: generateExplainabilityText(
        'social_withdrawal',
        'decreasing',
        magnitude,
        timeWindow,
        evidence.length
      ),
      evidence_count: evidence.length,
      domains_analyzed: ['social'],
      data_points_analyzed: socialPoints.length + diaryEntries.length
    },
    evidence
  };
}

/**
 * Detect positive momentum signal
 */
function detectPositiveMomentum(
  input: DetectionInput,
  timeWindow: TimeWindow
): { detected: boolean; signal?: Partial<CreateSignalRequest>; evidence?: { type: string; source: string; summary: string }[] } {
  const vitanaScores = input.vitana_scores || [];
  const diaryEntries = input.diary_entries || [];
  const longitudinalPoints = input.longitudinal_data_points || [];

  const evidence: { type: string; source: string; summary: string }[] = [];
  let positiveDetected = false;
  let overallMagnitude = 0;
  let overallConfidence = 0;

  // Check vitana score improvement
  if (vitanaScores.length >= 3) {
    const scores = vitanaScores.map(s => s.overall_score);
    const trend = analyzeTrend(scores);

    if (trend.direction === 'increasing' && trend.magnitude >= 10) {
      positiveDetected = true;
      overallMagnitude = trend.magnitude;
      overallConfidence = trend.confidence;
      evidence.push({
        type: 'health',
        source: 'vitana_scores',
        summary: `Vitana score improved by ${trend.magnitude}%`
      });
    }
  }

  // Check diary mood improvement
  if (diaryEntries.length >= 3) {
    const moodScores = diaryEntries
      .filter(d => d.mood_score !== undefined)
      .map(d => d.mood_score as number);

    if (moodScores.length >= 3) {
      const trend = analyzeTrend(moodScores);
      if (trend.direction === 'increasing' && trend.magnitude >= 10) {
        evidence.push({
          type: 'diary',
          source: 'mood_scores',
          summary: `Mood improved by ${trend.magnitude}%`
        });
        if (!positiveDetected) {
          positiveDetected = true;
          overallMagnitude = trend.magnitude;
          overallConfidence = trend.confidence;
        }
      }
    }
  }

  // Check engagement improvement
  const engagementPoints = longitudinalPoints.filter(p => p.domain === 'engagement');
  if (engagementPoints.length >= 3) {
    const values = engagementPoints
      .filter(p => p.numeric_value !== undefined)
      .map(p => p.numeric_value as number);

    if (values.length >= 3) {
      const trend = analyzeTrend(values);
      if (trend.direction === 'increasing' && trend.magnitude >= 15) {
        evidence.push({
          type: 'behavior',
          source: 'engagement',
          summary: `Engagement increased by ${trend.magnitude}%`
        });
        if (!positiveDetected) {
          positiveDetected = true;
          overallMagnitude = trend.magnitude;
          overallConfidence = trend.confidence;
        }
      }
    }
  }

  // Check detection rules
  if (!positiveDetected) {
    return { detected: false };
  }

  if (countEvidenceSources(evidence) < DETECTION_THRESHOLDS.MIN_EVIDENCE_SOURCES) {
    return { detected: false };
  }

  if (overallConfidence < DETECTION_THRESHOLDS.MIN_CONFIDENCE) {
    return { detected: false };
  }

  const impact: UserImpact = 'low';  // Positive momentum is always low impact (informational)
  const suggestedAction: SuggestedAction = 'awareness';

  return {
    detected: true,
    signal: {
      signal_type: 'positive_momentum',
      confidence: overallConfidence,
      time_window: timeWindow,
      detected_change: `Positive trends across ${evidence.length} areas`,
      user_impact: impact,
      suggested_action: suggestedAction,
      explainability_text: generateExplainabilityText(
        'positive_momentum',
        'increasing',
        overallMagnitude,
        timeWindow,
        evidence.length
      ),
      evidence_count: evidence.length,
      domains_analyzed: ['health', 'engagement', 'social'],
      data_points_analyzed: vitanaScores.length + diaryEntries.length + engagementPoints.length
    },
    evidence
  };
}

/**
 * Detect routine instability signal
 */
function detectRoutineInstability(
  input: DetectionInput,
  timeWindow: TimeWindow
): { detected: boolean; signal?: Partial<CreateSignalRequest>; evidence?: { type: string; source: string; summary: string }[] } {
  const diaryEntries = input.diary_entries || [];
  const calendarDensity = input.calendar_density;
  const longitudinalPoints = input.longitudinal_data_points || [];

  const evidence: { type: string; source: string; summary: string }[] = [];
  let instabilityDetected = false;
  let magnitude = 0;
  let confidence = 0;

  // Check diary energy level variance
  if (diaryEntries.length >= 5) {
    const energyLevels = diaryEntries
      .filter(d => d.energy_level !== undefined)
      .map(d => d.energy_level as number);

    if (energyLevels.length >= 5) {
      const mean = energyLevels.reduce((a, b) => a + b, 0) / energyLevels.length;
      const variance = energyLevels.reduce((sum, v) => sum + (v - mean) ** 2, 0) / energyLevels.length;
      const cv = Math.sqrt(variance) / (Math.abs(mean) || 1);

      if (cv > 0.3) {
        instabilityDetected = true;
        magnitude = Math.min(100, Math.round(cv * 100));
        confidence = 70;
        evidence.push({
          type: 'diary',
          source: 'energy_variance',
          summary: `Energy levels vary by ${magnitude}%`
        });
      }
    }
  }

  // Check engagement pattern variance
  const engagementPoints = longitudinalPoints.filter(p => p.domain === 'engagement');
  if (engagementPoints.length >= 5) {
    const values = engagementPoints
      .filter(p => p.numeric_value !== undefined)
      .map(p => p.numeric_value as number);

    if (values.length >= 5) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
      const cv = Math.sqrt(variance) / (Math.abs(mean) || 1);

      if (cv > 0.25) {
        evidence.push({
          type: 'behavior',
          source: 'engagement_variance',
          summary: `Engagement patterns vary by ${Math.round(cv * 100)}%`
        });
        if (!instabilityDetected) {
          instabilityDetected = true;
          magnitude = Math.min(100, Math.round(cv * 100));
          confidence = 65;
        }
      }
    }
  }

  // Check detection rules
  if (!instabilityDetected) {
    return { detected: false };
  }

  if (countEvidenceSources(evidence) < DETECTION_THRESHOLDS.MIN_EVIDENCE_SOURCES) {
    return { detected: false };
  }

  if (confidence < DETECTION_THRESHOLDS.MIN_CONFIDENCE) {
    return { detected: false };
  }

  const impact = determineImpact('routine_instability', magnitude, confidence);
  const suggestedAction = determineSuggestedAction('routine_instability', impact);

  return {
    detected: true,
    signal: {
      signal_type: 'routine_instability',
      confidence,
      time_window: timeWindow,
      detected_change: `Routine patterns vary by ${magnitude}%`,
      user_impact: impact,
      suggested_action: suggestedAction,
      explainability_text: generateExplainabilityText(
        'routine_instability',
        'oscillating',
        magnitude,
        timeWindow,
        evidence.length
      ),
      evidence_count: evidence.length,
      domains_analyzed: ['engagement', 'health'],
      data_points_analyzed: diaryEntries.length + engagementPoints.length
    },
    evidence
  };
}

// =============================================================================
// VTID-01138: Public API Functions
// =============================================================================

/**
 * Create a predictive signal
 */
export async function createSignal(
  request: CreateSignalRequest,
  authToken?: string
): Promise<CreateSignalResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d44_create_signal', {
      p_signal: request
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (create_signal):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'CREATION_FAILED' };
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Signal created in ${duration}ms: ${data.signal_type}`);

    await emitD44Event(
      'd44.signal.created',
      'success',
      `Signal created: ${request.signal_type}`,
      {
        signal_id: data.id,
        signal_type: request.signal_type,
        confidence: request.confidence,
        user_impact: request.user_impact,
        duration_ms: duration
      }
    );

    return {
      ok: true,
      signal_id: data.id,
      signal_type: request.signal_type,
      expires_at: data.expires_at
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error creating signal:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get active signals for the current user
 */
export async function getActiveSignals(
  request: GetSignalsRequest,
  authToken?: string
): Promise<GetSignalsResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d44_get_active_signals', {
      p_signal_types: request.signal_types || null,
      p_min_confidence: request.min_confidence || 0,
      p_limit: request.limit || 20
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (get_active_signals):`, error);
      return { ok: false, error: error.message };
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Retrieved ${data?.length || 0} signals in ${duration}ms`);

    return {
      ok: true,
      signals: data || [],
      count: data?.length || 0
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting signals:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get signal details with evidence and history
 */
export async function getSignalDetails(
  signalId: string,
  authToken?: string
): Promise<GetSignalDetailsResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    // Get signal
    const { data: signals, error: signalError } = await supabase
      .from('d44_predictive_signals')
      .select('*')
      .eq('id', signalId)
      .limit(1);

    if (signalError) {
      console.error(`${LOG_PREFIX} Error getting signal:`, signalError);
      return { ok: false, error: signalError.message };
    }

    if (!signals || signals.length === 0) {
      return { ok: false, error: 'SIGNAL_NOT_FOUND' };
    }

    // Get evidence
    const { data: evidence, error: evidenceError } = await supabase.rpc('d44_get_signal_evidence', {
      p_signal_id: signalId
    });

    // Get history
    const { data: history, error: historyError } = await supabase
      .from('d44_intervention_history')
      .select('*')
      .eq('signal_id', signalId)
      .order('created_at', { ascending: false });

    return {
      ok: true,
      signal: signals[0],
      evidence: evidenceError ? [] : evidence,
      history: historyError ? [] : history
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting signal details:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Acknowledge a signal
 */
export async function acknowledgeSignal(
  request: AcknowledgeSignalRequest,
  authToken?: string
): Promise<AcknowledgeSignalResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d44_update_signal_status', {
      p_signal_id: request.signal_id,
      p_status: 'acknowledged',
      p_feedback: request.feedback || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (acknowledge):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'ACKNOWLEDGE_FAILED' };
    }

    console.log(`${LOG_PREFIX} Signal acknowledged: ${request.signal_id}`);

    await emitD44Event(
      'd44.signal.acknowledged',
      'success',
      'Signal acknowledged by user',
      {
        signal_id: request.signal_id,
        had_feedback: !!request.feedback
      }
    );

    return {
      ok: true,
      signal_id: request.signal_id,
      status: 'acknowledged'
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error acknowledging signal:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Dismiss a signal
 */
export async function dismissSignal(
  request: DismissSignalRequest,
  authToken?: string
): Promise<DismissSignalResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d44_update_signal_status', {
      p_signal_id: request.signal_id,
      p_status: 'dismissed',
      p_feedback: request.reason || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (dismiss):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'DISMISS_FAILED' };
    }

    console.log(`${LOG_PREFIX} Signal dismissed: ${request.signal_id}`);

    await emitD44Event(
      'd44.signal.dismissed',
      'info',
      'Signal dismissed by user',
      {
        signal_id: request.signal_id,
        had_reason: !!request.reason
      }
    );

    return {
      ok: true,
      signal_id: request.signal_id,
      status: 'dismissed'
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error dismissing signal:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Record an intervention action
 */
export async function recordIntervention(
  request: RecordInterventionRequest,
  authToken?: string
): Promise<RecordInterventionResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d44_record_intervention', {
      p_signal_id: request.signal_id,
      p_action_type: request.action_type,
      p_action_details: request.action_details
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (record_intervention):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'INTERVENTION_FAILED' };
    }

    console.log(`${LOG_PREFIX} Intervention recorded: ${request.action_type}`);

    await emitD44Event(
      'd44.intervention.recorded',
      'success',
      `Intervention recorded: ${request.action_type}`,
      {
        signal_id: request.signal_id,
        action_type: request.action_type
      }
    );

    return {
      ok: true,
      intervention_id: data.id
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error recording intervention:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get signal statistics
 */
export async function getSignalStats(
  since?: string,
  authToken?: string
): Promise<GetSignalStatsResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const { data, error } = await supabase.rpc('d44_get_signal_stats', {
      p_since: since || null
    });

    if (error) {
      console.error(`${LOG_PREFIX} RPC error (get_signal_stats):`, error);
      return { ok: false, error: error.message };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'STATS_FAILED' };
    }

    return {
      ok: true,
      total_signals: data.total_signals,
      active_signals: data.active_signals,
      acknowledged_signals: data.acknowledged_signals,
      dismissed_signals: data.dismissed_signals,
      high_impact_signals: data.high_impact_signals,
      by_type: data.by_type,
      avg_confidence: data.avg_confidence,
      since: data.since
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting stats:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Run signal detection across all signal types
 */
export async function runDetection(
  input: DetectionInput,
  request: RunDetectionRequest,
  authToken?: string
): Promise<RunDetectionResponse> {
  const startTime = Date.now();
  const detectedSignals: Partial<CreateSignalRequest>[] = [];
  const allEvidence: { signalType: SignalType; evidence: { type: string; source: string; summary: string }[] }[] = [];

  try {
    await emitD44Event(
      'd44.detection.started',
      'info',
      'Signal detection run started',
      {
        signal_types: request.signal_types || 'all',
        time_window: request.time_window
      }
    );

    // Run detection for each signal type
    const signalTypesToCheck = request.signal_types || [
      'health_drift',
      'social_withdrawal',
      'positive_momentum',
      'routine_instability'
    ] as SignalType[];

    for (const signalType of signalTypesToCheck) {
      let result: { detected: boolean; signal?: Partial<CreateSignalRequest>; evidence?: { type: string; source: string; summary: string }[] };

      switch (signalType) {
        case 'health_drift':
          result = detectHealthDrift(input, request.time_window);
          break;
        case 'social_withdrawal':
          result = detectSocialWithdrawal(input, request.time_window);
          break;
        case 'positive_momentum':
          result = detectPositiveMomentum(input, request.time_window);
          break;
        case 'routine_instability':
          result = detectRoutineInstability(input, request.time_window);
          break;
        default:
          continue;
      }

      if (result.detected && result.signal) {
        detectedSignals.push(result.signal);
        if (result.evidence) {
          allEvidence.push({ signalType, evidence: result.evidence });
        }
      }
    }

    // Create signals in database
    let signalsCreated = 0;
    let signalsSkipped = 0;
    const createdSignals: PredictiveSignal[] = [];

    for (const signal of detectedSignals) {
      // Check rate limiting (skip if we already have a recent signal of this type)
      if (!request.force) {
        const { supabase } = await getClientWithContext(authToken);
        if (supabase) {
          const oneWeekAgo = new Date();
          oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

          const { data: recentSignals } = await supabase
            .from('d44_predictive_signals')
            .select('id')
            .eq('signal_type', signal.signal_type)
            .gte('detected_at', oneWeekAgo.toISOString())
            .limit(1);

          if (recentSignals && recentSignals.length >= DETECTION_THRESHOLDS.MAX_SIGNALS_PER_TYPE_PER_WEEK) {
            signalsSkipped++;
            continue;
          }
        }
      }

      const createResult = await createSignal(signal as CreateSignalRequest, authToken);
      if (createResult.ok) {
        signalsCreated++;
        // Note: We'd need to fetch the full signal to add to createdSignals
      }
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Detection completed in ${duration}ms: ${detectedSignals.length} detected, ${signalsCreated} created, ${signalsSkipped} skipped`);

    await emitD44Event(
      'd44.detection.completed',
      'success',
      `Signal detection completed: ${signalsCreated} signals created`,
      {
        signals_detected: detectedSignals.length,
        signals_created: signalsCreated,
        signals_skipped: signalsSkipped,
        duration_ms: duration
      }
    );

    return {
      ok: true,
      signals_detected: detectedSignals.length,
      signals_created: signalsCreated,
      signals_skipped: signalsSkipped,
      duration_ms: duration
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error running detection:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

// =============================================================================
// VTID-01138: Convenience Functions for ORB Integration
// =============================================================================

/**
 * Get signal context for ORB system prompt injection
 */
export async function getSignalContextForOrb(
  authToken?: string
): Promise<{ context: string; activeSignals: number } | null> {
  try {
    const result = await getActiveSignals({
      min_confidence: 70,
      limit: 5
    }, authToken);

    if (!result.ok || !result.signals || result.signals.length === 0) {
      return null;
    }

    const contextLines: string[] = [];

    // Summarize active signals
    const highImpact = result.signals.filter(s => s.user_impact === 'high');
    const mediumImpact = result.signals.filter(s => s.user_impact === 'medium');

    if (highImpact.length > 0) {
      contextLines.push(`${highImpact.length} high-priority signal(s) detected that may warrant attention.`);
    }

    if (mediumImpact.length > 0) {
      contextLines.push(`${mediumImpact.length} pattern(s) worth being aware of.`);
    }

    // Add specific signal types
    const signalTypes = new Set(result.signals.map(s => s.signal_type));
    if (signalTypes.has('health_drift')) {
      contextLines.push('Health metrics are showing a notable trend.');
    }
    if (signalTypes.has('social_withdrawal')) {
      contextLines.push('Social interactions have decreased recently.');
    }
    if (signalTypes.has('positive_momentum')) {
      contextLines.push('Positive trends detected in some areas.');
    }

    return {
      context: contextLines.join(' '),
      activeSignals: result.signals.length
    };

  } catch (err) {
    console.error(`${LOG_PREFIX} Error getting signal context for ORB:`, err);
    return null;
  }
}

// =============================================================================
// VTID-01138: Exports
// =============================================================================

export {
  analyzeTrend,
  isPersistent,
  isDirectional,
  countEvidenceSources,
  determineImpact,
  determineSuggestedAction,
  generateExplainabilityText,
  detectHealthDrift,
  detectSocialWithdrawal,
  detectPositiveMomentum,
  detectRoutineInstability,
  DETECTION_THRESHOLDS,
  SIGNAL_CLASS_RULES,
  SIGNAL_TYPE_METADATA
};

export default {
  VTID,
  createSignal,
  getActiveSignals,
  getSignalDetails,
  acknowledgeSignal,
  dismissSignal,
  recordIntervention,
  getSignalStats,
  runDetection,
  getSignalContextForOrb
};
