/**
 * VTID-01130: D36 Financial Sensitivity, Monetization Readiness & Value Perception Engine
 *
 * Deterministic engine that understands whether, when, and how money should enter
 * the conversation — without damaging trust, comfort, or perceived value.
 *
 * Core Question: "Is this the right moment to suggest something paid — and in what form?"
 *
 * Hard Constraints (Non-Negotiable):
 *   - Never lead with price — always lead with value
 *   - Never stack multiple paid suggestions
 *   - No monetization when emotional vulnerability is detected
 *   - Explicit user "no" blocks monetization immediately
 *   - Zero social pressure allowed
 *
 * Dependencies:
 *   - D29: Trust & Feedback Loops (trust_repair_service)
 *   - D28: Emotional & Cognitive Signals (d28-emotional-cognitive-engine)
 *   - D27: User Preferences & Constraints
 *   - D33: Availability & Readiness (when available)
 *   - D35: Social Context & Comfort (when available)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import { TrustRepairService, TrustContext } from './trust-repair-service';
import { getCurrentSignals, SignalBundle } from './d28-emotional-cognitive-engine';
import {
  FinancialSensitivity,
  FinancialSensitivityInference,
  FinancialSignal,
  FinancialSignalType,
  MonetizationReadiness,
  MonetizationReadinessComponents,
  MonetizationBlocker,
  MonetizationBlockerType,
  ValuePerceptionProfile,
  ValueDriver,
  ValueSignal,
  ValueSignalType,
  MonetizationEnvelope,
  MonetizationType,
  FramingStyle,
  MonetizationTag,
  GatingCheckResult,
  GatingCheck,
  GatingCheckType,
  MonetizationAttempt,
  MonetizationOutcome,
  ComputeMonetizationContextResponse,
  RecordSignalResponse,
  RecordAttemptResponse,
  GetEnvelopeResponse,
  GetHistoryResponse,
  OrbMonetizationContext,
  toOrbMonetizationContext,
  formatMonetizationContextForPrompt,
  READINESS_WEIGHTS,
  DEFAULT_READINESS_THRESHOLD,
  REJECTION_COOLDOWN_MINUTES,
  MAX_ATTEMPTS_PER_SESSION,
  ENVELOPE_VALIDITY_MINUTES,
  FINANCIAL_SENSITIVITY_KEYWORDS,
  BLOCKING_EMOTIONAL_STATES,
} from '../types/financial-monetization';

// =============================================================================
// Constants
// =============================================================================

const VTID = 'VTID-01130';
const LOG_PREFIX = '[D36-Engine]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

// =============================================================================
// Environment Detection
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
// Supabase Client
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

// =============================================================================
// Financial Sensitivity Inference
// =============================================================================

/**
 * Detect financial sensitivity signals from user message.
 * Deterministic keyword-based detection.
 */
export function detectFinancialSignals(message: string): FinancialSignal[] {
  const signals: FinancialSignal[] = [];
  const lowerMessage = message.toLowerCase();
  const now = new Date().toISOString();

  // Check for high sensitivity keywords
  for (const keyword of FINANCIAL_SENSITIVITY_KEYWORDS.high_sensitivity) {
    if (lowerMessage.includes(keyword)) {
      signals.push({
        signal_type: 'budget_language_detected',
        indicator: 'negative', // Indicates higher sensitivity
        weight: 80,
        detected_at: now,
        context: `Detected keyword: "${keyword}"`
      });
    }
  }

  // Check for deferral language
  for (const keyword of FINANCIAL_SENSITIVITY_KEYWORDS.deferral) {
    if (lowerMessage.includes(keyword)) {
      signals.push({
        signal_type: 'paid_suggestion_deferred',
        indicator: 'neutral',
        weight: 60,
        detected_at: now,
        context: `Detected deferral keyword: "${keyword}"`
      });
    }
  }

  // Check for value-seeking language
  for (const keyword of FINANCIAL_SENSITIVITY_KEYWORDS.value_seeking) {
    if (lowerMessage.includes(keyword)) {
      signals.push({
        signal_type: 'value_question',
        indicator: 'positive', // Shows engagement with value proposition
        weight: 70,
        detected_at: now,
        context: `Detected value keyword: "${keyword}"`
      });
    }
  }

  return signals;
}

/**
 * Infer financial sensitivity from historical signals.
 */
export async function inferFinancialSensitivity(
  authToken?: string
): Promise<FinancialSensitivityInference> {
  const now = new Date().toISOString();

  try {
    let supabase: SupabaseClient | null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    } else {
      // Return unknown if no auth
      return {
        level: 'unknown',
        confidence: 0,
        signals_detected: [],
        last_updated: now
      };
    }

    if (!supabase) {
      return {
        level: 'unknown',
        confidence: 0,
        signals_detected: [],
        last_updated: now
      };
    }

    // Bootstrap dev context if needed
    if (useDevIdentity) {
      try {
        await supabase.rpc('dev_bootstrap_request_context', {
          p_tenant_id: DEV_IDENTITY.TENANT_ID,
          p_active_role: 'developer'
        });
      } catch {
        // Ignore bootstrap errors in dev mode
      }
    }

    // Fetch recent financial signals (last 30 days)
    const { data: signalsData, error: signalsError } = await supabase
      .from('monetization_signals')
      .select('*')
      .gte('detected_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('detected_at', { ascending: false })
      .limit(50);

    if (signalsError) {
      console.warn(`${LOG_PREFIX} Failed to fetch signals:`, signalsError.message);
    }

    const signals: FinancialSignal[] = signalsData || [];

    // Calculate sensitivity based on signals
    let negativeWeight = 0;
    let positiveWeight = 0;
    let totalWeight = 0;

    for (const signal of signals) {
      const weight = signal.weight || 50;
      totalWeight += weight;
      if (signal.indicator === 'negative') {
        negativeWeight += weight;
      } else if (signal.indicator === 'positive') {
        positiveWeight += weight;
      }
    }

    // Determine sensitivity level
    let level: FinancialSensitivity = 'unknown';
    let confidence = 0;

    if (signals.length >= 3) {
      const negativeRatio = totalWeight > 0 ? negativeWeight / totalWeight : 0;
      const positiveRatio = totalWeight > 0 ? positiveWeight / totalWeight : 0;

      if (negativeRatio > 0.6) {
        level = 'high';
        confidence = Math.min(90, 50 + negativeRatio * 50);
      } else if (positiveRatio > 0.6) {
        level = 'low';
        confidence = Math.min(90, 50 + positiveRatio * 50);
      } else {
        level = 'medium';
        confidence = Math.min(75, 40 + signals.length * 5);
      }
    } else if (signals.length > 0) {
      level = 'medium'; // Default with limited data
      confidence = 30 + signals.length * 10;
    }

    return {
      level,
      confidence,
      signals_detected: signals,
      last_updated: now
    };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error inferring financial sensitivity:`, error);
    return {
      level: 'unknown',
      confidence: 0,
      signals_detected: [],
      last_updated: now
    };
  }
}

// =============================================================================
// Monetization Readiness Scoring
// =============================================================================

/**
 * Compute monetization readiness score based on multiple signals.
 */
export async function computeMonetizationReadiness(
  authToken?: string,
  sessionId?: string
): Promise<MonetizationReadiness> {
  const now = new Date().toISOString();
  const blockers: MonetizationBlocker[] = [];

  // Initialize components with defaults
  const components: MonetizationReadinessComponents = {
    trust_component: 0.7, // Default moderate trust
    availability_component: 0.8, // Default available
    emotional_component: 0.8, // Default neutral emotional state
    urgency_component: 0.5, // Default no urgency
    history_component: 0.5 // Default neutral history
  };

  try {
    // Get trust context from D29
    if (authToken) {
      const trustService = TrustRepairService.createWithUserToken(authToken);
      const trustContext = await trustService.getTrustContext();

      if (trustContext) {
        // Map trust score (0-100) to component (0-1)
        components.trust_component = trustContext.overallTrust / 100;

        // Check for low trust blocker
        if (trustContext.overallTrust < 30) {
          blockers.push({
            blocker_type: 'low_trust',
            severity: 'hard',
            reason: `Trust score ${trustContext.overallTrust} is below minimum threshold`
          });
        } else if (trustContext.overallTrust < 50) {
          blockers.push({
            blocker_type: 'low_trust',
            severity: 'soft',
            reason: `Trust score ${trustContext.overallTrust} is low`
          });
        }
      }
    }

    // Get emotional context from D28
    const emotionalSignals = await getCurrentSignals(sessionId, authToken);
    if (emotionalSignals.ok && emotionalSignals.signals && emotionalSignals.signals.length > 0) {
      const latestSignal = emotionalSignals.signals[0];

      // Check for blocking emotional states
      for (const emotionalState of latestSignal.emotional_states) {
        if (BLOCKING_EMOTIONAL_STATES.includes(emotionalState.state as any)) {
          if (emotionalState.confidence >= 60) {
            blockers.push({
              blocker_type: 'emotional_vulnerability',
              severity: 'hard',
              reason: `User appears ${emotionalState.state} (confidence: ${emotionalState.confidence}%)`
            });
            components.emotional_component = 0.2;
          } else if (emotionalState.confidence >= 40) {
            components.emotional_component = Math.max(0.4, components.emotional_component - 0.3);
          }
        }
      }

      // Adjust for engagement level
      if (latestSignal.engagement_level === 'high') {
        components.emotional_component = Math.min(1.0, components.emotional_component + 0.2);
      } else if (latestSignal.engagement_level === 'low') {
        components.emotional_component = Math.max(0.3, components.emotional_component - 0.2);
      }

      // Check urgency
      if (latestSignal.urgency.detected) {
        components.urgency_component = 0.8; // Urgency can be good for monetization
      }
    }

    // Get monetization history
    let supabase: SupabaseClient | null;
    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
    } else {
      supabase = null;
    }

    if (supabase) {
      // Check for recent rejections
      const { data: recentAttempts } = await supabase
        .from('monetization_attempts')
        .select('*')
        .eq('session_id', sessionId || 'current')
        .order('created_at', { ascending: false })
        .limit(10);

      if (recentAttempts && recentAttempts.length > 0) {
        const rejections = recentAttempts.filter(a => a.outcome === 'rejected');
        const acceptances = recentAttempts.filter(a => a.outcome === 'accepted');

        // Update history component
        if (recentAttempts.length >= 2) {
          const acceptanceRate = acceptances.length / recentAttempts.length;
          components.history_component = acceptanceRate;
        }

        // Check for recent rejection cooldown
        const lastRejection = rejections[0];
        if (lastRejection) {
          const rejectionTime = new Date(lastRejection.created_at).getTime();
          const cooldownEnd = rejectionTime + (REJECTION_COOLDOWN_MINUTES * 60 * 1000);

          if (Date.now() < cooldownEnd) {
            blockers.push({
              blocker_type: 'recent_rejection',
              severity: 'soft',
              reason: 'User rejected a suggestion recently',
              expires_at: new Date(cooldownEnd).toISOString()
            });
            components.history_component = Math.max(0.2, components.history_component - 0.3);
          }
        }

        // Check session attempt limit
        const sessionAttempts = recentAttempts.filter(
          a => a.session_id === sessionId && a.outcome !== 'accepted'
        );
        if (sessionAttempts.length >= MAX_ATTEMPTS_PER_SESSION) {
          blockers.push({
            blocker_type: 'session_limit_reached',
            severity: 'hard',
            reason: `${sessionAttempts.length} attempts this session exceeds limit of ${MAX_ATTEMPTS_PER_SESSION}`
          });
        }
      }
    }

    // Calculate weighted score
    const score =
      components.trust_component * READINESS_WEIGHTS.trust +
      components.availability_component * READINESS_WEIGHTS.availability +
      components.emotional_component * READINESS_WEIGHTS.emotional +
      components.urgency_component * READINESS_WEIGHTS.urgency +
      components.history_component * READINESS_WEIGHTS.history;

    // Calculate confidence based on data availability
    let confidence = 50; // Base confidence
    if (authToken) confidence += 20; // Have user context
    if (emotionalSignals.ok) confidence += 15; // Have emotional data
    if (supabase) confidence += 15; // Have history data

    return {
      score: Math.max(0, Math.min(1, score)),
      confidence: Math.min(100, confidence),
      components,
      blockers,
      computed_at: now
    };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error computing readiness:`, error);
    return {
      score: 0.3, // Conservative default
      confidence: 20,
      components,
      blockers: [{
        blocker_type: 'cooldown_active',
        severity: 'soft',
        reason: 'Error computing readiness, defaulting to conservative'
      }],
      computed_at: now
    };
  }
}

// =============================================================================
// Value Perception Modeling
// =============================================================================

/**
 * Detect value signals from user message
 */
export function detectValueSignals(message: string): ValueSignal[] {
  const signals: ValueSignal[] = [];
  const lowerMessage = message.toLowerCase();
  const now = new Date().toISOString();

  // Outcome-oriented signals
  const outcomeKeywords = ['work', 'result', 'actually', 'really', 'effective', 'success', 'guarantee'];
  for (const keyword of outcomeKeywords) {
    if (lowerMessage.includes(keyword)) {
      signals.push({
        signal_type: 'asked_about_results',
        driver: 'outcome',
        strength: 70,
        detected_at: now,
        context: `Detected outcome keyword: "${keyword}"`
      });
    }
  }

  // Experience-oriented signals
  const experienceKeywords = ['like', 'feel', 'enjoy', 'comfortable', 'pleasant', 'experience'];
  for (const keyword of experienceKeywords) {
    if (lowerMessage.includes(keyword)) {
      signals.push({
        signal_type: 'asked_about_experience',
        driver: 'experience',
        strength: 65,
        detected_at: now,
        context: `Detected experience keyword: "${keyword}"`
      });
    }
  }

  // Efficiency-oriented signals
  const efficiencyKeywords = ['time', 'fast', 'quick', 'long', 'how soon', 'when', 'save'];
  for (const keyword of efficiencyKeywords) {
    if (lowerMessage.includes(keyword)) {
      signals.push({
        signal_type: 'asked_about_time',
        driver: 'efficiency',
        strength: 70,
        detected_at: now,
        context: `Detected efficiency keyword: "${keyword}"`
      });
    }
  }

  // Price-oriented signals
  const priceKeywords = ['cost', 'price', 'how much', 'expensive', 'cheap', 'afford', 'money'];
  for (const keyword of priceKeywords) {
    if (lowerMessage.includes(keyword)) {
      signals.push({
        signal_type: 'asked_about_price',
        driver: 'price',
        strength: 80,
        detected_at: now,
        context: `Detected price keyword: "${keyword}"`
      });
    }
  }

  return signals;
}

/**
 * Build value perception profile from historical signals
 */
export async function buildValueProfile(
  authToken?: string
): Promise<ValuePerceptionProfile> {
  const now = new Date().toISOString();

  // Initialize with balanced defaults
  let profile: ValuePerceptionProfile = {
    outcome_focus: 25,
    experience_focus: 25,
    efficiency_focus: 25,
    price_sensitivity: 25,
    primary_driver: 'outcome',
    confidence: 30,
    last_updated: now
  };

  try {
    let supabase: SupabaseClient | null;
    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
    } else {
      return profile;
    }

    if (!supabase) return profile;

    // Fetch value signals from history
    const { data: valueSignals } = await supabase
      .from('value_signals')
      .select('*')
      .gte('detected_at', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()) // Last 60 days
      .order('detected_at', { ascending: false })
      .limit(100);

    if (valueSignals && valueSignals.length >= 3) {
      // Calculate driver scores
      const driverScores = { outcome: 0, experience: 0, efficiency: 0, price: 0 };
      let totalWeight = 0;

      for (const signal of valueSignals) {
        const driver = signal.driver as ValueDriver;
        const strength = signal.strength || 50;
        driverScores[driver] = (driverScores[driver] || 0) + strength;
        totalWeight += strength;
      }

      // Normalize to percentages
      if (totalWeight > 0) {
        profile.outcome_focus = Math.round((driverScores.outcome / totalWeight) * 100);
        profile.experience_focus = Math.round((driverScores.experience / totalWeight) * 100);
        profile.efficiency_focus = Math.round((driverScores.efficiency / totalWeight) * 100);
        profile.price_sensitivity = Math.round((driverScores.price / totalWeight) * 100);

        // Find primary driver
        const drivers: [ValueDriver, number][] = [
          ['outcome', profile.outcome_focus],
          ['experience', profile.experience_focus],
          ['efficiency', profile.efficiency_focus],
          ['price', profile.price_sensitivity]
        ];
        drivers.sort((a, b) => b[1] - a[1]);
        profile.primary_driver = drivers[0][0];

        // Calculate confidence based on signal count
        profile.confidence = Math.min(90, 30 + valueSignals.length);
      }
    }

    return profile;

  } catch (error) {
    console.error(`${LOG_PREFIX} Error building value profile:`, error);
    return profile;
  }
}

// =============================================================================
// Monetization Gating
// =============================================================================

/**
 * Run all gating checks for monetization
 */
export function runGatingChecks(
  readiness: MonetizationReadiness,
  sensitivity: FinancialSensitivityInference,
  emotionalContext?: any
): GatingCheckResult {
  const checks: GatingCheck[] = [];
  const threshold = sensitivity.level === 'high' ? 0.7 : DEFAULT_READINESS_THRESHOLD;

  // Check 1: Readiness threshold
  const readinessCheck: GatingCheck = {
    check_type: 'readiness_threshold',
    passed: readiness.score >= threshold,
    threshold,
    actual_value: readiness.score,
    reason: readiness.score >= threshold
      ? 'Readiness score meets threshold'
      : `Readiness ${Math.round(readiness.score * 100)}% below threshold ${Math.round(threshold * 100)}%`
  };
  checks.push(readinessCheck);

  // Check 2: Trust positive
  const trustCheck: GatingCheck = {
    check_type: 'trust_positive',
    passed: readiness.components.trust_component >= 0.4,
    threshold: 0.4,
    actual_value: readiness.components.trust_component,
    reason: readiness.components.trust_component >= 0.4
      ? 'Trust context is positive'
      : 'Trust context is too low'
  };
  checks.push(trustCheck);

  // Check 3: No emotional vulnerability
  const hasEmotionalBlocker = readiness.blockers.some(
    b => b.blocker_type === 'emotional_vulnerability' && b.severity === 'hard'
  );
  const emotionalCheck: GatingCheck = {
    check_type: 'no_emotional_vulnerability',
    passed: !hasEmotionalBlocker,
    reason: hasEmotionalBlocker
      ? 'User shows emotional vulnerability'
      : 'No emotional vulnerability detected'
  };
  checks.push(emotionalCheck);

  // Check 4: No explicit refusal
  const hasRefusal = readiness.blockers.some(
    b => b.blocker_type === 'explicit_refusal'
  );
  const refusalCheck: GatingCheck = {
    check_type: 'no_explicit_refusal',
    passed: !hasRefusal,
    reason: hasRefusal
      ? 'User explicitly refused monetization'
      : 'No explicit refusal'
  };
  checks.push(refusalCheck);

  // Check 5: Cooldown clear
  const hasCooldown = readiness.blockers.some(
    b => b.blocker_type === 'cooldown_active' || b.blocker_type === 'recent_rejection'
  );
  const cooldownCheck: GatingCheck = {
    check_type: 'cooldown_clear',
    passed: !hasCooldown,
    reason: hasCooldown
      ? 'Monetization cooldown is active'
      : 'No cooldown active'
  };
  checks.push(cooldownCheck);

  // Find blocking check
  const blockingCheck = checks.find(c => !c.passed);

  return {
    passed: checks.every(c => c.passed),
    checks,
    blocking_check: blockingCheck,
    computed_at: new Date().toISOString()
  };
}

// =============================================================================
// Monetization Envelope Generation
// =============================================================================

/**
 * Generate monetization envelope based on all context
 */
export function generateMonetizationEnvelope(
  gating: GatingCheckResult,
  sensitivity: FinancialSensitivityInference,
  valueProfile: ValuePerceptionProfile,
  readiness: MonetizationReadiness
): MonetizationEnvelope {
  const now = new Date();
  const validUntil = new Date(now.getTime() + ENVELOPE_VALIDITY_MINUTES * 60 * 1000);

  // Determine tags
  const tags: MonetizationTag[] = [];

  if (!gating.passed) {
    tags.push('no_monetization_now');

    if (readiness.blockers.some(b => b.blocker_type === 'emotional_vulnerability')) {
      tags.push('free_only');
    }

    if (readiness.blockers.some(b => b.blocker_type === 'cooldown_active' || b.blocker_type === 'recent_rejection')) {
      tags.push('cooldown_active');
    }

    return {
      allow_paid: false,
      allowed_types: [],
      framing_style: 'value_first',
      confidence: readiness.confidence,
      tags,
      valid_until: validUntil.toISOString(),
      reason: gating.blocking_check?.reason || 'Gating check failed'
    };
  }

  // Paid suggestions allowed
  if (sensitivity.level === 'high') {
    tags.push('value_first_explain');
  } else if (sensitivity.level === 'medium') {
    tags.push('soft_paid_ok');
  }

  // Determine allowed types based on readiness
  const allowedTypes: MonetizationType[] = [];
  if (readiness.score >= 0.8) {
    allowedTypes.push('product', 'service', 'session', 'subscription');
  } else if (readiness.score >= 0.6) {
    allowedTypes.push('product', 'service', 'session');
  } else {
    allowedTypes.push('product', 'service');
  }

  // Determine framing style based on value profile
  let framingStyle: FramingStyle = 'value_first';
  switch (valueProfile.primary_driver) {
    case 'outcome':
      framingStyle = 'outcome_focused';
      break;
    case 'experience':
      framingStyle = 'experience_focused';
      break;
    case 'efficiency':
      framingStyle = 'efficiency_focused';
      break;
    case 'price':
      framingStyle = 'price_transparent';
      break;
  }

  // Override to value_first if sensitivity is high
  if (sensitivity.level === 'high') {
    framingStyle = 'value_first';
  }

  return {
    allow_paid: true,
    allowed_types: allowedTypes,
    framing_style: framingStyle,
    confidence: Math.min(readiness.confidence, valueProfile.confidence),
    tags,
    valid_until: validUntil.toISOString()
  };
}

// =============================================================================
// Main API Functions
// =============================================================================

/**
 * Compute full monetization context
 */
export async function computeMonetizationContext(
  currentMessage?: string,
  sessionId?: string,
  authToken?: string
): Promise<ComputeMonetizationContextResponse> {
  const startTime = Date.now();

  try {
    // Process current message for signals if provided
    if (currentMessage) {
      const financialSignals = detectFinancialSignals(currentMessage);
      const valueSignals = detectValueSignals(currentMessage);

      // Store signals if we have auth
      if ((financialSignals.length > 0 || valueSignals.length > 0) && authToken) {
        await recordSignalsToDatabase(financialSignals, valueSignals, sessionId, authToken);
      }
    }

    // Get all context
    const [sensitivity, readiness, valueProfile] = await Promise.all([
      inferFinancialSensitivity(authToken),
      computeMonetizationReadiness(authToken, sessionId),
      buildValueProfile(authToken)
    ]);

    // Run gating checks
    const gating = runGatingChecks(readiness, sensitivity);

    // Generate envelope
    const envelope = generateMonetizationEnvelope(gating, sensitivity, valueProfile, readiness);

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd36.monetization.context.computed',
      source: 'gateway-d36',
      status: 'success',
      message: `Monetization context computed: ${envelope.allow_paid ? 'ALLOWED' : 'BLOCKED'}`,
      payload: {
        session_id: sessionId,
        allow_paid: envelope.allow_paid,
        sensitivity: sensitivity.level,
        readiness_score: readiness.score,
        primary_value_driver: valueProfile.primary_driver,
        blockers_count: readiness.blockers.length,
        duration_ms: Date.now() - startTime
      }
    }).catch(() => {});

    console.log(`${LOG_PREFIX} Context computed in ${Date.now() - startTime}ms: allow_paid=${envelope.allow_paid}`);

    return {
      ok: true,
      financial_sensitivity: sensitivity,
      readiness,
      value_profile: valueProfile,
      envelope,
      gating
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing context:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd36.monetization.context.failed',
      source: 'gateway-d36',
      status: 'error',
      message: `Failed to compute monetization context: ${errorMessage}`,
      payload: { error: errorMessage }
    }).catch(() => {});

    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Record signals to database
 */
async function recordSignalsToDatabase(
  financialSignals: FinancialSignal[],
  valueSignals: ValueSignal[],
  sessionId?: string,
  authToken?: string
): Promise<void> {
  let supabase: SupabaseClient | null;

  if (authToken) {
    supabase = createUserClient(authToken);
  } else if (isDevSandbox()) {
    supabase = createServiceClient();
  } else {
    return;
  }

  if (!supabase) return;

  try {
    // Record financial signals
    if (financialSignals.length > 0) {
      const financialRecords = financialSignals.map(s => ({
        signal_type: s.signal_type,
        indicator: s.indicator,
        weight: s.weight,
        detected_at: s.detected_at,
        context: s.context,
        session_id: sessionId
      }));

      await supabase.from('monetization_signals').insert(financialRecords);
    }

    // Record value signals
    if (valueSignals.length > 0) {
      const valueRecords = valueSignals.map(s => ({
        signal_type: s.signal_type,
        driver: s.driver,
        strength: s.strength,
        detected_at: s.detected_at,
        context: s.context,
        session_id: sessionId
      }));

      await supabase.from('value_signals').insert(valueRecords);
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to record signals:`, error);
  }
}

/**
 * Record a monetization signal
 */
export async function recordSignal(
  signalType: FinancialSignalType | ValueSignalType,
  indicator: 'positive' | 'negative' | 'neutral' = 'neutral',
  context?: string,
  sessionId?: string,
  authToken?: string
): Promise<RecordSignalResponse> {
  try {
    let supabase: SupabaseClient | null;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
    } else {
      return { ok: false, error: 'UNAUTHENTICATED' };
    }

    if (!supabase) {
      return { ok: false, error: 'SERVICE_UNAVAILABLE' };
    }

    const now = new Date().toISOString();

    // Determine if this is a financial or value signal
    const isFinancialSignal = [
      'paid_suggestion_accepted', 'paid_suggestion_rejected', 'paid_suggestion_deferred',
      'free_alternative_preference', 'budget_language_detected', 'price_inquiry',
      'value_question', 'payment_completed', 'payment_abandoned',
      'subscription_interest', 'one_time_preference'
    ].includes(signalType);

    if (isFinancialSignal) {
      const { data, error } = await supabase
        .from('monetization_signals')
        .insert({
          signal_type: signalType,
          indicator,
          weight: indicator === 'negative' ? 80 : indicator === 'positive' ? 70 : 50,
          detected_at: now,
          context,
          session_id: sessionId
        })
        .select('id')
        .single();

      if (error) {
        return { ok: false, error: error.message };
      }

      return { ok: true, signal_id: data?.id };
    } else {
      // Value signal
      const driver = signalType.includes('result') ? 'outcome' :
                    signalType.includes('experience') ? 'experience' :
                    signalType.includes('time') ? 'efficiency' : 'price';

      const { data, error } = await supabase
        .from('value_signals')
        .insert({
          signal_type: signalType,
          driver,
          strength: 70,
          detected_at: now,
          context,
          session_id: sessionId
        })
        .select('id')
        .single();

      if (error) {
        return { ok: false, error: error.message };
      }

      return { ok: true, signal_id: data?.id };
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

/**
 * Record a monetization attempt outcome
 */
export async function recordAttempt(
  attemptType: MonetizationType,
  outcome: MonetizationOutcome,
  userResponse?: string,
  sessionId?: string,
  authToken?: string
): Promise<RecordAttemptResponse> {
  try {
    let supabase: SupabaseClient | null;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
    } else {
      return { ok: false, error: 'UNAUTHENTICATED' };
    }

    if (!supabase) {
      return { ok: false, error: 'SERVICE_UNAVAILABLE' };
    }

    // Get current envelope for context
    const context = await computeMonetizationContext(undefined, sessionId, authToken);

    const { data, error } = await supabase
      .from('monetization_attempts')
      .insert({
        attempt_type: attemptType,
        outcome,
        readiness_score_at_attempt: context.readiness?.score || 0,
        envelope_at_attempt: context.envelope,
        user_response: userResponse,
        session_id: sessionId,
        created_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (error) {
      return { ok: false, error: error.message };
    }

    // Check if cooldown triggered
    const cooldownTriggered = outcome === 'rejected';
    const cooldownUntil = cooldownTriggered
      ? new Date(Date.now() + REJECTION_COOLDOWN_MINUTES * 60 * 1000).toISOString()
      : undefined;

    // Emit event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd36.monetization.attempt.recorded',
      source: 'gateway-d36',
      status: outcome === 'accepted' ? 'success' : 'info',
      message: `Monetization attempt recorded: ${attemptType} → ${outcome}`,
      payload: {
        attempt_id: data?.id,
        attempt_type: attemptType,
        outcome,
        session_id: sessionId,
        cooldown_triggered: cooldownTriggered
      }
    }).catch(() => {});

    return {
      ok: true,
      attempt_id: data?.id,
      cooldown_triggered: cooldownTriggered,
      cooldown_until: cooldownUntil
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get current monetization envelope
 */
export async function getMonetizationEnvelope(
  sessionId?: string,
  productType?: MonetizationType,
  forceRecompute?: boolean,
  authToken?: string
): Promise<GetEnvelopeResponse> {
  // For now, always compute fresh (caching can be added later)
  const context = await computeMonetizationContext(undefined, sessionId, authToken);

  if (!context.ok) {
    return { ok: false, error: context.error };
  }

  return {
    ok: true,
    envelope: context.envelope,
    cached: false,
    expires_at: context.envelope?.valid_until
  };
}

/**
 * Get monetization history
 */
export async function getMonetizationHistory(
  limit: number = 20,
  authToken?: string
): Promise<GetHistoryResponse> {
  try {
    let supabase: SupabaseClient | null;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
    } else {
      return { ok: false, error: 'UNAUTHENTICATED' };
    }

    if (!supabase) {
      return { ok: false, error: 'SERVICE_UNAVAILABLE' };
    }

    const { data, error, count } = await supabase
      .from('monetization_attempts')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return { ok: false, error: error.message };
    }

    const attempts = data || [];
    const acceptances = attempts.filter(a => a.outcome === 'accepted').length;
    const acceptanceRate = attempts.length > 0 ? acceptances / attempts.length : 0;

    return {
      ok: true,
      attempts,
      total_count: count || attempts.length,
      acceptance_rate: acceptanceRate
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

// =============================================================================
// ORB Integration Functions
// =============================================================================

/**
 * Get monetization context for ORB system prompt injection
 */
export async function getOrbMonetizationContext(
  sessionId?: string,
  authToken?: string
): Promise<{ context: string; orbContext: OrbMonetizationContext } | null> {
  try {
    const result = await computeMonetizationContext(undefined, sessionId, authToken);

    if (!result.ok || !result.envelope || !result.financial_sensitivity || !result.readiness || !result.value_profile) {
      return null;
    }

    const orbContext = toOrbMonetizationContext(
      result.financial_sensitivity,
      result.readiness,
      result.value_profile,
      result.envelope
    );

    const context = formatMonetizationContextForPrompt(orbContext);

    return { context, orbContext };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error getting ORB context:`, error);
    return null;
  }
}

/**
 * Process a user message and compute monetization context
 */
export async function processMessageForOrb(
  message: string,
  sessionId?: string,
  authToken?: string
): Promise<{ context: string; orbContext: OrbMonetizationContext } | null> {
  try {
    const result = await computeMonetizationContext(message, sessionId, authToken);

    if (!result.ok || !result.envelope || !result.financial_sensitivity || !result.readiness || !result.value_profile) {
      return null;
    }

    const orbContext = toOrbMonetizationContext(
      result.financial_sensitivity,
      result.readiness,
      result.value_profile,
      result.envelope
    );

    const context = formatMonetizationContextForPrompt(orbContext);

    return { context, orbContext };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error processing message:`, error);
    return null;
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  toOrbMonetizationContext,
  formatMonetizationContextForPrompt
};

export type {
  FinancialSensitivity,
  FinancialSensitivityInference,
  MonetizationReadiness,
  ValuePerceptionProfile,
  MonetizationEnvelope,
  MonetizationType,
  MonetizationOutcome,
  OrbMonetizationContext
};
