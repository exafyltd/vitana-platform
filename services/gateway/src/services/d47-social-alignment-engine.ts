/**
 * VTID-01141: D47 Proactive Social & Community Alignment Engine
 *
 * Deterministic engine that anticipates social needs and alignment opportunities,
 * proactively surfacing relevant people, groups, events, or activities that
 * improve wellbeing, belonging, and long-term quality of life.
 *
 * D47 answers: "Who or what would be supportive or energizing right now?"
 *
 * Hard Constraints (GOVERNANCE):
 * - Memory-first approach
 * - Consent-by-design (suggestions only)
 * - No forced matchmaking
 * - No social graph exposure
 * - Explainability mandatory
 * - No cold-start hallucinations
 * - All outputs logged to OASIS
 *
 * Determinism Rules:
 * - Same inputs → same context output
 * - No generative interpretation
 * - Rule-based matching only
 *
 * Dependencies: D35 (Social Context), D87 (Relationships), D84 (Community)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  AlignmentSuggestion,
  AlignmentDomain,
  AlignmentAction,
  AlignmentStatus,
  AlignmentSignalRef,
  AlignmentThresholds,
  SocialLoadCheck,
  AlignmentCandidate,
  AlignmentMatchResult,
  GenerateSuggestionsRequest,
  GenerateSuggestionsResponse,
  GetSuggestionsRequest,
  GetSuggestionsResponse,
  MarkShownRequest,
  MarkShownResponse,
  ActOnSuggestionRequest,
  ActOnSuggestionResponse,
  DEFAULT_ALIGNMENT_THRESHOLDS,
  mapNodeTypeToAlignmentDomain,
  calculateRelevanceScore,
  calculateConfidenceScore,
  generateWhyNow,
  passesMatchingThresholds
} from '../types/social-alignment';

// =============================================================================
// Constants
// =============================================================================

const VTID = 'VTID-01141';
const LOG_PREFIX = '[D47-Engine]';

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
// Helper: Bootstrap Dev Context
// =============================================================================

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
// D47 Engine Core Functions
// =============================================================================

/**
 * Generate alignment suggestions for a user
 *
 * This is the main entry point for D47 suggestion generation.
 * It uses the relationship graph and social context to find relevant matches.
 *
 * @param request - Generation parameters
 * @param authToken - JWT token for authenticated requests
 * @returns Generated suggestions
 */
export async function generateSuggestions(
  request: GenerateSuggestionsRequest,
  authToken?: string
): Promise<GenerateSuggestionsResponse> {
  const startTime = Date.now();

  try {
    let supabase: SupabaseClient | null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    } else {
      return {
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication required for suggestion generation'
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    // Prepare parameters
    const maxSuggestions = request.max_suggestions || 5;
    const minRelevance = request.min_relevance || 75;
    const minSharedSignals = request.min_shared_signals || 2;
    const alignmentDomains = request.alignment_domains || null;

    // Call RPC to generate suggestions
    const result = await supabase.rpc('alignment_generate_suggestions', {
      p_max_suggestions: maxSuggestions,
      p_alignment_domains: alignmentDomains,
      p_min_relevance: minRelevance,
      p_min_shared_signals: minSharedSignals
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);

      await emitOasisEvent({
        vtid: VTID,
        type: 'social_alignment.error',
        source: 'gateway-d47',
        status: 'error',
        message: `Suggestion generation failed: ${result.error.message}`,
        payload: {
          error: result.error.message,
          max_suggestions: maxSuggestions
        }
      });

      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const data = result.data as {
      ok: boolean;
      batch_id?: string;
      suggestions?: AlignmentSuggestion[];
      count?: number;
      social_context?: SocialLoadCheck;
      reason?: string;
      message?: string;
      error?: string;
    };

    if (!data.ok) {
      // Check if it's a social overload situation (not an error)
      if (data.reason === 'social_energy_low') {
        await emitOasisEvent({
          vtid: VTID,
          type: 'social_alignment.generated',
          source: 'gateway-d47',
          status: 'info',
          message: 'No suggestions generated due to low social energy',
          payload: {
            reason: data.reason,
            message: data.message
          }
        });

        return {
          ok: true,
          batch_id: undefined,
          suggestions: [],
          count: 0,
          social_context: {
            social_energy: 0,
            passed: false,
            reason: 'social_energy_low'
          },
          processing_time_ms: Date.now() - startTime
        };
      }

      return {
        ok: false,
        error: data.error,
        message: data.message
      };
    }

    const duration = Date.now() - startTime;

    // Emit OASIS event for successful generation
    await emitOasisEvent({
      vtid: VTID,
      type: 'social_alignment.generated',
      source: 'gateway-d47',
      status: 'success',
      message: `Generated ${data.count || 0} suggestions in ${duration}ms`,
      payload: {
        batch_id: data.batch_id,
        count: data.count,
        domains_requested: alignmentDomains,
        min_relevance: minRelevance,
        min_shared_signals: minSharedSignals,
        duration_ms: duration
      }
    });

    console.log(`${LOG_PREFIX} Generated ${data.count || 0} suggestions in ${duration}ms`);

    return {
      ok: true,
      batch_id: data.batch_id,
      suggestions: data.suggestions || [],
      count: data.count || 0,
      social_context: data.social_context,
      processing_time_ms: duration
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error generating suggestions:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'social_alignment.error',
      source: 'gateway-d47',
      status: 'error',
      message: `Suggestion generation error: ${errorMessage}`,
      payload: { error: errorMessage }
    });

    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Get current alignment suggestions for a user
 *
 * @param request - Query parameters
 * @param authToken - JWT token for authenticated requests
 * @returns Current suggestions
 */
export async function getSuggestions(
  request: GetSuggestionsRequest,
  authToken?: string
): Promise<GetSuggestionsResponse> {
  try {
    let supabase: SupabaseClient | null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    } else {
      return {
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication required'
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    // Prepare parameters
    const status = request.status || ['pending', 'shown'];
    const alignmentDomains = request.alignment_domains || null;
    const limit = request.limit || 10;

    // Call RPC to get suggestions
    const result = await supabase.rpc('alignment_get_suggestions', {
      p_status: status,
      p_alignment_domains: alignmentDomains,
      p_limit: limit
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const data = result.data as {
      ok: boolean;
      suggestions?: AlignmentSuggestion[];
      count?: number;
      error?: string;
      message?: string;
    };

    if (!data.ok) {
      return {
        ok: false,
        error: data.error,
        message: data.message
      };
    }

    return {
      ok: true,
      suggestions: data.suggestions || [],
      count: data.count || 0
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting suggestions:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Mark a suggestion as shown to the user
 *
 * @param request - Suggestion ID
 * @param authToken - JWT token for authenticated requests
 * @returns Update result
 */
export async function markSuggestionShown(
  request: MarkShownRequest,
  authToken?: string
): Promise<MarkShownResponse> {
  try {
    let supabase: SupabaseClient | null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    } else {
      return {
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication required'
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    // Call RPC to mark shown
    const result = await supabase.rpc('alignment_mark_shown', {
      p_suggestion_id: request.suggestion_id
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const data = result.data as {
      ok: boolean;
      suggestion_id?: string;
      status?: AlignmentStatus;
      error?: string;
      message?: string;
    };

    if (!data.ok) {
      return {
        ok: false,
        error: data.error,
        message: data.message
      };
    }

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'social_alignment.shown',
      source: 'gateway-d47',
      status: 'success',
      message: `Suggestion ${request.suggestion_id} marked as shown`,
      payload: {
        suggestion_id: request.suggestion_id
      }
    });

    return {
      ok: true,
      suggestion_id: data.suggestion_id,
      status: data.status
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error marking suggestion shown:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Record user action on a suggestion
 *
 * @param request - Action details
 * @param authToken - JWT token for authenticated requests
 * @returns Action result
 */
export async function actOnSuggestion(
  request: ActOnSuggestionRequest,
  authToken?: string
): Promise<ActOnSuggestionResponse> {
  try {
    let supabase: SupabaseClient | null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    } else {
      return {
        ok: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication required'
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    if (useDevIdentity) {
      await bootstrapDevContext(supabase);
    }

    // Call RPC to record action
    const result = await supabase.rpc('alignment_act_on_suggestion', {
      p_suggestion_id: request.suggestion_id,
      p_action: request.action,
      p_feedback: request.feedback || null
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const data = result.data as {
      ok: boolean;
      suggestion_id?: string;
      action?: AlignmentAction;
      status?: AlignmentStatus;
      error?: string;
      message?: string;
    };

    if (!data.ok) {
      return {
        ok: false,
        error: data.error,
        message: data.message
      };
    }

    // Emit appropriate OASIS event
    const eventType = request.action === 'not_now'
      ? 'social_alignment.dismissed'
      : 'social_alignment.acted';

    await emitOasisEvent({
      vtid: VTID,
      type: eventType,
      source: 'gateway-d47',
      status: 'success',
      message: `Suggestion ${request.suggestion_id} action: ${request.action}`,
      payload: {
        suggestion_id: request.suggestion_id,
        action: request.action,
        status: data.status,
        has_feedback: !!request.feedback
      }
    });

    console.log(`${LOG_PREFIX} Suggestion ${request.suggestion_id} action: ${request.action}`);

    return {
      ok: true,
      suggestion_id: data.suggestion_id,
      action: data.action,
      status: data.status
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error recording action:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Cleanup expired suggestions (service job)
 *
 * @param authToken - JWT token for authenticated requests
 * @returns Cleanup result
 */
export async function cleanupExpiredSuggestions(
  authToken?: string
): Promise<{ ok: boolean; expired_count?: number; error?: string; message?: string }> {
  try {
    let supabase: SupabaseClient | null;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else {
      supabase = createServiceClient();
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    // Call RPC to cleanup
    const result = await supabase.rpc('alignment_cleanup_expired');

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const data = result.data as {
      ok: boolean;
      expired_count: number;
    };

    if (data.expired_count > 0) {
      await emitOasisEvent({
        vtid: VTID,
        type: 'social_alignment.expired',
        source: 'gateway-d47',
        status: 'info',
        message: `Expired ${data.expired_count} suggestions`,
        payload: {
          expired_count: data.expired_count
        }
      });

      console.log(`${LOG_PREFIX} Cleanup: ${data.expired_count} suggestions expired`);
    }

    return {
      ok: true,
      expired_count: data.expired_count
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error cleaning up suggestions:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

// =============================================================================
// Local Matching Logic (for gateway-side processing)
// =============================================================================

/**
 * Score a candidate locally (without database)
 *
 * This is used for additional filtering or re-ranking at the gateway level.
 *
 * @param candidate - Candidate to score
 * @param thresholds - Matching thresholds
 * @returns Match result
 */
export function scoreCandidate(
  candidate: AlignmentCandidate,
  thresholds: AlignmentThresholds = DEFAULT_ALIGNMENT_THRESHOLDS
): AlignmentMatchResult {
  const signals: AlignmentSignalRef[] = [];

  // Add domain signal
  if (candidate.domain) {
    signals.push({
      type: 'interest',
      ref: `domain:${candidate.domain}`
    });
  }

  // Add strength-based signals
  if (candidate.strength >= 50) {
    signals.push({
      type: 'behavior',
      ref: 'strong_connection'
    });
  }

  // Add recency signals
  if (candidate.last_seen) {
    const lastSeenDate = new Date(candidate.last_seen);
    const daysSince = (Date.now() - lastSeenDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince <= 7) {
      signals.push({
        type: 'behavior',
        ref: 'recent_interaction'
      });
    }
  }

  // Calculate scores
  const relevanceScore = calculateRelevanceScore(signals, candidate.strength);
  const recentInteraction = candidate.last_seen
    ? new Date(candidate.last_seen) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    : false;
  const confidence = calculateConfidenceScore(signals.length, recentInteraction, candidate.strength);

  // Determine domain
  const alignmentDomain = mapNodeTypeToAlignmentDomain(candidate.node_type);

  // Generate why_now
  const whyNow = generateWhyNow(
    alignmentDomain,
    signals,
    candidate.strength,
    candidate.last_seen
  );

  // Check thresholds
  const passes = passesMatchingThresholds(relevanceScore, signals.length, thresholds);

  return {
    candidate,
    relevance_score: relevanceScore,
    confidence,
    shared_signals: signals,
    why_now: whyNow,
    alignment_domain: alignmentDomain,
    passes_thresholds: passes
  };
}

/**
 * Filter and rank candidates
 *
 * @param candidates - Candidates to process
 * @param thresholds - Matching thresholds
 * @returns Filtered and ranked results
 */
export function filterAndRankCandidates(
  candidates: AlignmentCandidate[],
  thresholds: AlignmentThresholds = DEFAULT_ALIGNMENT_THRESHOLDS
): AlignmentMatchResult[] {
  // Score all candidates
  const results = candidates.map(c => scoreCandidate(c, thresholds));

  // Filter by thresholds
  const passing = results.filter(r => r.passes_thresholds);

  // Sort by relevance score descending, then confidence
  passing.sort((a, b) => {
    if (b.relevance_score !== a.relevance_score) {
      return b.relevance_score - a.relevance_score;
    }
    return b.confidence - a.confidence;
  });

  return passing;
}

// =============================================================================
// Exports
// =============================================================================

export {
  mapNodeTypeToAlignmentDomain,
  calculateRelevanceScore,
  calculateConfidenceScore,
  generateWhyNow,
  passesMatchingThresholds
};

export type {
  AlignmentSuggestion,
  AlignmentDomain,
  AlignmentAction,
  AlignmentStatus,
  AlignmentSignalRef,
  AlignmentThresholds,
  SocialLoadCheck,
  AlignmentCandidate,
  AlignmentMatchResult,
  GenerateSuggestionsRequest,
  GenerateSuggestionsResponse,
  GetSuggestionsRequest,
  GetSuggestionsResponse,
  MarkShownRequest,
  MarkShownResponse,
  ActOnSuggestionRequest,
  ActOnSuggestionResponse
};
