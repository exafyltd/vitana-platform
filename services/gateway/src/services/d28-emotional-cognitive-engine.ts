/**
 * VTID-01120: D28 Emotional & Cognitive Signal Interpretation Engine
 *
 * Deterministic engine that interprets how the user is feeling and thinking
 * right now—without guessing, diagnosing, or overreaching.
 *
 * Intelligence responds to *state*, not just content.
 *
 * Hard Constraints (from spec):
 *   - NO medical or psychological diagnosis
 *   - NO permanent emotional labeling
 *   - NO autonomy escalation from signals alone
 *   - Signals only modulate tone, pacing, and depth
 *
 * Determinism Rules:
 *   - Same inputs → same signal output
 *   - No generative interpretation
 *   - Rule-based inference only
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  SignalBundle,
  SignalComputeInput,
  SignalComputeResponse,
  GetCurrentSignalsResponse,
  SignalOverrideResponse,
  SignalExplainResponse,
  OrbSignalContext,
  toOrbContext,
  formatSignalContextForPrompt,
  SignalRecord
} from '../types/emotional-cognitive';

// =============================================================================
// Constants
// =============================================================================

const VTID = 'VTID-01120';
const LOG_PREFIX = '[D28-Engine]';

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
// D28 Engine Core Functions
// =============================================================================

/**
 * Compute emotional & cognitive signals from user message
 *
 * This is the main entry point for signal computation.
 * Uses the database RPC for deterministic rule-based inference.
 *
 * @param input - Signal computation input
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Signal computation response with bundle and evidence
 */
export async function computeSignals(
  input: SignalComputeInput,
  authToken?: string
): Promise<SignalComputeResponse> {
  const startTime = Date.now();

  try {
    // Create Supabase client
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
        message: 'Authentication required for signal computation'
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database'
      };
    }

    // Call RPC function
    const rpcParams = {
      p_message: input.message,
      p_session_id: input.session_id || null,
      p_turn_id: input.turn_id || null,
      p_response_time_seconds: input.response_time_seconds || null,
      p_correction_count: input.correction_count || 0,
      p_interaction_count: input.interaction_count || 1
    };

    let result;
    if (useDevIdentity) {
      // For dev sandbox, use RPC with dev context
      result = await supabase.rpc('emotional_cognitive_compute', rpcParams, {
        headers: {
          'x-tenant-id': DEV_IDENTITY.TENANT_ID,
          'x-user-id': DEV_IDENTITY.USER_ID
        }
      });
    } else {
      result = await supabase.rpc('emotional_cognitive_compute', rpcParams);
    }

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);

      await emitOasisEvent({
        vtid: VTID,
        type: 'd28.signal.compute.failed',
        source: 'gateway-d28',
        status: 'error',
        message: `Signal computation failed: ${result.error.message}`,
        payload: {
          error: result.error.message,
          session_id: input.session_id
        }
      });

      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const response = result.data as SignalComputeResponse;
    const duration = Date.now() - startTime;

    // Emit OASIS event for traceability
    await emitOasisEvent({
      vtid: VTID,
      type: 'd28.signal.computed',
      source: 'gateway-d28',
      status: 'success',
      message: `Signals computed for session ${input.session_id || 'N/A'}`,
      payload: {
        session_id: input.session_id,
        turn_id: input.turn_id,
        rules_applied_count: response.rules_applied?.length || 0,
        duration_ms: duration,
        engagement_level: response.signal_bundle?.engagement_level,
        urgency_detected: response.signal_bundle?.urgency.detected,
        hesitation_detected: response.signal_bundle?.hesitation.detected
      }
    });

    console.log(`${LOG_PREFIX} Computed signals in ${duration}ms, rules=${response.rules_applied?.length || 0}`);

    return response;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing signals:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd28.signal.compute.failed',
      source: 'gateway-d28',
      status: 'error',
      message: `Signal computation error: ${errorMessage}`,
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
 * Get current (non-decayed) signals for a user/session
 *
 * @param sessionId - Optional session ID to filter signals
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Current active signals
 */
export async function getCurrentSignals(
  sessionId?: string,
  authToken?: string
): Promise<GetCurrentSignalsResponse> {
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

    let result;
    if (useDevIdentity) {
      result = await supabase.rpc('emotional_cognitive_get_current', {
        p_session_id: sessionId || null
      }, {
        headers: {
          'x-tenant-id': DEV_IDENTITY.TENANT_ID,
          'x-user-id': DEV_IDENTITY.USER_ID
        }
      });
    } else {
      result = await supabase.rpc('emotional_cognitive_get_current', {
        p_session_id: sessionId || null
      });
    }

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (get_current):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    return result.data as GetCurrentSignalsResponse;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting current signals:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Override a signal with user correction
 *
 * User corrections immediately override signals (spec requirement).
 * This is a safety mechanism to ensure users don't feel "psychoanalyzed".
 *
 * @param signalId - ID of the signal to override
 * @param override - Override data from user
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Override result
 */
export async function overrideSignal(
  signalId: string,
  override: Record<string, unknown>,
  authToken?: string
): Promise<SignalOverrideResponse> {
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

    let result;
    if (useDevIdentity) {
      result = await supabase.rpc('emotional_cognitive_override', {
        p_signal_id: signalId,
        p_override: override
      }, {
        headers: {
          'x-tenant-id': DEV_IDENTITY.TENANT_ID,
          'x-user-id': DEV_IDENTITY.USER_ID
        }
      });
    } else {
      result = await supabase.rpc('emotional_cognitive_override', {
        p_signal_id: signalId,
        p_override: override
      });
    }

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (override):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const response = result.data as SignalOverrideResponse;

    // Emit OASIS event for user override
    await emitOasisEvent({
      vtid: VTID,
      type: 'd28.signal.overridden',
      source: 'gateway-d28',
      status: 'info',
      message: `Signal ${signalId} overridden by user correction`,
      payload: {
        signal_id: signalId,
        override
      }
    });

    console.log(`${LOG_PREFIX} Signal ${signalId} overridden by user`);

    return response;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error overriding signal:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Get detailed explanation for a signal (D59 support)
 *
 * Returns full evidence trail and rules that fired for explainability.
 *
 * @param signalId - ID of the signal to explain
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Detailed signal explanation
 */
export async function explainSignal(
  signalId: string,
  authToken?: string
): Promise<SignalExplainResponse> {
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

    let result;
    if (useDevIdentity) {
      result = await supabase.rpc('emotional_cognitive_explain', {
        p_signal_id: signalId
      }, {
        headers: {
          'x-tenant-id': DEV_IDENTITY.TENANT_ID,
          'x-user-id': DEV_IDENTITY.USER_ID
        }
      });
    } else {
      result = await supabase.rpc('emotional_cognitive_explain', {
        p_signal_id: signalId
      });
    }

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (explain):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    return result.data as SignalExplainResponse;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error explaining signal:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

// =============================================================================
// ORB Integration Functions
// =============================================================================

/**
 * Get signal context for ORB system prompt injection
 *
 * This function fetches current signals and formats them for
 * injection into the ORB system prompt to modulate:
 * - Tone (calming, encouraging, patient, neutral)
 * - Pacing (slower, normal, match_energy)
 * - Depth (simplified, normal, detailed)
 *
 * @param sessionId - Session ID to get signals for
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Formatted context string for system prompt, or null if no signals
 */
export async function getOrbSignalContext(
  sessionId?: string,
  authToken?: string
): Promise<{ context: string; orbContext: OrbSignalContext } | null> {
  try {
    const result = await getCurrentSignals(sessionId, authToken);

    if (!result.ok || !result.signals || result.signals.length === 0) {
      return null;
    }

    // Get the most recent signal
    const latestSignal = result.signals[0];

    // Convert to SignalBundle format
    const bundle: SignalBundle = {
      emotional_states: latestSignal.emotional_states,
      cognitive_states: latestSignal.cognitive_states,
      engagement_level: latestSignal.engagement_level,
      engagement_confidence: latestSignal.engagement_confidence,
      urgency: latestSignal.urgency,
      hesitation: latestSignal.hesitation,
      decay_at: latestSignal.decay_at,
      disclaimer: latestSignal.disclaimer
    };

    // Convert to ORB context
    const orbContext = toOrbContext(bundle);

    // Format for prompt injection
    const context = formatSignalContextForPrompt(orbContext);

    return { context, orbContext };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error getting ORB signal context:`, error);
    return null;
  }
}

/**
 * Process a user message and compute signals inline
 *
 * This is a convenience function for ORB integration that:
 * 1. Computes signals from the message
 * 2. Returns formatted context for prompt injection
 *
 * @param message - User message to analyze
 * @param sessionId - Session ID
 * @param turnId - Turn ID
 * @param responseTimeSeconds - Time since last interaction
 * @param authToken - Optional JWT token
 * @returns Signal context for ORB, or null if computation failed
 */
export async function processMessageForOrb(
  message: string,
  sessionId?: string,
  turnId?: string,
  responseTimeSeconds?: number,
  authToken?: string
): Promise<{ context: string; orbContext: OrbSignalContext; signalId?: string } | null> {
  try {
    const computeResult = await computeSignals({
      message,
      session_id: sessionId,
      turn_id: turnId,
      response_time_seconds: responseTimeSeconds
    }, authToken);

    if (!computeResult.ok || !computeResult.signal_bundle) {
      console.warn(`${LOG_PREFIX} Signal computation failed or empty`);
      return null;
    }

    // Convert to ORB context
    const orbContext = toOrbContext(computeResult.signal_bundle);

    // Format for prompt injection
    const context = formatSignalContextForPrompt(orbContext);

    return {
      context,
      orbContext,
      signalId: computeResult.turn_id
    };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error processing message for ORB:`, error);
    return null;
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  toOrbContext,
  formatSignalContextForPrompt
};

export type {
  SignalBundle,
  SignalComputeInput,
  SignalComputeResponse,
  GetCurrentSignalsResponse,
  SignalOverrideResponse,
  SignalExplainResponse,
  OrbSignalContext
};
