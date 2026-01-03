/**
 * VTID-01140: D46 Anticipatory Guidance & Pre-emptive Coaching Layer
 *
 * Core Intelligence Engine that translates predictive windows (D45) into
 * gentle, pre-emptive guidance that helps the user prepare *before* a risk
 * or opportunity window occurs.
 *
 * D46 answers: "What would help right now, given what's likely coming?"
 *
 * Core Principles:
 *   - Memory-first: Leverage existing memory/context
 *   - User consent respected implicitly (guidance only, no enforcement)
 *   - No behavioral enforcement: Suggestions only, always dismissible
 *   - No medical or psychological claims
 *   - Explainability required: Clear lineage signal → window → guidance
 *   - Tone: supportive, non-directive
 *   - All outputs logged to OASIS
 *
 * Hard Constraints (Non-Negotiable):
 *   - No notifications logic
 *   - No scheduling
 *   - No habit enforcement
 *   - No personalization beyond existing memory
 *
 * Determinism Rules:
 *   - Same predictive windows → same guidance candidates
 *   - Same eligibility rules → same filtering
 *   - Rule-based, no generative inference at this layer
 *
 * Position in Intelligence Stack:
 *   D44 Pattern Detection → D45 Predictive Windows → D46 Anticipatory Guidance → D47-D51 Delivery
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  SignalDomain,
  GuidanceMode,
  TimingHint,
  WindowType,
  PatternSignal,
  PredictiveWindow,
  D44SignalBundle,
  D45WindowBundle,
  GuidanceItem,
  GuidanceRecord,
  GuidancePreferences,
  GuidanceInteraction,
  UserGuidanceContext,
  EligibilityCheckResult,
  LanguageValidationResult,
  GenerateGuidanceRequest,
  GenerateGuidanceResponse,
  GetGuidanceHistoryRequest,
  GetGuidanceHistoryResponse,
  RecordGuidanceInteractionRequest,
  RecordGuidanceInteractionResponse,
  GUIDANCE_THRESHOLDS,
  GUIDANCE_MODE_METADATA,
  FORBIDDEN_PHRASES,
  OPTIONAL_PHRASING_PATTERNS
} from '../types/anticipatory-guidance';

// =============================================================================
// VTID-01140: Constants
// =============================================================================

export const VTID = 'VTID-01140';
const LOG_PREFIX = '[D46-Engine]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

/**
 * Current version of guidance generation rules
 */
const GENERATION_RULES_VERSION = '1.0.0';

// =============================================================================
// VTID-01140: Environment Detection
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
// VTID-01140: Supabase Client Factory
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
  let userId = DEV_IDENTITY.USER_ID;
  let tenantId = DEV_IDENTITY.TENANT_ID;

  if (authToken) {
    supabase = createUserClient(authToken);
  } else if (isDevSandbox()) {
    supabase = createServiceClient();
    useDevIdentity = true;
  } else {
    return { supabase: null, useDevIdentity: false, userId, tenantId, error: 'UNAUTHENTICATED' };
  }

  if (!supabase) {
    return { supabase: null, useDevIdentity: false, userId, tenantId, error: 'SERVICE_UNAVAILABLE' };
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
// VTID-01140: OASIS Event Emission
// =============================================================================

async function emitD46Event(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: type as any,
      source: 'd46-anticipatory-guidance-engine',
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

/**
 * OASIS event helpers for anticipatory guidance
 */
export const anticipatoryGuidanceEvents = {
  /**
   * Emit guidance.generated event
   */
  guidanceGenerated: (
    guidanceId: string,
    windowId: string,
    mode: GuidanceMode,
    domain: SignalDomain,
    confidence: number,
    userId?: string,
    tenantId?: string
  ) =>
    emitD46Event(
      'guidance.generated',
      'success',
      `Guidance generated: ${mode} for ${domain}`,
      {
        guidance_id: guidanceId,
        source_window_id: windowId,
        guidance_mode: mode,
        domain,
        confidence,
        user_id: userId,
        tenant_id: tenantId,
        generated_at: new Date().toISOString()
      }
    ),

  /**
   * Emit guidance.surfaced event
   */
  guidanceSurfaced: (
    guidanceId: string,
    mode: GuidanceMode,
    domain: SignalDomain,
    userId?: string,
    tenantId?: string
  ) =>
    emitD46Event(
      'guidance.surfaced',
      'success',
      `Guidance surfaced to user: ${mode}`,
      {
        guidance_id: guidanceId,
        guidance_mode: mode,
        domain,
        user_id: userId,
        tenant_id: tenantId,
        surfaced_at: new Date().toISOString()
      }
    ),

  /**
   * Emit guidance.engaged event
   */
  guidanceEngaged: (
    guidanceId: string,
    mode: GuidanceMode,
    domain: SignalDomain,
    userId?: string,
    tenantId?: string
  ) =>
    emitD46Event(
      'guidance.engaged',
      'success',
      `User engaged with guidance: ${mode}`,
      {
        guidance_id: guidanceId,
        guidance_mode: mode,
        domain,
        user_id: userId,
        tenant_id: tenantId,
        engaged_at: new Date().toISOString()
      }
    ),

  /**
   * Emit guidance.dismissed event
   */
  guidanceDismissed: (
    guidanceId: string,
    mode: GuidanceMode,
    domain: SignalDomain,
    feedback?: string,
    userId?: string,
    tenantId?: string
  ) =>
    emitD46Event(
      'guidance.dismissed',
      'info',
      `User dismissed guidance: ${mode}`,
      {
        guidance_id: guidanceId,
        guidance_mode: mode,
        domain,
        feedback,
        user_id: userId,
        tenant_id: tenantId,
        dismissed_at: new Date().toISOString()
      }
    ),

  /**
   * Emit guidance.eligibility.failed event
   */
  eligibilityFailed: (
    windowId: string,
    reason: string,
    checks: EligibilityCheckResult['checks'],
    userId?: string,
    tenantId?: string
  ) =>
    emitD46Event(
      'guidance.eligibility.failed',
      'info',
      `Guidance eligibility failed: ${reason}`,
      {
        source_window_id: windowId,
        reason,
        checks,
        user_id: userId,
        tenant_id: tenantId,
        checked_at: new Date().toISOString()
      }
    ),

  /**
   * Emit guidance.language.invalid event
   */
  languageInvalid: (
    guidanceId: string,
    issues: LanguageValidationResult['issues'],
    userId?: string,
    tenantId?: string
  ) =>
    emitD46Event(
      'guidance.language.invalid',
      'warning',
      `Guidance language validation failed: ${issues.length} issues`,
      {
        guidance_id: guidanceId,
        issues,
        user_id: userId,
        tenant_id: tenantId,
        validated_at: new Date().toISOString()
      }
    )
};

// =============================================================================
// VTID-01140: Language Validation (Deterministic)
// =============================================================================

/**
 * Validate guidance text against language rules
 * No imperatives, no alarmist wording, use optional phrasing
 */
export function validateGuidanceLanguage(text: string): LanguageValidationResult {
  const issues: LanguageValidationResult['issues'] = [];
  const lowerText = text.toLowerCase();

  // Check for forbidden phrases
  for (const phrase of FORBIDDEN_PHRASES) {
    if (lowerText.includes(phrase)) {
      issues.push({
        type: 'forbidden_phrase',
        phrase,
        suggestion: `Consider replacing "${phrase}" with optional phrasing`
      });
    }
  }

  // Check for imperative tone (starts with verb)
  const imperativePatterns = [
    /^do\s/i,
    /^don't\s/i,
    /^make sure/i,
    /^ensure/i,
    /^be sure to/i,
    /^remember to/i
  ];

  for (const pattern of imperativePatterns) {
    if (pattern.test(text)) {
      issues.push({
        type: 'too_direct',
        phrase: text.substring(0, 20),
        suggestion: 'Start with optional phrasing like "You might consider..."'
      });
      break;
    }
  }

  // Check for alarmist wording
  const alarmistPatterns = [
    /danger/i,
    /risk of harm/i,
    /you will/i,
    /if you don't/i,
    /failure to/i,
    /consequences/i
  ];

  for (const pattern of alarmistPatterns) {
    if (pattern.test(text)) {
      issues.push({
        type: 'alarmist',
        phrase: text.match(pattern)?.[0],
        suggestion: 'Use supportive, non-directive language'
      });
    }
  }

  // Check for optional phrasing (soft requirement - just a warning)
  const hasOptionalPhrasing = OPTIONAL_PHRASING_PATTERNS.some(
    pattern => lowerText.includes(pattern.toLowerCase())
  );

  if (!hasOptionalPhrasing && !lowerText.includes('?')) {
    // Allow questions without optional phrasing (reflection mode)
    issues.push({
      type: 'missing_optional_phrasing',
      suggestion: 'Consider using optional phrasing like "you might consider" or "one option could be"'
    });
  }

  return {
    valid: issues.filter(i => i.type !== 'missing_optional_phrasing').length === 0,
    issues
  };
}

// =============================================================================
// VTID-01140: Eligibility Checking (Deterministic)
// =============================================================================

/**
 * Check if a window is eligible for guidance generation
 */
export function checkWindowEligibility(
  window: PredictiveWindow,
  userContext: UserGuidanceContext,
  recentInteractions: GuidanceInteraction[]
): EligibilityCheckResult {
  const checks = {
    window_confidence_met: window.confidence >= GUIDANCE_THRESHOLDS.MIN_WINDOW_CONFIDENCE,
    relevance_score_met: true, // Will be calculated after relevance scoring
    cooldown_passed: true,
    cognitive_load_acceptable: userContext.current_cognitive_load <= GUIDANCE_THRESHOLDS.MAX_COGNITIVE_LOAD
  };

  // Check cooldown - no similar guidance in last 14 days
  const cooldownCutoff = new Date();
  cooldownCutoff.setDate(cooldownCutoff.getDate() - GUIDANCE_THRESHOLDS.COOLDOWN_DAYS);

  const recentSimilar = recentInteractions.filter(interaction => {
    const interactedAt = new Date(interaction.interacted_at);
    return interaction.domain === window.domain &&
           interactedAt >= cooldownCutoff;
  });

  if (recentSimilar.length > 0) {
    checks.cooldown_passed = false;
  }

  // Check if domain is enabled in user preferences
  if (!userContext.preferences.enabled_domains.includes(window.domain)) {
    checks.relevance_score_met = false;
  }

  // Check daily limit
  if (userContext.guidance_today_count >= userContext.preferences.max_daily_guidance) {
    checks.relevance_score_met = false;
  }

  // Determine overall eligibility
  const allChecksPassed = Object.values(checks).every(v => v);

  let reason = 'All eligibility checks passed';
  if (!checks.window_confidence_met) {
    reason = `Window confidence (${window.confidence}%) below threshold (${GUIDANCE_THRESHOLDS.MIN_WINDOW_CONFIDENCE}%)`;
  } else if (!checks.cognitive_load_acceptable) {
    reason = `User cognitive load (${userContext.current_cognitive_load}%) too high`;
  } else if (!checks.cooldown_passed) {
    reason = `Similar guidance shown within last ${GUIDANCE_THRESHOLDS.COOLDOWN_DAYS} days`;
  } else if (!checks.relevance_score_met) {
    reason = 'Domain not enabled or daily limit reached';
  }

  return {
    eligible: allChecksPassed,
    reason,
    checks
  };
}

/**
 * Calculate relevance score for a window
 */
export function calculateRelevanceScore(
  window: PredictiveWindow,
  signals: PatternSignal[],
  userContext: UserGuidanceContext
): number {
  let score = 50; // Base score

  // Boost for high confidence window
  if (window.confidence >= 85) {
    score += 15;
  } else if (window.confidence >= 75) {
    score += 10;
  }

  // Boost for high impact windows
  if (window.impact_level === 'high') {
    score += 20;
  } else if (window.impact_level === 'medium') {
    score += 10;
  }

  // Boost for domains with strong signals
  const domainSignals = signals.filter(s => s.domain === window.domain);
  const avgSignalIntensity = domainSignals.length > 0
    ? domainSignals.reduce((sum, s) => sum + s.intensity, 0) / domainSignals.length
    : 0;

  if (avgSignalIntensity >= 70) {
    score += 15;
  } else if (avgSignalIntensity >= 50) {
    score += 10;
  }

  // Reduce score if user has dismissed similar guidance recently
  const recentDismissals = userContext.recent_interactions.filter(
    i => i.domain === window.domain && i.interaction === 'dismissed'
  );

  if (recentDismissals.length >= 3) {
    score -= 20;
  } else if (recentDismissals.length >= 1) {
    score -= 10;
  }

  // Boost for engaged guidance in this domain (user receptive)
  const recentEngagements = userContext.recent_interactions.filter(
    i => i.domain === window.domain && i.interaction === 'engaged'
  );

  if (recentEngagements.length >= 2) {
    score += 10;
  }

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}

// =============================================================================
// VTID-01140: Guidance Mode Selection (Deterministic)
// =============================================================================

/**
 * Select appropriate guidance mode based on window type and domain
 */
export function selectGuidanceMode(
  window: PredictiveWindow,
  signals: PatternSignal[],
  userPreferences: GuidancePreferences
): GuidanceMode {
  // Reinforcement: For positive momentum windows
  if (window.type === 'peak' || window.type === 'recovery') {
    const positiveSignals = signals.filter(
      s => s.domain === window.domain && s.trend === 'increasing' && s.intensity >= 60
    );
    if (positiveSignals.length > 0) {
      return 'reinforcement';
    }
  }

  // Preparation: For upcoming risk or opportunity windows
  if (window.type === 'risk' || window.type === 'opportunity') {
    const windowStart = new Date(window.starts_at);
    const hoursUntilWindow = (windowStart.getTime() - Date.now()) / (1000 * 60 * 60);

    // If window is 24-72 hours away, suggest preparation
    if (hoursUntilWindow >= 24 && hoursUntilWindow <= 72) {
      return 'preparation';
    }
  }

  // Reflection: For transition periods or when user prefers conversational tone
  if (window.type === 'transition' || userPreferences.preferred_tone === 'conversational') {
    return 'reflection';
  }

  // Awareness: Default mode for surfacing observations
  return 'awareness';
}

// =============================================================================
// VTID-01140: Timing Hint Selection (Deterministic)
// =============================================================================

/**
 * Select timing hint based on window timing
 */
export function selectTimingHint(window: PredictiveWindow): TimingHint {
  const now = new Date();
  const windowStart = new Date(window.starts_at);
  const hoursUntilWindow = (windowStart.getTime() - now.getTime()) / (1000 * 60 * 60);

  // If window is starting soon (<6 hours), surface now
  if (hoursUntilWindow <= 6) {
    return 'now';
  }

  // If window is 6-24 hours away, surface within next 24h
  if (hoursUntilWindow <= 24) {
    return 'next_24h';
  }

  // Otherwise, surface before window
  return 'before_window';
}

// =============================================================================
// VTID-01140: Guidance Text Generation (Template-based, Deterministic)
// =============================================================================

/**
 * Generate guidance text based on mode, domain, and window
 */
export function generateGuidanceText(
  mode: GuidanceMode,
  window: PredictiveWindow,
  signals: PatternSignal[]
): { text: string; why: string } {
  const domainSignals = signals.filter(s => s.domain === window.domain);
  const topSignal = domainSignals.sort((a, b) => b.intensity - a.intensity)[0];

  // Template-based generation to ensure determinism
  switch (mode) {
    case 'awareness':
      return generateAwarenessText(window, topSignal);
    case 'reflection':
      return generateReflectionText(window, topSignal);
    case 'preparation':
      return generatePreparationText(window, topSignal);
    case 'reinforcement':
      return generateReinforcementText(window, topSignal);
    default:
      return {
        text: 'Something to be aware of regarding your upcoming schedule.',
        why: 'Based on recent patterns.'
      };
  }
}

function generateAwarenessText(window: PredictiveWindow, signal?: PatternSignal): { text: string; why: string } {
  const domainLabels: Record<SignalDomain, string> = {
    health: 'your energy levels',
    behavior: 'your activity patterns',
    social: 'your social connections',
    cognitive: 'your focus and mental clarity',
    routine: 'your daily rhythm',
    emotional: 'your emotional state',
    financial: 'your financial patterns'
  };

  const domainLabel = domainLabels[window.domain] || 'your patterns';

  return {
    text: `You may notice some changes in ${domainLabel} over the coming days. ${window.description}`,
    why: signal
      ? `This observation is based on ${signal.pattern_type.replace(/_/g, ' ')} patterns detected recently.`
      : 'Based on patterns observed over the past few days.'
  };
}

function generateReflectionText(window: PredictiveWindow, signal?: PatternSignal): { text: string; why: string } {
  const reflectionQuestions: Record<WindowType, string> = {
    risk: 'What might help you feel more prepared?',
    opportunity: 'What would help you make the most of this time?',
    transition: 'How are you feeling about the changes ahead?',
    recovery: 'What do you need most right now to restore your energy?',
    peak: 'What would you like to accomplish during this high-energy period?',
    low: 'What small adjustments might help you through this period?'
  };

  return {
    text: reflectionQuestions[window.type] || 'What feels most important to focus on right now?',
    why: `${window.description} This might be a good moment for reflection.`
  };
}

function generatePreparationText(window: PredictiveWindow, signal?: PatternSignal): { text: string; why: string } {
  const preparationSuggestions: Record<SignalDomain, string> = {
    health: 'You might consider preparing some easy, nourishing meals ahead of time.',
    behavior: 'One option could be to set up your environment to support your goals.',
    social: 'It may be helpful to reach out to someone supportive ahead of time.',
    cognitive: 'Perhaps clearing your schedule of non-essentials could help.',
    routine: 'You could consider laying out what you need the night before.',
    emotional: 'Some find it helpful to identify a few calming activities in advance.',
    financial: 'You might want to review your budget before this period.'
  };

  return {
    text: preparationSuggestions[window.domain] || 'You might consider some light preparation for the days ahead.',
    why: `${window.description} A little preparation now could make things easier.`
  };
}

function generateReinforcementText(window: PredictiveWindow, signal?: PatternSignal): { text: string; why: string } {
  const reinforcementMessages: Record<SignalDomain, string> = {
    health: 'Your recent health habits seem to be building positive momentum.',
    behavior: 'The patterns you\'ve been cultivating appear to be taking hold.',
    social: 'Your efforts to connect with others seem to be paying off.',
    cognitive: 'Your focus and mental clarity have been notably strong recently.',
    routine: 'Your consistent routine seems to be creating stability.',
    emotional: 'You seem to be navigating emotions with growing ease.',
    financial: 'Your mindful approach to finances is creating positive patterns.'
  };

  return {
    text: reinforcementMessages[window.domain] || 'Your recent patterns show positive momentum.',
    why: `${window.description} This seems like a good foundation to build on.`
  };
}

// =============================================================================
// VTID-01140: Core Guidance Generation (Deterministic)
// =============================================================================

/**
 * Generate a single guidance item from a window
 */
export function generateGuidanceFromWindow(
  window: PredictiveWindow,
  signals: PatternSignal[],
  userContext: UserGuidanceContext,
  relevanceScore: number
): GuidanceItem | null {
  // Select mode
  const mode = selectGuidanceMode(window, signals, userContext.preferences);

  // Generate text
  const { text, why } = generateGuidanceText(mode, window, signals);

  // Validate language
  const languageValidation = validateGuidanceLanguage(text);
  if (!languageValidation.valid) {
    console.warn(`${LOG_PREFIX} Language validation failed for window ${window.window_id}:`, languageValidation.issues);
    // Continue anyway - log but don't block. Text templates should be pre-validated.
  }

  // Select timing
  const timingHint = selectTimingHint(window);

  return {
    guidance_id: randomUUID(),
    source_window_id: window.window_id,
    guidance_mode: mode,
    domain: window.domain,
    confidence: Math.round((window.confidence + relevanceScore) / 2),
    timing_hint: timingHint,
    guidance_text: text,
    why_this_matters: why,
    dismissible: true
  };
}

// =============================================================================
// VTID-01140: Public API Functions
// =============================================================================

/**
 * Generate anticipatory guidance from predictive windows
 */
export async function generateGuidance(
  request: GenerateGuidanceRequest,
  authToken?: string
): Promise<GenerateGuidanceResponse> {
  const startTime = Date.now();

  try {
    const { supabase, error: clientError, userId, tenantId } = await getClientWithContext(authToken);

    // Get user context from request or create default
    const userContext: UserGuidanceContext = request.user_context || {
      user_id: request.window_bundle.user_id,
      tenant_id: request.window_bundle.tenant_id,
      preferences: {
        preferred_tone: 'conversational',
        preferred_timing: 'proactive',
        enabled_domains: ['health', 'behavior', 'social', 'cognitive', 'routine'],
        sensitivity_level: 'medium',
        max_daily_guidance: 3
      },
      recent_interactions: [],
      current_cognitive_load: request.signal_bundle.cognitive_load,
      guidance_today_count: 0
    };

    const guidanceItems: GuidanceItem[] = [];
    const skippedWindows: Array<{ window_id: string; reason: string }> = [];

    // Process each window
    for (const window of request.window_bundle.windows) {
      // Check eligibility
      const eligibility = checkWindowEligibility(
        window,
        userContext,
        userContext.recent_interactions
      );

      if (!eligibility.eligible) {
        skippedWindows.push({
          window_id: window.window_id,
          reason: eligibility.reason
        });

        await anticipatoryGuidanceEvents.eligibilityFailed(
          window.window_id,
          eligibility.reason,
          eligibility.checks,
          userContext.user_id,
          userContext.tenant_id
        );

        continue;
      }

      // Calculate relevance score
      const relevanceScore = calculateRelevanceScore(
        window,
        request.signal_bundle.signals,
        userContext
      );

      // Check relevance threshold
      if (relevanceScore < GUIDANCE_THRESHOLDS.MIN_RELEVANCE_SCORE) {
        skippedWindows.push({
          window_id: window.window_id,
          reason: `Relevance score (${relevanceScore}%) below threshold (${GUIDANCE_THRESHOLDS.MIN_RELEVANCE_SCORE}%)`
        });
        continue;
      }

      // Generate guidance
      const guidance = generateGuidanceFromWindow(
        window,
        request.signal_bundle.signals,
        userContext,
        relevanceScore
      );

      if (guidance) {
        guidanceItems.push(guidance);

        await anticipatoryGuidanceEvents.guidanceGenerated(
          guidance.guidance_id,
          window.window_id,
          guidance.guidance_mode,
          guidance.domain,
          guidance.confidence,
          userContext.user_id,
          userContext.tenant_id
        );
      }

      // Respect max items limit
      if (guidanceItems.length >= request.max_items) {
        break;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Generated ${guidanceItems.length} guidance items in ${duration}ms`);

    // Store guidance items if we have a database connection
    if (supabase && guidanceItems.length > 0) {
      await storeGuidanceItems(supabase, guidanceItems, request, userContext);
    }

    return {
      ok: true,
      guidance_items: guidanceItems,
      skipped_windows: skippedWindows,
      generation_summary: {
        windows_evaluated: request.window_bundle.windows.length,
        guidance_generated: guidanceItems.length,
        windows_skipped: skippedWindows.length,
        cognitive_load_at_generation: request.signal_bundle.cognitive_load
      }
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error generating guidance:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Store guidance items in database
 */
async function storeGuidanceItems(
  supabase: SupabaseClient,
  items: GuidanceItem[],
  request: GenerateGuidanceRequest,
  userContext: UserGuidanceContext
): Promise<void> {
  try {
    const now = new Date().toISOString();

    const records = items.map(item => ({
      id: item.guidance_id,
      user_id: userContext.user_id,
      tenant_id: userContext.tenant_id,
      source_window_id: item.source_window_id,
      guidance_mode: item.guidance_mode,
      domain: item.domain,
      confidence: item.confidence,
      timing_hint: item.timing_hint,
      guidance_text: item.guidance_text,
      why_this_matters: item.why_this_matters,
      dismissible: item.dismissible,
      originating_signal_ids: request.signal_bundle.signals
        .filter(s => s.domain === item.domain)
        .map(s => s.signal_id),
      user_preferences_snapshot: userContext.preferences,
      status: 'pending',
      relevance_score: item.confidence,
      generation_rules_version: GENERATION_RULES_VERSION,
      created_at: now,
      updated_at: now
    }));

    const { error } = await supabase
      .from('anticipatory_guidance')
      .insert(records);

    if (error) {
      console.warn(`${LOG_PREFIX} Failed to store guidance items:`, error.message);
    } else {
      console.log(`${LOG_PREFIX} Stored ${records.length} guidance items`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error storing guidance items:`, err);
  }
}

/**
 * Get guidance history for user
 */
export async function getGuidanceHistory(
  request: GetGuidanceHistoryRequest,
  authToken?: string
): Promise<GetGuidanceHistoryResponse> {
  try {
    const { supabase, error: clientError } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    let query = supabase
      .from('anticipatory_guidance')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(request.limit);

    if (request.domains && request.domains.length > 0) {
      query = query.in('domain', request.domains);
    }

    if (request.status && request.status.length > 0) {
      query = query.in('status', request.status);
    }

    if (request.since) {
      query = query.gte('created_at', request.since);
    }

    const { data, error } = await query;

    if (error) {
      console.error(`${LOG_PREFIX} Error fetching guidance history:`, error);
      return { ok: false, error: error.message };
    }

    return {
      ok: true,
      guidance: data as GuidanceRecord[],
      count: data?.length || 0
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting guidance history:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Record user interaction with guidance
 */
export async function recordGuidanceInteraction(
  request: RecordGuidanceInteractionRequest,
  authToken?: string
): Promise<RecordGuidanceInteractionResponse> {
  try {
    const { supabase, error: clientError, userId, tenantId } = await getClientWithContext(authToken);
    if (clientError || !supabase) {
      return { ok: false, error: clientError || 'SERVICE_UNAVAILABLE' };
    }

    const now = new Date().toISOString();
    let newStatus: string;

    switch (request.interaction) {
      case 'surfaced':
        newStatus = 'surfaced';
        break;
      case 'engaged':
        newStatus = 'engaged';
        break;
      case 'dismissed':
        newStatus = 'dismissed';
        break;
      default:
        newStatus = 'surfaced';
    }

    const updateData: Record<string, any> = {
      status: newStatus,
      updated_at: now
    };

    if (request.interaction === 'surfaced') {
      updateData.surfaced_at = now;
    } else if (request.interaction === 'engaged') {
      updateData.engaged_at = now;
    } else if (request.interaction === 'dismissed') {
      updateData.dismissed_at = now;
    }

    const { data, error } = await supabase
      .from('anticipatory_guidance')
      .update(updateData)
      .eq('id', request.guidance_id)
      .select('domain, guidance_mode')
      .single();

    if (error) {
      console.error(`${LOG_PREFIX} Error recording interaction:`, error);
      return { ok: false, error: error.message };
    }

    // Emit appropriate OASIS event
    if (request.interaction === 'surfaced') {
      await anticipatoryGuidanceEvents.guidanceSurfaced(
        request.guidance_id,
        data.guidance_mode,
        data.domain,
        userId,
        tenantId
      );
    } else if (request.interaction === 'engaged') {
      await anticipatoryGuidanceEvents.guidanceEngaged(
        request.guidance_id,
        data.guidance_mode,
        data.domain,
        userId,
        tenantId
      );
    } else if (request.interaction === 'dismissed') {
      await anticipatoryGuidanceEvents.guidanceDismissed(
        request.guidance_id,
        data.guidance_mode,
        data.domain,
        request.feedback,
        userId,
        tenantId
      );
    }

    console.log(`${LOG_PREFIX} Recorded ${request.interaction} for guidance ${request.guidance_id}`);

    return {
      ok: true,
      guidance_id: request.guidance_id,
      new_status: newStatus
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error recording interaction:`, errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get guidance context for ORB system prompt injection
 *
 * Returns a formatted string describing pending guidance
 * for injection into conversation context.
 */
export async function getGuidanceContextForOrb(
  authToken?: string
): Promise<{ context: string; pending_count: number } | null> {
  try {
    const historyResult = await getGuidanceHistory({
      status: ['pending', 'surfaced'],
      limit: 5
    }, authToken);

    if (!historyResult.ok || !historyResult.guidance || historyResult.guidance.length === 0) {
      return null;
    }

    const contextLines: string[] = [];
    const pendingGuidance = historyResult.guidance;

    if (pendingGuidance.length > 0) {
      contextLines.push(`There are ${pendingGuidance.length} pieces of anticipatory guidance pending.`);

      // Add high-priority guidance summary
      const highConfidence = pendingGuidance.filter(g => g.confidence >= 80);
      if (highConfidence.length > 0) {
        const domains = [...new Set(highConfidence.map(g => g.domain))];
        contextLines.push(`High-confidence guidance relates to: ${domains.join(', ')}.`);
      }
    }

    return {
      context: contextLines.join(' '),
      pending_count: pendingGuidance.length
    };

  } catch (err) {
    console.error(`${LOG_PREFIX} Error getting guidance context for ORB:`, err);
    return null;
  }
}

// =============================================================================
// VTID-01140: Exports
// =============================================================================

export {
  validateGuidanceLanguage,
  checkWindowEligibility,
  calculateRelevanceScore,
  selectGuidanceMode,
  selectTimingHint,
  generateGuidanceText,
  generateGuidanceFromWindow,
  GUIDANCE_THRESHOLDS,
  GENERATION_RULES_VERSION
};

export type {
  SignalDomain,
  GuidanceMode,
  TimingHint,
  WindowType,
  PatternSignal,
  PredictiveWindow,
  D44SignalBundle,
  D45WindowBundle,
  GuidanceItem,
  GuidanceRecord,
  UserGuidanceContext,
  EligibilityCheckResult,
  LanguageValidationResult
};

export default {
  VTID,
  generateGuidance,
  getGuidanceHistory,
  recordGuidanceInteraction,
  getGuidanceContextForOrb,
  validateGuidanceLanguage,
  checkWindowEligibility,
  calculateRelevanceScore,
  anticipatoryGuidanceEvents
};
