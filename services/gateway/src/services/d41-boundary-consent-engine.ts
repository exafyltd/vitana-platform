/**
 * VTID-01135: D41 - Ethical Boundaries, Personal Limits & Consent Sensitivity Engine
 *
 * Deterministic engine that ensures the system NEVER crosses personal, ethical,
 * or psychological boundaries, even when deeper context and personalization are available.
 *
 * Core Principle: Even if something is relevant, it must be appropriate and permitted.
 *
 * Hard Constraints (Non-Negotiable):
 *   - Never infer sensitive traits without explicit consent
 *   - Never escalate intimacy or depth automatically
 *   - Silence is NOT consent
 *   - Emotional vulnerability suppresses monetization
 *   - Respect cultural and personal norms implicitly
 *   - Default to protection when uncertain
 *   - Boundaries override optimization goals
 *
 * Determinism Rules:
 *   - Same inputs -> same boundary check output
 *   - No probabilistic/generative interpretation
 *   - Rule-based enforcement only
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import { CicdEventType } from '../types/cicd';
import {
  PersonalBoundaries,
  ConsentState,
  ConsentBundle,
  ConsentStatus,
  ConsentTopic,
  BoundaryCheckInput,
  BoundaryCheckResult,
  SafeAction,
  BoundaryType,
  BoundaryDomain,
  VulnerabilityIndicators,
  OrbBoundaryContext,
  SetBoundaryRequest,
  SetConsentRequest,
  RevokeConsentRequest,
  FilterActionsRequest,
  GetBoundariesResponse,
  SetBoundaryResponse,
  GetConsentResponse,
  SetConsentResponse,
  RevokeConsentResponse,
  CheckBoundaryResponse,
  FilterActionsResponse,
  VulnerabilityCheckResponse,
  DEFAULT_BOUNDARIES,
  DEFAULT_CONSENT_STATUS,
  CONSENT_EXPIRY_DEFAULTS,
  VULNERABILITY_THRESHOLDS,
  BOUNDARY_CHECK_TIMEOUT_MS,
  D41_HARD_CONSTRAINTS,
  toOrbBoundaryContext,
  formatBoundaryContextForPrompt
} from '../types/boundary-consent';

// =============================================================================
// Constants
// =============================================================================

const VTID = 'VTID-01135';
const LOG_PREFIX = '[D41-Engine]';

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

async function getSupabaseClient(authToken?: string): Promise<{ client: SupabaseClient | null; useDevIdentity: boolean }> {
  if (authToken) {
    return { client: createUserClient(authToken), useDevIdentity: false };
  } else if (isDevSandbox()) {
    return { client: createServiceClient(), useDevIdentity: true };
  }
  return { client: null, useDevIdentity: false };
}

async function bootstrapDevContext(supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.rpc('dev_bootstrap_request_context', {
    p_tenant_id: DEV_IDENTITY.TENANT_ID,
    p_active_role: 'developer'
  });
  if (error) {
    console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, error.message);
  }
}

// =============================================================================
// D41 Core Functions - Personal Boundaries
// =============================================================================

/**
 * Get personal boundaries for the current user
 */
export async function getPersonalBoundaries(
  authToken?: string
): Promise<GetBoundariesResponse> {
  try {
    const { client: supabase, useDevIdentity } = await getSupabaseClient(authToken);

    if (!supabase) {
      // Return defaults if no database connection
      return {
        ok: true,
        boundaries: DEFAULT_BOUNDARIES
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    const result = await supabase.rpc('d41_get_personal_boundaries');

    if (result.error) {
      console.warn(`${LOG_PREFIX} RPC error (get_boundaries):`, result.error.message);
      // Return defaults on error
      return {
        ok: true,
        boundaries: DEFAULT_BOUNDARIES
      };
    }

    const data = result.data;
    if (!data) {
      return {
        ok: true,
        boundaries: DEFAULT_BOUNDARIES
      };
    }

    return {
      ok: true,
      boundaries: data as PersonalBoundaries
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting boundaries:`, errorMessage);
    return {
      ok: true,
      boundaries: DEFAULT_BOUNDARIES
    };
  }
}

/**
 * Set a personal boundary
 */
export async function setPersonalBoundary(
  request: SetBoundaryRequest,
  authToken?: string
): Promise<SetBoundaryResponse> {
  const startTime = Date.now();

  try {
    const { client: supabase, useDevIdentity } = await getSupabaseClient(authToken);

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    const result = await supabase.rpc('d41_set_personal_boundary', {
      p_boundary_type: request.boundary_type,
      p_value: request.value,
      p_reason: request.reason || null
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (set_boundary):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR'
      };
    }

    const response = result.data as SetBoundaryResponse;

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd41.boundary.set',
      source: 'gateway-d41',
      status: 'success',
      message: `Boundary ${request.boundary_type} set to ${request.value}`,
      payload: {
        boundary_type: request.boundary_type,
        old_value: response.old_value,
        new_value: request.value,
        duration_ms: Date.now() - startTime
      }
    });

    console.log(`${LOG_PREFIX} Boundary set: ${request.boundary_type}=${request.value}`);

    return {
      ok: true,
      boundary_type: request.boundary_type,
      old_value: response.old_value,
      new_value: request.value,
      action: response.action
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error setting boundary:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR'
    };
  }
}

// =============================================================================
// D41 Core Functions - Consent Management
// =============================================================================

/**
 * Get consent bundle for the current user
 */
export async function getConsentBundle(
  authToken?: string
): Promise<GetConsentResponse> {
  try {
    const { client: supabase, useDevIdentity } = await getSupabaseClient(authToken);

    if (!supabase) {
      // Return empty consent bundle if no database
      const emptyBundle: ConsentBundle = {
        consent_states: [],
        default_stance: 'protective',
        consent_count: 0,
        granted_count: 0,
        denied_count: 0,
        generated_at: new Date().toISOString()
      };
      return {
        ok: true,
        consent_bundle: emptyBundle
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    const result = await supabase.rpc('d41_get_consent_bundle');

    if (result.error) {
      console.warn(`${LOG_PREFIX} RPC error (get_consent):`, result.error.message);
      return {
        ok: true,
        consent_bundle: {
          consent_states: [],
          default_stance: 'protective',
          consent_count: 0,
          granted_count: 0,
          denied_count: 0,
          generated_at: new Date().toISOString()
        }
      };
    }

    return {
      ok: true,
      consent_bundle: result.data as ConsentBundle
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting consent:`, errorMessage);
    return {
      ok: true,
      consent_bundle: {
        consent_states: [],
        default_stance: 'protective',
        consent_count: 0,
        granted_count: 0,
        denied_count: 0,
        generated_at: new Date().toISOString()
      }
    };
  }
}

/**
 * Set consent for a topic
 */
export async function setConsent(
  request: SetConsentRequest,
  authToken?: string
): Promise<SetConsentResponse> {
  const startTime = Date.now();

  try {
    const { client: supabase, useDevIdentity } = await getSupabaseClient(authToken);

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    // Calculate expiry time if provided
    let expiresAt: string | null = null;
    if (request.expires_in_hours && request.expires_in_hours > 0) {
      const expiry = new Date();
      expiry.setHours(expiry.getHours() + request.expires_in_hours);
      expiresAt = expiry.toISOString();
    } else if (request.status === 'granted') {
      // Default expiry for granted consent
      const defaultHours = CONSENT_EXPIRY_DEFAULTS.granted;
      if (defaultHours) {
        const expiry = new Date();
        expiry.setHours(expiry.getHours() + defaultHours);
        expiresAt = expiry.toISOString();
      }
    } else if (request.status === 'soft_refusal') {
      // Soft refusals expire after default period
      const defaultHours = CONSENT_EXPIRY_DEFAULTS.soft_refusal;
      if (defaultHours) {
        const expiry = new Date();
        expiry.setHours(expiry.getHours() + defaultHours);
        expiresAt = expiry.toISOString();
      }
    }

    const result = await supabase.rpc('d41_set_consent', {
      p_topic: request.topic,
      p_status: request.status,
      p_expires_at: expiresAt,
      p_reason: request.reason || null
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (set_consent):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR'
      };
    }

    const response = result.data as SetConsentResponse;

    // Determine event type based on status
    let eventType: CicdEventType;
    switch (request.status) {
      case 'granted':
        eventType = 'd41.consent.granted';
        break;
      case 'denied':
        eventType = 'd41.consent.denied';
        break;
      case 'revoked':
        eventType = 'd41.consent.revoked';
        break;
      default:
        eventType = 'd41.consent.updated';
    }

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: eventType,
      source: 'gateway-d41',
      status: 'success',
      message: `Consent ${request.status} for topic ${request.topic}`,
      payload: {
        topic: request.topic,
        status: request.status,
        expires_at: expiresAt,
        duration_ms: Date.now() - startTime
      }
    });

    console.log(`${LOG_PREFIX} Consent set: ${request.topic}=${request.status}`);

    return {
      ok: true,
      id: response.id,
      topic: request.topic,
      status: request.status,
      expires_at: expiresAt || undefined,
      action: response.action
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error setting consent:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR'
    };
  }
}

/**
 * Revoke consent for a topic
 */
export async function revokeConsent(
  request: RevokeConsentRequest,
  authToken?: string
): Promise<RevokeConsentResponse> {
  const startTime = Date.now();

  try {
    const { client: supabase, useDevIdentity } = await getSupabaseClient(authToken);

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    const result = await supabase.rpc('d41_revoke_consent', {
      p_topic: request.topic,
      p_reason: request.reason || null
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (revoke_consent):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR'
      };
    }

    const response = result.data as RevokeConsentResponse;

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd41.consent.revoked',
      source: 'gateway-d41',
      status: 'success',
      message: `Consent revoked for topic ${request.topic}`,
      payload: {
        topic: request.topic,
        previous_status: response.previous_status,
        duration_ms: Date.now() - startTime
      }
    });

    console.log(`${LOG_PREFIX} Consent revoked: ${request.topic}`);

    return {
      ok: true,
      id: response.id,
      topic: request.topic,
      previous_status: response.previous_status
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error revoking consent:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR'
    };
  }
}

/**
 * Check if consent is granted for a specific topic
 */
export async function checkConsent(
  topic: ConsentTopic,
  authToken?: string
): Promise<{ granted: boolean; status: ConsentStatus; confidence: number }> {
  const consentResult = await getConsentBundle(authToken);

  if (!consentResult.ok || !consentResult.consent_bundle) {
    // Default to not granted (protective stance)
    return { granted: false, status: 'unknown', confidence: 0 };
  }

  const consentState = consentResult.consent_bundle.consent_states.find(
    c => c.topic === topic
  );

  if (!consentState) {
    // No record = unknown = not granted (silence is not consent)
    return { granted: false, status: 'unknown', confidence: 0 };
  }

  // Check if expired
  if (consentState.expires_at) {
    const expiry = new Date(consentState.expires_at);
    if (expiry < new Date()) {
      return { granted: false, status: 'expired', confidence: consentState.confidence };
    }
  }

  const granted = consentState.status === 'granted';
  return {
    granted,
    status: consentState.status,
    confidence: consentState.confidence
  };
}

// =============================================================================
// D41 Core Functions - Boundary Checking
// =============================================================================

/**
 * Check boundaries for a proposed action
 * This is the main enforcement point for D41
 */
export async function checkBoundary(
  input: BoundaryCheckInput,
  authToken?: string
): Promise<CheckBoundaryResponse> {
  const startTime = Date.now();
  const checkId = crypto.randomUUID();

  try {
    // Get current boundaries and consent
    const [boundariesResult, consentResult, vulnerabilityResult] = await Promise.all([
      getPersonalBoundaries(authToken),
      getConsentBundle(authToken),
      detectVulnerability(authToken)
    ]);

    const boundaries = boundariesResult.boundaries || DEFAULT_BOUNDARIES;
    const consentBundle = consentResult.consent_bundle || {
      consent_states: [],
      default_stance: 'protective',
      consent_count: 0,
      granted_count: 0,
      denied_count: 0,
      generated_at: new Date().toISOString()
    };
    const vulnerability = vulnerabilityResult.indicators || {
      emotional_vulnerability: false,
      emotional_vulnerability_score: 0,
      financial_pressure: false,
      financial_pressure_score: 0,
      social_isolation: false,
      social_isolation_score: 0,
      health_crisis: false,
      health_crisis_score: 0,
      overall_vulnerability: false,
      overall_vulnerability_score: 0,
      suppress_monetization: false,
      suppress_social_introductions: false,
      suppress_proactive_nudges: false,
      suppress_autonomy: false
    };

    // Evaluate boundary rules
    const result = evaluateBoundaryRules(input, boundaries, consentBundle, vulnerability);

    // Calculate duration
    const duration = Date.now() - startTime;

    // Build result
    const checkResult: BoundaryCheckResult = {
      check_id: checkId,
      request_id: input.request_id,
      allowed: result.allowed,
      boundary_type: result.boundaryType,
      primary_domain: result.primaryDomain,
      safe_actions: result.safeActions,
      triggered_boundaries: result.triggeredBoundaries,
      user_message: result.userMessage,
      user_explanation: result.userExplanation,
      confidence: result.confidence,
      checked_at: new Date().toISOString(),
      check_duration_ms: duration
    };

    // Emit OASIS event
    const eventType = result.allowed ? 'd41.action.allowed' :
      result.boundaryType === 'hard_boundary' ? 'd41.action.blocked' : 'd41.action.restricted';

    await emitOasisEvent({
      vtid: VTID,
      type: eventType,
      source: 'gateway-d41',
      status: result.allowed ? 'success' : 'info',
      message: result.allowed ?
        `Action ${input.action_type} allowed` :
        `Action ${input.action_type} ${result.boundaryType === 'hard_boundary' ? 'blocked' : 'restricted'}`,
      payload: {
        check_id: checkId,
        action_type: input.action_type,
        allowed: result.allowed,
        boundary_type: result.boundaryType,
        triggered_boundaries: result.triggeredBoundaries,
        duration_ms: duration
      }
    });

    console.log(`${LOG_PREFIX} Boundary check: ${input.action_type} -> ${result.allowed ? 'ALLOWED' : 'BLOCKED'} (${duration}ms)`);

    return {
      ok: true,
      result: checkResult
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error checking boundary:`, errorMessage);

    // Default to protective stance on error
    return {
      ok: true,
      result: {
        check_id: checkId,
        request_id: input.request_id,
        allowed: false,
        boundary_type: 'hard_boundary',
        safe_actions: [],
        triggered_boundaries: ['error_protection'],
        user_message: 'We encountered an issue and are defaulting to a protective stance.',
        confidence: 100,
        checked_at: new Date().toISOString(),
        check_duration_ms: Date.now() - startTime
      }
    };
  }
}

/**
 * Filter a set of proposed actions based on boundaries
 */
export async function filterActions(
  request: FilterActionsRequest,
  authToken?: string
): Promise<FilterActionsResponse> {
  try {
    const safeActions: SafeAction[] = [];
    let allowedCount = 0;
    let blockedCount = 0;

    for (const proposedAction of request.proposed_actions) {
      const checkInput: BoundaryCheckInput = {
        action_type: proposedAction.action_type as BoundaryCheckInput['action_type'],
        action_details: proposedAction.details,
        ...request.context
      };

      const checkResult = await checkBoundary(checkInput, authToken);

      if (checkResult.ok && checkResult.result) {
        safeActions.push({
          action: proposedAction.action,
          allowed: checkResult.result.allowed,
          reason: checkResult.result.user_explanation || 'Boundary check performed',
          confidence: checkResult.result.confidence,
          boundary_type: checkResult.result.boundary_type
        });

        if (checkResult.result.allowed) {
          allowedCount++;
        } else {
          blockedCount++;
        }
      } else {
        // Default to blocked on error
        safeActions.push({
          action: proposedAction.action,
          allowed: false,
          reason: 'Defaulting to protection due to check error',
          confidence: 100,
          boundary_type: 'hard_boundary'
        });
        blockedCount++;
      }
    }

    return {
      ok: true,
      safe_actions: safeActions,
      filtered_count: request.proposed_actions.length,
      allowed_count: allowedCount,
      blocked_count: blockedCount
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error filtering actions:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR'
    };
  }
}

// =============================================================================
// D41 Core Functions - Vulnerability Detection
// =============================================================================

/**
 * Detect vulnerability indicators from current signals
 * Integrates with D28 (emotional), D36 (financial), etc.
 */
export async function detectVulnerability(
  authToken?: string,
  emotionalSignals?: Record<string, unknown>,
  financialSignals?: Record<string, unknown>
): Promise<VulnerabilityCheckResponse> {
  try {
    // Extract emotional vulnerability from D28 signals
    let emotionalVulnerability = false;
    let emotionalScore = 0;
    if (emotionalSignals) {
      const stressIndicators = emotionalSignals.stress_indicators as boolean;
      const vulnerabilityIndicators = emotionalSignals.vulnerability_indicators as boolean;
      const emotionIntensity = (emotionalSignals.detected_emotions as Array<{ intensity: number }>)
        ?.reduce((max, e) => Math.max(max, e.intensity || 0), 0) || 0;

      emotionalScore = Math.min(100, Math.round(
        (stressIndicators ? 30 : 0) +
        (vulnerabilityIndicators ? 40 : 0) +
        (emotionIntensity * 30)
      ));
      emotionalVulnerability = emotionalScore >= VULNERABILITY_THRESHOLDS.EMOTIONAL_MODERATE;
    }

    // Extract financial pressure from D36 signals
    let financialPressure = false;
    let financialScore = 0;
    if (financialSignals) {
      financialScore = (financialSignals.pressure_score as number) || 0;
      financialPressure = financialScore >= VULNERABILITY_THRESHOLDS.FINANCIAL_MODERATE;
    }

    // Social isolation (could be from D28 or context)
    const socialIsolation = false;
    const socialScore = 0;

    // Health crisis (could be from health domain)
    const healthCrisis = false;
    const healthScore = 0;

    // Calculate overall vulnerability
    const overallScore = Math.round(
      (emotionalScore * 0.4) +
      (financialScore * 0.3) +
      (socialScore * 0.2) +
      (healthScore * 0.1)
    );
    const overallVulnerability = overallScore >= VULNERABILITY_THRESHOLDS.OVERALL_MODERATE;

    // Determine suppressions based on vulnerability
    const suppressMonetization =
      emotionalVulnerability ||
      financialPressure ||
      overallVulnerability;

    const suppressSocial =
      emotionalScore >= VULNERABILITY_THRESHOLDS.EMOTIONAL_HIGH ||
      socialScore >= VULNERABILITY_THRESHOLDS.SOCIAL_HIGH;

    const suppressProactive =
      emotionalScore >= VULNERABILITY_THRESHOLDS.EMOTIONAL_HIGH ||
      overallScore >= VULNERABILITY_THRESHOLDS.OVERALL_HIGH;

    const suppressAutonomy =
      overallScore >= VULNERABILITY_THRESHOLDS.OVERALL_HIGH;

    const indicators: VulnerabilityIndicators = {
      emotional_vulnerability: emotionalVulnerability,
      emotional_vulnerability_score: emotionalScore,
      financial_pressure: financialPressure,
      financial_pressure_score: financialScore,
      social_isolation: socialIsolation,
      social_isolation_score: socialScore,
      health_crisis: healthCrisis,
      health_crisis_score: healthScore,
      overall_vulnerability: overallVulnerability,
      overall_vulnerability_score: overallScore,
      suppress_monetization: suppressMonetization,
      suppress_social_introductions: suppressSocial,
      suppress_proactive_nudges: suppressProactive,
      suppress_autonomy: suppressAutonomy,
      detected_at: new Date().toISOString()
    };

    // Emit OASIS event if vulnerability detected
    if (overallVulnerability) {
      await emitOasisEvent({
        vtid: VTID,
        type: 'd41.vulnerability.detected',
        source: 'gateway-d41',
        status: 'info',
        message: 'Vulnerability indicators detected, activating protections',
        payload: {
          overall_score: overallScore,
          emotional_score: emotionalScore,
          financial_score: financialScore,
          suppressions: {
            monetization: suppressMonetization,
            social: suppressSocial,
            proactive: suppressProactive,
            autonomy: suppressAutonomy
          }
        }
      });
    }

    return {
      ok: true,
      indicators
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error detecting vulnerability:`, errorMessage);
    // Return safe defaults
    return {
      ok: true,
      indicators: {
        emotional_vulnerability: false,
        emotional_vulnerability_score: 0,
        financial_pressure: false,
        financial_pressure_score: 0,
        social_isolation: false,
        social_isolation_score: 0,
        health_crisis: false,
        health_crisis_score: 0,
        overall_vulnerability: false,
        overall_vulnerability_score: 0,
        suppress_monetization: false,
        suppress_social_introductions: false,
        suppress_proactive_nudges: false,
        suppress_autonomy: false
      }
    };
  }
}

// =============================================================================
// Internal Rule Evaluation
// =============================================================================

interface RuleEvaluationResult {
  allowed: boolean;
  boundaryType: BoundaryType;
  primaryDomain?: BoundaryDomain;
  safeActions: SafeAction[];
  triggeredBoundaries: string[];
  userMessage?: string;
  userExplanation?: string;
  confidence: number;
}

/**
 * Evaluate boundary rules against input
 * Deterministic: same inputs -> same output
 */
function evaluateBoundaryRules(
  input: BoundaryCheckInput,
  boundaries: PersonalBoundaries,
  consentBundle: ConsentBundle,
  vulnerability: VulnerabilityIndicators
): RuleEvaluationResult {
  const triggeredBoundaries: string[] = [];
  let boundaryType: BoundaryType = 'safe_to_proceed';
  let primaryDomain: BoundaryDomain | undefined;
  let userMessage: string | undefined;
  let userExplanation: string | undefined;
  let confidence = 100;

  // Rule 1: Emotional vulnerability suppresses monetization
  if (input.action_type === 'monetization' && vulnerability.suppress_monetization) {
    triggeredBoundaries.push('vulnerability_monetization_suppression');
    boundaryType = 'hard_boundary';
    primaryDomain = 'emotional';
    userExplanation = 'We noticed you might be going through a difficult time, so we are holding off on suggestions.';
    return {
      allowed: false,
      boundaryType,
      primaryDomain,
      safeActions: [],
      triggeredBoundaries,
      userMessage,
      userExplanation,
      confidence
    };
  }

  // Rule 2: Check explicit consent denial
  const actionTopicMap: Record<string, ConsentTopic[]> = {
    'health_guidance': ['health_general', 'health_mental', 'health_physical'],
    'social_introduction': ['social_introductions', 'social_contact_sharing'],
    'monetization': ['monetization_suggestions'],
    'proactive_nudge': ['proactive_nudges'],
    'memory_surfacing': ['memory_surfacing'],
    'autonomy_action': ['autonomy_actions'],
    'data_access': ['data_collection', 'data_sharing']
  };

  const relevantTopics = actionTopicMap[input.action_type] || [];
  for (const topic of relevantTopics) {
    const consentState = consentBundle.consent_states.find(c => c.topic === topic);
    if (consentState && (consentState.status === 'denied' || consentState.status === 'revoked')) {
      triggeredBoundaries.push(`consent_denied:${topic}`);
      boundaryType = 'topic_blocked';
      primaryDomain = 'privacy';
      userExplanation = `This topic has been marked as off-limits.`;
      return {
        allowed: false,
        boundaryType,
        primaryDomain,
        safeActions: [],
        triggeredBoundaries,
        userMessage,
        userExplanation,
        confidence: consentState.confidence
      };
    }
  }

  // Rule 3: Check monetization tolerance
  if (input.action_type === 'monetization') {
    if (boundaries.monetization_tolerance === 'none') {
      triggeredBoundaries.push('monetization_tolerance_none');
      boundaryType = 'hard_boundary';
      primaryDomain = 'financial';
      userExplanation = 'Monetization suggestions are disabled.';
      return {
        allowed: false,
        boundaryType,
        primaryDomain,
        safeActions: [],
        triggeredBoundaries,
        userMessage,
        userExplanation,
        confidence
      };
    }
    if (boundaries.monetization_tolerance === 'minimal') {
      triggeredBoundaries.push('monetization_tolerance_minimal');
      boundaryType = 'soft_boundary';
      primaryDomain = 'financial';
      userExplanation = 'Monetization suggestions are restricted to high-value opportunities only.';
      confidence = 70;
    }
  }

  // Rule 4: Check social exposure limits
  if (input.action_type === 'social_introduction') {
    if (boundaries.social_exposure_limit === 'none' || vulnerability.suppress_social_introductions) {
      triggeredBoundaries.push('social_exposure_none');
      boundaryType = 'hard_boundary';
      primaryDomain = 'social';
      userExplanation = 'Social introductions are currently disabled.';
      return {
        allowed: false,
        boundaryType,
        primaryDomain,
        safeActions: [],
        triggeredBoundaries,
        userMessage,
        userExplanation,
        confidence
      };
    }
    if (boundaries.social_exposure_limit === 'minimal') {
      triggeredBoundaries.push('social_exposure_minimal');
      boundaryType = 'soft_boundary';
      primaryDomain = 'social';
      userExplanation = 'Social suggestions are limited to familiar contexts.';
      confidence = 70;
    }
  }

  // Rule 5: Check proactive nudges
  if (input.action_type === 'proactive_nudge') {
    if (vulnerability.suppress_proactive_nudges) {
      triggeredBoundaries.push('proactive_suppressed_vulnerability');
      boundaryType = 'soft_boundary';
      primaryDomain = 'emotional';
      userExplanation = 'Proactive suggestions are temporarily reduced.';
      confidence = 80;
    }
  }

  // Rule 6: Check autonomy actions
  if (input.action_type === 'autonomy_action') {
    if (vulnerability.suppress_autonomy) {
      triggeredBoundaries.push('autonomy_suppressed_vulnerability');
      boundaryType = 'consent_required';
      primaryDomain = 'autonomy';
      userExplanation = 'Explicit confirmation is required for this action.';
      confidence = 90;
    }
  }

  // Rule 7: Check privacy level for health guidance
  if (input.action_type === 'health_guidance') {
    if (boundaries.health_sensitivity === 'restricted') {
      triggeredBoundaries.push('health_sensitivity_restricted');
      boundaryType = 'soft_boundary';
      primaryDomain = 'health';
      userExplanation = 'Health guidance is provided at a general level only.';
      confidence = 70;
    }
  }

  // Rule 8: Unknown consent = not granted (silence is not consent)
  for (const topic of relevantTopics) {
    const consentState = consentBundle.consent_states.find(c => c.topic === topic);
    if (!consentState || consentState.status === 'unknown') {
      // Only flag as requiring consent for sensitive actions
      if (['health_guidance', 'data_access', 'autonomy_action'].includes(input.action_type)) {
        triggeredBoundaries.push(`consent_unknown:${topic}`);
        if (boundaryType === 'safe_to_proceed') {
          boundaryType = 'consent_required';
          primaryDomain = 'privacy';
          userExplanation = 'This action requires your explicit consent.';
          confidence = 60;
        }
      }
    }
  }

  // If no boundaries triggered and no soft constraints, action is allowed
  const allowed = boundaryType === 'safe_to_proceed' ||
    (boundaryType === 'soft_boundary' && triggeredBoundaries.length > 0);

  return {
    allowed,
    boundaryType,
    primaryDomain,
    safeActions: allowed ? [{
      action: input.action_type,
      allowed: true,
      reason: 'Within acceptable boundaries',
      confidence
    }] : [],
    triggeredBoundaries,
    userMessage,
    userExplanation,
    confidence
  };
}

// =============================================================================
// ORB Integration Functions
// =============================================================================

/**
 * Get boundary context for ORB system prompt injection
 */
export async function getOrbBoundaryContext(
  authToken?: string,
  emotionalSignals?: Record<string, unknown>,
  financialSignals?: Record<string, unknown>
): Promise<{ context: string; orbContext: OrbBoundaryContext } | null> {
  try {
    const [boundariesResult, consentResult, vulnerabilityResult] = await Promise.all([
      getPersonalBoundaries(authToken),
      getConsentBundle(authToken),
      detectVulnerability(authToken, emotionalSignals, financialSignals)
    ]);

    const boundaries = boundariesResult.boundaries || DEFAULT_BOUNDARIES;
    const consentBundle = consentResult.consent_bundle || {
      consent_states: [],
      default_stance: 'protective',
      consent_count: 0,
      granted_count: 0,
      denied_count: 0,
      generated_at: new Date().toISOString()
    };
    const vulnerability = vulnerabilityResult.indicators || {
      emotional_vulnerability: false,
      emotional_vulnerability_score: 0,
      financial_pressure: false,
      financial_pressure_score: 0,
      social_isolation: false,
      social_isolation_score: 0,
      health_crisis: false,
      health_crisis_score: 0,
      overall_vulnerability: false,
      overall_vulnerability_score: 0,
      suppress_monetization: false,
      suppress_social_introductions: false,
      suppress_proactive_nudges: false,
      suppress_autonomy: false
    };

    const orbContext = toOrbBoundaryContext(boundaries, consentBundle, vulnerability);
    const context = formatBoundaryContextForPrompt(orbContext);

    return { context, orbContext };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error getting ORB boundary context:`, error);
    return null;
  }
}

/**
 * Quick check if an action type is allowed (for use in other modules)
 */
export async function isActionAllowed(
  actionType: BoundaryCheckInput['action_type'],
  authToken?: string
): Promise<boolean> {
  const result = await checkBoundary({ action_type: actionType }, authToken);
  return result.ok && result.result?.allowed === true;
}

// =============================================================================
// Exports
// =============================================================================

export {
  toOrbBoundaryContext,
  formatBoundaryContextForPrompt
};

export type {
  PersonalBoundaries,
  ConsentState,
  ConsentBundle,
  ConsentStatus,
  ConsentTopic,
  BoundaryCheckInput,
  BoundaryCheckResult,
  SafeAction,
  BoundaryType,
  BoundaryDomain,
  VulnerabilityIndicators,
  OrbBoundaryContext
};
