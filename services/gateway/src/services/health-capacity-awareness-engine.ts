/**
 * VTID-01122: D37 Health State, Energy & Capacity Awareness Engine
 *
 * Understands the user's current physical and mental capacity to act —
 * without diagnosing, medicalizing, or overreaching.
 *
 * D37 ensures the system adapts WHAT it suggests and HOW it suggests it based on:
 * - Energy levels
 * - Fatigue signals
 * - Recovery state
 * - Mental load
 *
 * It answers: "Is the user capable of doing this right now — and at what intensity?"
 *
 * Hard Constraints (from spec):
 *   - NEVER diagnose or label conditions
 *   - NEVER push intensity upward when energy is low
 *   - Respect self-reported fatigue immediately
 *   - Health inference must always be reversible
 *   - Err on the side of rest and safety
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  CapacityStateBundle,
  ComputeCapacityRequest,
  ComputeCapacityResponse,
  GetCapacityResponse,
  OverrideCapacityRequest,
  OverrideCapacityResponse,
  FilterActionsRequest,
  FilterActionsResponse,
  CapacityEvidence,
  OrbCapacityContext,
  toOrbCapacityContext,
  formatCapacityContextForPrompt,
  EnergyState,
  HealthAlignedAction,
  CAPACITY_DISCLAIMER
} from '../types/health-capacity-awareness';

// =============================================================================
// Constants
// =============================================================================

const VTID = 'VTID-01122';
const LOG_PREFIX = '[D37-Engine]';

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
// D37 Engine Core Functions
// =============================================================================

/**
 * Compute capacity state from multiple signal sources
 *
 * This is the main entry point for capacity computation.
 * Integrates signals from:
 * - D26 (Longevity signals)
 * - D28 (Emotional/cognitive state)
 * - Circadian patterns
 * - Self-reported energy
 * - Interaction patterns
 *
 * @param input - Capacity computation input
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Capacity computation response with state bundle and evidence
 */
export async function computeCapacity(
  input: ComputeCapacityRequest,
  authToken?: string
): Promise<ComputeCapacityResponse> {
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
        message: 'Authentication required for capacity computation'
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
      p_message: input.message || null,
      p_session_id: input.session_id || null,
      p_self_reported_energy: input.self_reported_energy || null,
      p_self_reported_note: input.self_reported_note || null,
      p_include_wearables: input.include_wearables || false
    };

    // For dev sandbox, bootstrap the request context first
    if (useDevIdentity) {
      const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
        p_tenant_id: DEV_IDENTITY.TENANT_ID,
        p_active_role: 'developer'
      });
      if (bootstrapError) {
        console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, bootstrapError.message);
      }
    }

    const result = await supabase.rpc('capacity_compute', rpcParams);

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);

      await emitOasisEvent({
        vtid: VTID,
        type: 'd37.capacity.compute.failed',
        source: 'gateway-d37',
        status: 'error',
        message: `Capacity computation failed: ${result.error.message}`,
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

    const response = result.data as ComputeCapacityResponse;
    const duration = Date.now() - startTime;

    // Emit OASIS event for traceability
    await emitOasisEvent({
      vtid: VTID,
      type: 'd37.capacity.computed',
      source: 'gateway-d37',
      status: 'success',
      message: `Capacity computed for session ${input.session_id || 'N/A'}`,
      payload: {
        session_id: input.session_id,
        energy_state: response.capacity_state?.energy_state,
        energy_score: response.capacity_state?.energy_score,
        context_tags: response.capacity_state?.context_tags,
        duration_ms: duration
      }
    });

    // Check if low energy was detected
    if (response.capacity_state?.energy_state === 'low') {
      await emitOasisEvent({
        vtid: VTID,
        type: 'd37.low_energy.detected',
        source: 'gateway-d37',
        status: 'info',
        message: 'Low energy state detected - switching to restorative mode',
        payload: {
          session_id: input.session_id,
          energy_score: response.capacity_state?.energy_score,
          context_tags: response.capacity_state?.context_tags
        }
      });
    }

    console.log(`${LOG_PREFIX} Computed capacity in ${duration}ms, state=${response.capacity_state?.energy_state}`);

    return response;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing capacity:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd37.capacity.compute.failed',
      source: 'gateway-d37',
      status: 'error',
      message: `Capacity computation error: ${errorMessage}`,
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
 * Get current capacity state (checking for user overrides first)
 *
 * @param sessionId - Optional session ID to filter
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Current capacity state
 */
export async function getCurrentCapacity(
  sessionId?: string,
  authToken?: string
): Promise<GetCapacityResponse> {
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

    // For dev sandbox, bootstrap the request context first
    if (useDevIdentity) {
      const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
        p_tenant_id: DEV_IDENTITY.TENANT_ID,
        p_active_role: 'developer'
      });
      if (bootstrapError) {
        console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, bootstrapError.message);
      }
    }

    const result = await supabase.rpc('capacity_get_current', {
      p_session_id: sessionId || null
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (get_current):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    return result.data as GetCapacityResponse;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting current capacity:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Override capacity state with user correction
 *
 * User corrections immediately override all inferences (spec requirement).
 * This is a safety mechanism to ensure users have control.
 *
 * @param input - Override request
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Override result
 */
export async function overrideCapacity(
  input: OverrideCapacityRequest,
  authToken?: string
): Promise<OverrideCapacityResponse> {
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

    // For dev sandbox, bootstrap the request context first
    if (useDevIdentity) {
      const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
        p_tenant_id: DEV_IDENTITY.TENANT_ID,
        p_active_role: 'developer'
      });
      if (bootstrapError) {
        console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, bootstrapError.message);
      }
    }

    const result = await supabase.rpc('capacity_override', {
      p_energy_state: input.energy_state,
      p_note: input.note || null,
      p_duration_minutes: input.duration_minutes || 60
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (override):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const response = result.data as OverrideCapacityResponse;

    // Emit OASIS event for user override
    await emitOasisEvent({
      vtid: VTID,
      type: 'd37.capacity.overridden',
      source: 'gateway-d37',
      status: 'info',
      message: `Capacity overridden by user: ${input.energy_state}`,
      payload: {
        previous_state: response.previous_state,
        new_state: input.energy_state,
        expires_at: response.expires_at,
        note: input.note
      }
    });

    console.log(`${LOG_PREFIX} Capacity overridden: ${response.previous_state} -> ${input.energy_state}`);

    return response;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error overriding capacity:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Filter actions by current capacity
 *
 * This function filters and ranks actions based on the user's current
 * capacity state. Actions that exceed capacity are flagged, and
 * recommendations are adjusted accordingly.
 *
 * @param input - Filter actions request
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Filtered actions with capacity fit assessments
 */
export async function filterActions(
  input: FilterActionsRequest,
  authToken?: string
): Promise<FilterActionsResponse> {
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

    // For dev sandbox, bootstrap the request context first
    if (useDevIdentity) {
      const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
        p_tenant_id: DEV_IDENTITY.TENANT_ID,
        p_active_role: 'developer'
      });
      if (bootstrapError) {
        console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, bootstrapError.message);
      }
    }

    const result = await supabase.rpc('capacity_filter_actions', {
      p_actions: input.actions,
      p_respect_capacity: input.respect_capacity ?? true
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (filter_actions):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const response = result.data as FilterActionsResponse;

    // Emit OASIS event for action filtering
    if (response.blocked_count && response.blocked_count > 0) {
      await emitOasisEvent({
        vtid: VTID,
        type: 'd37.actions.filtered',
        source: 'gateway-d37',
        status: 'info',
        message: `${response.blocked_count} actions filtered due to capacity constraints`,
        payload: {
          blocked_count: response.blocked_count,
          recommended_count: response.recommended_count,
          energy_state: response.capacity_state?.energy_state
        }
      });
    }

    return response;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error filtering actions:`, errorMessage);
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
 * Get capacity context for ORB system prompt injection
 *
 * This function fetches current capacity and formats it for
 * injection into the ORB system prompt to modulate:
 * - Suggestion intensity
 * - Commitment recommendations
 * - Social activity suggestions
 *
 * @param sessionId - Session ID to get capacity for
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Formatted context string for system prompt, or null if no data
 */
export async function getOrbCapacityContext(
  sessionId?: string,
  authToken?: string
): Promise<{ context: string; orbContext: OrbCapacityContext } | null> {
  try {
    const result = await getCurrentCapacity(sessionId, authToken);

    if (!result.ok || !result.capacity_state) {
      return null;
    }

    // Convert to ORB context
    const orbContext = toOrbCapacityContext(result.capacity_state);

    // Format for prompt injection
    const context = formatCapacityContextForPrompt(orbContext);

    return { context, orbContext };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error getting ORB capacity context:`, error);
    return null;
  }
}

/**
 * Process a user message and compute capacity inline
 *
 * This is a convenience function for ORB integration that:
 * 1. Computes capacity from the message (detecting self-reported energy)
 * 2. Returns formatted context for prompt injection
 *
 * @param message - User message to analyze
 * @param sessionId - Session ID
 * @param authToken - Optional JWT token
 * @returns Capacity context for ORB, or null if computation failed
 */
export async function processMessageForOrb(
  message: string,
  sessionId?: string,
  authToken?: string
): Promise<{ context: string; orbContext: OrbCapacityContext } | null> {
  try {
    const computeResult = await computeCapacity({
      message,
      session_id: sessionId
    }, authToken);

    if (!computeResult.ok || !computeResult.capacity_state) {
      console.warn(`${LOG_PREFIX} Capacity computation failed or empty`);
      return null;
    }

    // Convert to ORB context
    const orbContext = toOrbCapacityContext(computeResult.capacity_state);

    // Format for prompt injection
    const context = formatCapacityContextForPrompt(orbContext);

    return { context, orbContext };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error processing message for ORB:`, error);
    return null;
  }
}

/**
 * Check if an action is appropriate for current capacity
 *
 * Quick utility to check if a single action is within capacity.
 *
 * @param action - Action identifier
 * @param intensity - Intensity level of the action
 * @param authToken - Optional JWT token
 * @returns Whether the action is recommended
 */
export async function isActionWithinCapacity(
  action: string,
  intensity: 'restorative' | 'light' | 'moderate' | 'high',
  authToken?: string
): Promise<{ ok: boolean; recommended: boolean; reason?: string }> {
  try {
    const result = await filterActions({
      actions: [{ action, intensity }],
      respect_capacity: true
    }, authToken);

    if (!result.ok || !result.filtered_actions || result.filtered_actions.length === 0) {
      return {
        ok: false,
        recommended: true, // Default to allowing if we can't check
        reason: 'Unable to check capacity'
      };
    }

    const filtered = result.filtered_actions[0];
    return {
      ok: true,
      recommended: filtered.recommended,
      reason: filtered.reason
    };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error checking action capacity:`, error);
    return {
      ok: false,
      recommended: true, // Default to allowing
      reason: 'Error checking capacity'
    };
  }
}

/**
 * Get a summary of current capacity for quick checks
 *
 * @param authToken - Optional JWT token
 * @returns Quick capacity summary
 */
export async function getCapacitySummary(
  authToken?: string
): Promise<{
  ok: boolean;
  energy_state: EnergyState;
  max_intensity: string;
  context_tags: string[];
  has_override: boolean;
  error?: string;
}> {
  try {
    const result = await getCurrentCapacity(undefined, authToken);

    if (!result.ok || !result.capacity_state) {
      return {
        ok: false,
        energy_state: 'unknown',
        max_intensity: 'moderate',
        context_tags: [],
        has_override: false,
        error: result.error || 'Unable to get capacity'
      };
    }

    return {
      ok: true,
      energy_state: result.capacity_state.energy_state as EnergyState,
      max_intensity: result.capacity_state.max_intensity as string,
      context_tags: result.capacity_state.context_tags as string[],
      has_override: result.has_override || false
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      energy_state: 'unknown',
      max_intensity: 'moderate',
      context_tags: [],
      has_override: false,
      error: errorMessage
    };
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  toOrbCapacityContext,
  formatCapacityContextForPrompt,
  CAPACITY_DISCLAIMER
};

export type {
  CapacityStateBundle,
  ComputeCapacityRequest,
  ComputeCapacityResponse,
  GetCapacityResponse,
  OverrideCapacityRequest,
  OverrideCapacityResponse,
  FilterActionsRequest,
  FilterActionsResponse,
  CapacityEvidence,
  OrbCapacityContext,
  EnergyState,
  HealthAlignedAction
};
