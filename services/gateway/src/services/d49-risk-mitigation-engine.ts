/**
 * VTID-01143: D49 Proactive Health & Lifestyle Risk Mitigation Layer
 *
 * Core Intelligence Engine that translates risk windows (D45) and early signals (D44)
 * into low-friction mitigation suggestions that reduce downside before harm occurs.
 *
 * D49 answers: "What small, safe adjustment could lower risk right now?"
 *
 * HARD GOVERNANCE (NON-NEGOTIABLE):
 *   - Safety > optimization
 *   - No diagnosis, no treatment
 *   - No medical claims
 *   - Suggestions only, never actions
 *   - Explainability mandatory
 *   - All outputs logged to OASIS
 *
 * Mitigation Rules (from spec):
 *   - Risk confidence >= 75%
 *   - Action must be: low effort, reversible, non-invasive
 *   - Must have precedent in user history OR general safety consensus
 *   - No similar mitigation shown in last 14 days
 *
 * Determinism Rules:
 *   - Same risk inputs → same mitigation suggestions
 *   - Rule-based generation, no generative inference
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  MitigationDomain,
  EffortLevel,
  MitigationStatus,
  RiskWindowInput,
  EarlySignalInput,
  HealthContext,
  UserContext,
  RiskMitigation,
  MitigationGenerationResult,
  GenerateMitigationsRequest,
  GenerateMitigationsResponse,
  DismissMitigationRequest,
  DismissMitigationResponse,
  GetActiveMitigationsRequest,
  GetActiveMitigationsResponse,
  GetMitigationHistoryRequest,
  GetMitigationHistoryResponse,
  MitigationRule,
  RecentMitigationCheck,
  MITIGATION_THRESHOLDS,
  DOMAIN_CONFIG,
  SAFE_LANGUAGE_PATTERNS
} from '../types/risk-mitigation';

// =============================================================================
// VTID-01143: Constants
// =============================================================================

export const VTID = 'VTID-01143';
const ENGINE_VERSION = '1.0.0';
const LOG_PREFIX = '[D49-Engine]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

// =============================================================================
// VTID-01143: Environment Detection
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
// VTID-01143: Supabase Client Factory
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
  userId: string;
  tenantId: string;
  error?: string;
}> {
  let supabase: SupabaseClient | null = null;
  let useDevIdentity = false;
  let userId = '';
  let tenantId = '';

  if (authToken) {
    supabase = createUserClient(authToken);
  } else if (isDevSandbox()) {
    supabase = createServiceClient();
    useDevIdentity = true;
    userId = DEV_IDENTITY.USER_ID;
    tenantId = DEV_IDENTITY.TENANT_ID;
  } else {
    return { supabase: null, useDevIdentity: false, userId: '', tenantId: '', error: 'UNAUTHENTICATED' };
  }

  if (!supabase) {
    return { supabase: null, useDevIdentity: false, userId: '', tenantId: '', error: 'SERVICE_UNAVAILABLE' };
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

  return { supabase, useDevIdentity, userId, tenantId };
}

// =============================================================================
// VTID-01143: OASIS Event Emission
// =============================================================================

async function emitD49Event(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as any,
      source: 'd49-risk-mitigation-engine',
      status,
      message,
      payload: {
        ...payload,
        vtid: VTID,
        engine_version: ENGINE_VERSION
      }
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to emit ${type}:`, err);
  }
}

// =============================================================================
// VTID-01143: Determinism Helpers
// =============================================================================

/**
 * Generate deterministic hash for input verification
 */
function hashInput(input: unknown): string {
  const str = JSON.stringify(input, Object.keys(input as object).sort());
  return createHash('sha256').update(str).digest('hex').substring(0, 16);
}

/**
 * Generate deterministic key for mitigation deduplication
 */
function generateDeterminismKey(domain: MitigationDomain, riskType: string, suggestionHash: string): string {
  return `${domain}:${riskType}:${suggestionHash}`;
}

// =============================================================================
// VTID-01143: Built-in Mitigation Rules
// =============================================================================

/**
 * Default mitigation rules for each domain
 * These are deterministic mappings from risk types to suggestions
 */
const BUILTIN_MITIGATION_RULES: MitigationRule[] = [
  // Sleep & Recovery
  {
    id: 'sleep-fatigue-wind-down',
    domain: 'sleep',
    trigger_risk_types: ['fatigue', 'sleep_deficit', 'low_energy'],
    min_confidence: 75,
    suggestion_template: 'Consider dimming lights and winding down a bit earlier tonight',
    explanation_template: 'Rest may help reduce the fatigue signals we noticed',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 14
  },
  {
    id: 'sleep-screen-time',
    domain: 'sleep',
    trigger_risk_types: ['poor_sleep_quality', 'restlessness'],
    min_confidence: 75,
    suggestion_template: 'You might try reducing screen time an hour before bed',
    explanation_template: 'Screen light can affect sleep quality',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 14
  },

  // Nutrition & Hydration
  {
    id: 'nutrition-hydration',
    domain: 'nutrition',
    trigger_risk_types: ['dehydration', 'low_energy', 'fatigue'],
    min_confidence: 75,
    suggestion_template: 'Consider having a glass of water',
    explanation_template: 'Staying hydrated may help with energy levels',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 3  // Hydration reminders can be more frequent
  },
  {
    id: 'nutrition-meal-skip',
    domain: 'nutrition',
    trigger_risk_types: ['meal_skipped', 'irregular_eating'],
    min_confidence: 75,
    suggestion_template: 'A light snack might help if you haven\'t eaten recently',
    explanation_template: 'Regular eating patterns may support steady energy',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 7
  },

  // Movement & Activity
  {
    id: 'movement-sedentary',
    domain: 'movement',
    trigger_risk_types: ['sedentary', 'prolonged_sitting', 'inactivity'],
    min_confidence: 75,
    suggestion_template: 'Consider a brief walk or stretch when you have a moment',
    explanation_template: 'Light movement may help refresh your focus',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 7
  },
  {
    id: 'movement-tension',
    domain: 'movement',
    trigger_risk_types: ['muscle_tension', 'stiffness'],
    min_confidence: 75,
    suggestion_template: 'A few minutes of gentle stretching might feel good',
    explanation_template: 'Stretching may help release physical tension',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 7
  },

  // Mental Load & Stress
  {
    id: 'mental-stress-break',
    domain: 'mental',
    trigger_risk_types: ['high_stress', 'overwhelm', 'cognitive_overload'],
    min_confidence: 75,
    suggestion_template: 'Taking a few slow, deep breaths might help right now',
    explanation_template: 'Brief pauses may help manage stress signals',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 3
  },
  {
    id: 'mental-focus-break',
    domain: 'mental',
    trigger_risk_types: ['focus_fatigue', 'mental_fatigue'],
    min_confidence: 75,
    suggestion_template: 'Consider stepping away for a brief mental break',
    explanation_template: 'Short breaks may help restore focus',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 7
  },

  // Routine Stability
  {
    id: 'routine-disruption',
    domain: 'routine',
    trigger_risk_types: ['routine_disruption', 'schedule_variance'],
    min_confidence: 75,
    suggestion_template: 'Returning to your usual routine when possible may help',
    explanation_template: 'Routine stability often supports overall wellbeing',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 14
  },
  {
    id: 'routine-sleep-schedule',
    domain: 'routine',
    trigger_risk_types: ['irregular_sleep_schedule', 'circadian_disruption'],
    min_confidence: 75,
    suggestion_template: 'Keeping a consistent sleep schedule tonight might help',
    explanation_template: 'Regular sleep times may support better rest',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 14
  },

  // Social Balance
  {
    id: 'social-isolation',
    domain: 'social',
    trigger_risk_types: ['social_isolation', 'low_social_contact'],
    min_confidence: 75,
    suggestion_template: 'Reaching out to someone might be nice when you feel ready',
    explanation_template: 'Social connection may support emotional wellbeing',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 14
  },
  {
    id: 'social-overload',
    domain: 'social',
    trigger_risk_types: ['social_overload', 'overstimulation'],
    min_confidence: 75,
    suggestion_template: 'Some quiet time for yourself might be restorative',
    explanation_template: 'Balance between social and alone time may help',
    conditions: [],
    precedent_type: 'general_safety',
    cooldown_days: 14
  }
];

// =============================================================================
// VTID-01143: Mitigation Generation Logic (Deterministic)
// =============================================================================

/**
 * Check if a mitigation was recently shown (cooldown enforcement)
 */
async function checkRecentMitigations(
  supabase: SupabaseClient,
  userId: string,
  domain: MitigationDomain,
  suggestionHash: string,
  cooldownDays: number
): Promise<boolean> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - cooldownDays);

    const { data, error } = await supabase
      .from('risk_mitigations')
      .select('id, created_at')
      .eq('user_id', userId)
      .eq('domain', domain)
      .eq('suggestion_hash', suggestionHash)
      .gte('created_at', cutoffDate.toISOString())
      .limit(1);

    if (error) {
      console.warn(`${LOG_PREFIX} Error checking recent mitigations:`, error.message);
      return false;  // Fail open - allow mitigation
    }

    return (data?.length || 0) > 0;
  } catch (err) {
    console.warn(`${LOG_PREFIX} Exception checking recent mitigations:`, err);
    return false;
  }
}

/**
 * Find matching mitigation rule for a risk window
 */
function findMatchingRule(
  riskWindow: RiskWindowInput
): MitigationRule | null {
  // First, check confidence threshold
  if (riskWindow.confidence < MITIGATION_THRESHOLDS.MIN_RISK_CONFIDENCE) {
    return null;
  }

  // Find first matching rule
  for (const rule of BUILTIN_MITIGATION_RULES) {
    if (rule.trigger_risk_types.includes(riskWindow.risk_type)) {
      if (riskWindow.confidence >= rule.min_confidence) {
        return rule;
      }
    }
  }

  return null;
}

/**
 * Generate a single mitigation from a rule and risk window
 */
function generateMitigationFromRule(
  rule: MitigationRule,
  riskWindow: RiskWindowInput,
  userContext: UserContext,
  healthContext?: HealthContext
): RiskMitigation {
  const now = new Date().toISOString();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + MITIGATION_THRESHOLDS.DEFAULT_EXPIRY_HOURS);

  // Compute confidence based on risk confidence and rule match
  const mitigationConfidence = Math.round(
    Math.min(100, riskWindow.confidence * 0.9)  // Slightly lower than risk confidence
  );

  // Generate suggestion hash for cooldown tracking
  const suggestionHash = hashInput({
    domain: rule.domain,
    template: rule.suggestion_template,
    risk_type: riskWindow.risk_type
  });

  // Input hash for determinism verification
  const inputHash = hashInput({
    risk_window: riskWindow,
    rule_id: rule.id,
    user_id: userContext.user_id
  });

  return {
    mitigation_id: randomUUID(),
    risk_window_id: riskWindow.risk_window_id,
    domain: rule.domain,
    confidence: mitigationConfidence,
    suggested_adjustment: rule.suggestion_template,
    why_this_helps: rule.explanation_template,
    effort_level: 'low' as const,
    dismissible: true as const,
    source_signals: riskWindow.evidence?.map(e => e.signal_id).filter(Boolean) as string[] || [],
    precedent_type: rule.precedent_type,
    disclaimer: SAFE_LANGUAGE_PATTERNS.disclaimers[0],
    status: 'active' as const,
    created_at: now,
    expires_at: expiresAt.toISOString(),
    dismissed_at: undefined,
    generated_by_version: ENGINE_VERSION,
    input_hash: inputHash
  };
}

// =============================================================================
// VTID-01143: Public API Functions
// =============================================================================

/**
 * Generate mitigations for given risk windows
 */
export async function generateMitigations(
  request: GenerateMitigationsRequest,
  authToken?: string
): Promise<GenerateMitigationsResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError, userId, tenantId } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const effectiveUserId = request.user_context.user_id || userId;
    const effectiveTenantId = request.user_context.tenant_id || tenantId;

    const generatedMitigations: RiskMitigation[] = [];
    const skippedReasons: Array<{ risk_window_id: string; reason: string }> = [];

    // Process each risk window
    for (const riskWindow of request.risk_windows) {
      // Check confidence threshold
      if (riskWindow.confidence < MITIGATION_THRESHOLDS.MIN_RISK_CONFIDENCE) {
        skippedReasons.push({
          risk_window_id: riskWindow.risk_window_id,
          reason: `Confidence ${riskWindow.confidence}% below threshold ${MITIGATION_THRESHOLDS.MIN_RISK_CONFIDENCE}%`
        });
        continue;
      }

      // Find matching rule
      const rule = findMatchingRule(riskWindow);
      if (!rule) {
        skippedReasons.push({
          risk_window_id: riskWindow.risk_window_id,
          reason: `No matching rule for risk type: ${riskWindow.risk_type}`
        });
        continue;
      }

      // Check cooldown (14 day rule)
      const suggestionHash = hashInput({
        domain: rule.domain,
        template: rule.suggestion_template,
        risk_type: riskWindow.risk_type
      });

      const recentlyShown = await checkRecentMitigations(
        supabase,
        effectiveUserId,
        rule.domain,
        suggestionHash,
        rule.cooldown_days
      );

      if (recentlyShown) {
        skippedReasons.push({
          risk_window_id: riskWindow.risk_window_id,
          reason: `Similar mitigation shown within ${rule.cooldown_days} days`
        });

        await emitD49Event(
          'risk_mitigation.skipped',
          'info',
          `Mitigation skipped due to cooldown`,
          {
            risk_window_id: riskWindow.risk_window_id,
            domain: rule.domain,
            cooldown_days: rule.cooldown_days
          }
        );

        continue;
      }

      // Check max active mitigations
      if (generatedMitigations.length >= MITIGATION_THRESHOLDS.MAX_ACTIVE_MITIGATIONS) {
        skippedReasons.push({
          risk_window_id: riskWindow.risk_window_id,
          reason: `Maximum active mitigations (${MITIGATION_THRESHOLDS.MAX_ACTIVE_MITIGATIONS}) reached`
        });
        continue;
      }

      // Generate the mitigation
      const mitigation = generateMitigationFromRule(
        rule,
        riskWindow,
        request.user_context,
        request.health_context
      );

      generatedMitigations.push(mitigation);
    }

    // Store generated mitigations
    for (const mitigation of generatedMitigations) {
      const suggestionHash = hashInput({
        domain: mitigation.domain,
        template: mitigation.suggested_adjustment,
        risk_type: request.risk_windows.find(rw => rw.risk_window_id === mitigation.risk_window_id)?.risk_type
      });

      const { error: insertError } = await supabase
        .from('risk_mitigations')
        .insert({
          id: mitigation.mitigation_id,
          tenant_id: effectiveTenantId,
          user_id: effectiveUserId,
          risk_window_id: mitigation.risk_window_id,
          domain: mitigation.domain,
          confidence: mitigation.confidence,
          suggested_adjustment: mitigation.suggested_adjustment,
          why_this_helps: mitigation.why_this_helps,
          effort_level: mitigation.effort_level,
          source_signals: mitigation.source_signals,
          precedent_type: mitigation.precedent_type,
          disclaimer: mitigation.disclaimer,
          status: mitigation.status,
          expires_at: mitigation.expires_at,
          generated_by_version: mitigation.generated_by_version,
          input_hash: mitigation.input_hash,
          suggestion_hash: suggestionHash
        });

      if (insertError) {
        console.error(`${LOG_PREFIX} Error storing mitigation:`, insertError.message);
      }

      // Emit OASIS event
      await emitD49Event(
        'risk_mitigation.generated',
        'success',
        `Mitigation generated for ${mitigation.domain}`,
        {
          mitigation_id: mitigation.mitigation_id,
          risk_window_id: mitigation.risk_window_id,
          domain: mitigation.domain,
          confidence: mitigation.confidence,
          user_id: effectiveUserId
        }
      );
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Generated ${generatedMitigations.length} mitigations in ${duration}ms`);

    return {
      ok: true,
      mitigations: generatedMitigations,
      skipped_count: skippedReasons.length,
      generation_id: randomUUID()
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error generating mitigations:`, errorMessage);

    await emitD49Event(
      'risk_mitigation.error',
      'error',
      `Mitigation generation failed: ${errorMessage}`,
      { error: errorMessage }
    );

    return { ok: false, error: errorMessage };
  }
}

/**
 * Dismiss a mitigation
 */
export async function dismissMitigation(
  request: DismissMitigationRequest,
  authToken?: string
): Promise<DismissMitigationResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from('risk_mitigations')
      .update({
        status: 'dismissed',
        dismissed_at: now,
        dismiss_reason: request.reason || null,
        updated_at: now
      })
      .eq('id', request.mitigation_id)
      .select('id, domain')
      .single();

    if (error) {
      console.error(`${LOG_PREFIX} Error dismissing mitigation:`, error.message);
      return { ok: false, error: error.message };
    }

    if (!data) {
      return { ok: false, error: 'NOT_FOUND' };
    }

    await emitD49Event(
      'risk_mitigation.dismissed',
      'info',
      `Mitigation dismissed`,
      {
        mitigation_id: request.mitigation_id,
        domain: data.domain,
        reason: request.reason
      }
    );

    return {
      ok: true,
      mitigation_id: request.mitigation_id,
      dismissed_at: now
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error dismissing mitigation:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get active mitigations for a user
 */
export async function getActiveMitigations(
  request: GetActiveMitigationsRequest,
  authToken?: string
): Promise<GetActiveMitigationsResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    let query = supabase
      .from('risk_mitigations')
      .select('*')
      .eq('status', 'active')
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(request.limit);

    if (request.domains && request.domains.length > 0) {
      query = query.in('domain', request.domains);
    }

    const { data, error } = await query;

    if (error) {
      console.error(`${LOG_PREFIX} Error fetching active mitigations:`, error.message);
      return { ok: false, error: error.message };
    }

    // Map to RiskMitigation type
    const mitigations: RiskMitigation[] = (data || []).map(row => ({
      mitigation_id: row.id,
      risk_window_id: row.risk_window_id,
      domain: row.domain as MitigationDomain,
      confidence: row.confidence,
      suggested_adjustment: row.suggested_adjustment,
      why_this_helps: row.why_this_helps,
      effort_level: 'low' as const,
      dismissible: true as const,
      source_signals: row.source_signals || [],
      precedent_type: row.precedent_type,
      disclaimer: row.disclaimer,
      status: row.status as MitigationStatus,
      created_at: row.created_at,
      expires_at: row.expires_at,
      dismissed_at: row.dismissed_at,
      generated_by_version: row.generated_by_version,
      input_hash: row.input_hash
    }));

    return {
      ok: true,
      mitigations,
      count: mitigations.length
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting active mitigations:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get mitigation history for a user
 */
export async function getMitigationHistory(
  request: GetMitigationHistoryRequest,
  authToken?: string
): Promise<GetMitigationHistoryResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    let query = supabase
      .from('risk_mitigations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(request.limit);

    if (request.domains && request.domains.length > 0) {
      query = query.in('domain', request.domains);
    }

    if (request.statuses && request.statuses.length > 0) {
      query = query.in('status', request.statuses);
    }

    if (request.since) {
      query = query.gte('created_at', request.since);
    }

    const { data, error } = await query;

    if (error) {
      console.error(`${LOG_PREFIX} Error fetching mitigation history:`, error.message);
      return { ok: false, error: error.message };
    }

    // Map to RiskMitigation type
    const mitigations: RiskMitigation[] = (data || []).map(row => ({
      mitigation_id: row.id,
      risk_window_id: row.risk_window_id,
      domain: row.domain as MitigationDomain,
      confidence: row.confidence,
      suggested_adjustment: row.suggested_adjustment,
      why_this_helps: row.why_this_helps,
      effort_level: 'low' as const,
      dismissible: true as const,
      source_signals: row.source_signals || [],
      precedent_type: row.precedent_type,
      disclaimer: row.disclaimer,
      status: row.status as MitigationStatus,
      created_at: row.created_at,
      expires_at: row.expires_at,
      dismissed_at: row.dismissed_at,
      generated_by_version: row.generated_by_version,
      input_hash: row.input_hash
    }));

    return {
      ok: true,
      mitigations,
      count: mitigations.length
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting mitigation history:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Acknowledge a mitigation (user viewed it)
 */
export async function acknowledgeMitigation(
  mitigationId: string,
  authToken?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const now = new Date().toISOString();

    const { error } = await supabase
      .from('risk_mitigations')
      .update({
        status: 'acknowledged',
        acknowledged_at: now,
        updated_at: now
      })
      .eq('id', mitigationId)
      .eq('status', 'active');  // Only acknowledge active mitigations

    if (error) {
      console.error(`${LOG_PREFIX} Error acknowledging mitigation:`, error.message);
      return { ok: false, error: error.message };
    }

    await emitD49Event(
      'risk_mitigation.acknowledged',
      'success',
      `Mitigation acknowledged`,
      { mitigation_id: mitigationId }
    );

    return { ok: true };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error acknowledging mitigation:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Expire old mitigations (cleanup job)
 */
export async function expireOldMitigations(
  authToken?: string
): Promise<{ ok: boolean; expired_count?: number; error?: string }> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from('risk_mitigations')
      .update({
        status: 'expired',
        updated_at: now
      })
      .eq('status', 'active')
      .lt('expires_at', now)
      .select('id');

    if (error) {
      console.error(`${LOG_PREFIX} Error expiring mitigations:`, error.message);
      return { ok: false, error: error.message };
    }

    const expiredCount = data?.length || 0;

    if (expiredCount > 0) {
      await emitD49Event(
        'risk_mitigation.expired',
        'info',
        `${expiredCount} mitigation(s) expired`,
        { expired_count: expiredCount }
      );
    }

    return { ok: true, expired_count: expiredCount };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error expiring mitigations:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

// =============================================================================
// VTID-01143: Exports
// =============================================================================

export {
  BUILTIN_MITIGATION_RULES,
  hashInput,
  generateDeterminismKey,
  findMatchingRule,
  generateMitigationFromRule
};

export default {
  VTID,
  ENGINE_VERSION,
  generateMitigations,
  dismissMitigation,
  getActiveMitigations,
  getMitigationHistory,
  acknowledgeMitigation,
  expireOldMitigations
};
