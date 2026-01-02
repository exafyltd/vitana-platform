/**
 * VTID-01124: D40 Life Stage, Goals & Trajectory Awareness Engine
 *
 * Deterministic engine that understands where the user is in their life journey
 * and aligns intelligence with long-term goals, not just immediate desires.
 *
 * D40 ensures recommendations are coherent across time, helping the user move
 * along a meaningful trajectory rather than reacting randomly.
 *
 * It answers: "Given who this person is becoming, what makes sense now?"
 *
 * Hard Constraints (from spec):
 *   - NEVER impose goals
 *   - NEVER shame deviations
 *   - Treat goals as evolving, not fixed
 *   - Allow conscious contradictions when user chooses
 *   - Keep goal inference transparent and correctable
 *
 * Determinism Rules:
 *   - Same inputs -> same life stage output
 *   - No generative interpretation
 *   - Rule-based inference only
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import {
  LifeStageBundle,
  LifeStageAssessInput,
  LifeStageAssessResponse,
  GetCurrentLifeStageResponse,
  LifeStageOverrideResponse,
  LifeStageExplainResponse,
  GoalSet,
  UserGoal,
  GoalOperationResponse,
  GoalDetectInput,
  TrajectoryScoreInput,
  TrajectoryScoreResponse,
  TrajectoryAction,
  OrbLifeStageContext,
  toOrbContext,
  formatLifeStageContextForPrompt
} from '../types/life-stage-awareness';

// =============================================================================
// Constants
// =============================================================================

const VTID = 'VTID-01124';
const LOG_PREFIX = '[D40-Engine]';

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
// D40 Engine Core Functions
// =============================================================================

/**
 * Assess life stage from user context and history
 *
 * This is the main entry point for life stage assessment.
 * Uses the database RPC for deterministic rule-based inference.
 *
 * @param input - Life stage assessment input
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Life stage assessment response
 */
export async function assessLifeStage(
  input: LifeStageAssessInput,
  authToken?: string
): Promise<LifeStageAssessResponse> {
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
        message: 'Authentication required for life stage assessment'
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
      p_session_id: input.session_id || null,
      p_include_goals: input.include_goals ?? true,
      p_include_trajectory: input.include_trajectory ?? false,
      p_context_window_days: input.context_window_days || 30
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

    const result = await supabase.rpc('life_stage_assess', rpcParams);

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error:`, result.error);

      await emitOasisEvent({
        vtid: VTID,
        type: 'd40.life_stage.assess.failed',
        source: 'gateway-d40',
        status: 'error',
        message: `Life stage assessment failed: ${result.error.message}`,
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

    const response = result.data as LifeStageAssessResponse;
    const duration = Date.now() - startTime;

    // Emit OASIS event for traceability
    await emitOasisEvent({
      vtid: VTID,
      type: 'd40.life_stage.assessed',
      source: 'gateway-d40',
      status: 'success',
      message: `Life stage assessed for session ${input.session_id || 'N/A'}`,
      payload: {
        session_id: input.session_id,
        rules_applied_count: response.rules_applied?.length || 0,
        duration_ms: duration,
        phase: response.life_stage?.phase,
        stability: response.life_stage?.stability_level,
        transition_flag: response.life_stage?.transition_flag,
        goal_count: response.goal_set?.goals.length || 0
      }
    });

    console.log(`${LOG_PREFIX} Assessed life stage in ${duration}ms, rules=${response.rules_applied?.length || 0}`);

    return response;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error assessing life stage:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd40.life_stage.assess.failed',
      source: 'gateway-d40',
      status: 'error',
      message: `Life stage assessment error: ${errorMessage}`,
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
 * Get current life stage assessment for a user
 *
 * @param sessionId - Optional session ID
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Current life stage if available
 */
export async function getCurrentLifeStage(
  sessionId?: string,
  authToken?: string
): Promise<GetCurrentLifeStageResponse> {
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
        message: 'Authentication required',
        needs_refresh: true
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database',
        needs_refresh: true
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

    const result = await supabase.rpc('life_stage_get_current', {
      p_session_id: sessionId || null
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (get_current):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message,
        needs_refresh: true
      };
    }

    return result.data as GetCurrentLifeStageResponse;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting current life stage:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage,
      needs_refresh: true
    };
  }
}

/**
 * Override a life stage assessment with user correction
 *
 * User corrections immediately override assessments (spec requirement).
 * This ensures users never feel "profiled" against their will.
 *
 * @param assessmentId - ID of the assessment to override
 * @param override - Override data from user
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Override result
 */
export async function overrideLifeStage(
  assessmentId: string,
  override: Record<string, unknown>,
  authToken?: string
): Promise<LifeStageOverrideResponse> {
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

    const result = await supabase.rpc('life_stage_override', {
      p_assessment_id: assessmentId,
      p_override: override
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (override):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const response = result.data as LifeStageOverrideResponse;

    // Emit OASIS event for user override
    await emitOasisEvent({
      vtid: VTID,
      type: 'd40.life_stage.overridden',
      source: 'gateway-d40',
      status: 'info',
      message: `Life stage assessment ${assessmentId} overridden by user correction`,
      payload: {
        assessment_id: assessmentId,
        override
      }
    });

    console.log(`${LOG_PREFIX} Assessment ${assessmentId} overridden by user`);

    return response;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error overriding life stage:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Get detailed explanation for a life stage assessment (D59 support)
 *
 * Returns full evidence trail and rules that fired for explainability.
 *
 * @param assessmentId - ID of the assessment to explain
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Detailed assessment explanation
 */
export async function explainLifeStage(
  assessmentId: string,
  authToken?: string
): Promise<LifeStageExplainResponse> {
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

    const result = await supabase.rpc('life_stage_explain', {
      p_assessment_id: assessmentId
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (explain):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    return result.data as LifeStageExplainResponse;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error explaining life stage:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

// =============================================================================
// Goal Management Functions
// =============================================================================

/**
 * Detect and register a goal from user input
 *
 * @param input - Goal detection input
 * @param authToken - Optional JWT token
 * @returns Goal operation response
 */
export async function detectGoal(
  input: GoalDetectInput,
  authToken?: string
): Promise<GoalOperationResponse> {
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
      const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
        p_tenant_id: DEV_IDENTITY.TENANT_ID,
        p_active_role: 'developer'
      });
      if (bootstrapError) {
        console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, bootstrapError.message);
      }
    }

    const result = await supabase.rpc('life_stage_detect_goal', {
      p_message: input.message || null,
      p_session_id: input.session_id || null,
      p_source: input.source
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (detect_goal):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    const response = result.data as GoalOperationResponse;

    if (response.ok && response.goal) {
      await emitOasisEvent({
        vtid: VTID,
        type: 'd40.goal.detected',
        source: 'gateway-d40',
        status: 'success',
        message: `Goal detected: ${response.goal.category}`,
        payload: {
          goal_id: response.goal.id,
          category: response.goal.category,
          explicit: response.goal.explicit,
          source: input.source
        }
      });
    }

    return response;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error detecting goal:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Get all goals for a user
 *
 * @param authToken - Optional JWT token
 * @returns Goal operation response with all goals
 */
export async function getGoals(
  authToken?: string
): Promise<GoalOperationResponse> {
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
      const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
        p_tenant_id: DEV_IDENTITY.TENANT_ID,
        p_active_role: 'developer'
      });
      if (bootstrapError) {
        console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, bootstrapError.message);
      }
    }

    const result = await supabase.rpc('life_stage_get_goals');

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (get_goals):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    return result.data as GoalOperationResponse;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error getting goals:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Update a goal
 *
 * @param goalId - ID of goal to update
 * @param updates - Fields to update
 * @param authToken - Optional JWT token
 * @returns Goal operation response
 */
export async function updateGoal(
  goalId: string,
  updates: Partial<UserGoal>,
  authToken?: string
): Promise<GoalOperationResponse> {
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
      const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
        p_tenant_id: DEV_IDENTITY.TENANT_ID,
        p_active_role: 'developer'
      });
      if (bootstrapError) {
        console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, bootstrapError.message);
      }
    }

    const result = await supabase.rpc('life_stage_update_goal', {
      p_goal_id: goalId,
      p_updates: updates
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (update_goal):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message
      };
    }

    return result.data as GoalOperationResponse;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error updating goal:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

// =============================================================================
// Trajectory Scoring Functions
// =============================================================================

/**
 * Score proposed actions against user goals and trajectory
 *
 * @param input - Trajectory score input with proposed actions
 * @param authToken - Optional JWT token
 * @returns Trajectory score response
 */
export async function scoreTrajectory(
  input: TrajectoryScoreInput,
  authToken?: string
): Promise<TrajectoryScoreResponse> {
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
        message: 'Authentication required',
        overall_coherence: 0,
        conflicts_detected: 0,
        multi_goal_opportunities: 0
      };
    }

    if (!supabase) {
      return {
        ok: false,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Unable to connect to database',
        overall_coherence: 0,
        conflicts_detected: 0,
        multi_goal_opportunities: 0
      };
    }

    if (useDevIdentity) {
      const { error: bootstrapError } = await supabase.rpc('dev_bootstrap_request_context', {
        p_tenant_id: DEV_IDENTITY.TENANT_ID,
        p_active_role: 'developer'
      });
      if (bootstrapError) {
        console.warn(`${LOG_PREFIX} Bootstrap context failed (non-fatal):`, bootstrapError.message);
      }
    }

    const result = await supabase.rpc('life_stage_score_trajectory', {
      p_actions: input.actions,
      p_session_id: input.session_id || null,
      p_include_trade_offs: input.include_trade_offs ?? true
    });

    if (result.error) {
      console.error(`${LOG_PREFIX} RPC error (score_trajectory):`, result.error);
      return {
        ok: false,
        error: result.error.code || 'RPC_ERROR',
        message: result.error.message,
        overall_coherence: 0,
        conflicts_detected: 0,
        multi_goal_opportunities: 0
      };
    }

    return result.data as TrajectoryScoreResponse;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error scoring trajectory:`, errorMessage);
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage,
      overall_coherence: 0,
      conflicts_detected: 0,
      multi_goal_opportunities: 0
    };
  }
}

// =============================================================================
// ORB Integration Functions
// =============================================================================

/**
 * Get life stage context for ORB system prompt injection
 *
 * This function fetches current life stage and formats it for
 * injection into the ORB system prompt to modulate:
 * - Recommendation style (exploratory, supportive, optimization, transitional)
 * - Commitment level (low_pressure, moderate, high_commitment)
 * - Horizon focus (short_term, medium_term, long_term)
 *
 * @param sessionId - Session ID to get context for
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Formatted context string for system prompt, or null if no data
 */
export async function getOrbLifeStageContext(
  sessionId?: string,
  authToken?: string
): Promise<{ context: string; orbContext: OrbLifeStageContext } | null> {
  try {
    const result = await getCurrentLifeStage(sessionId, authToken);

    if (!result.ok || !result.life_stage) {
      return null;
    }

    // Convert to ORB context
    const orbContext = toOrbContext(result.life_stage, result.goal_set);

    // Format for prompt injection
    const context = formatLifeStageContextForPrompt(orbContext);

    return { context, orbContext };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error getting ORB life stage context:`, error);
    return null;
  }
}

/**
 * Process and assess life stage with ORB-ready context
 *
 * Convenience function that:
 * 1. Assesses life stage from current context
 * 2. Returns formatted context for prompt injection
 *
 * @param sessionId - Session ID
 * @param authToken - Optional JWT token
 * @returns Life stage context for ORB, or null if assessment failed
 */
export async function processForOrb(
  sessionId?: string,
  authToken?: string
): Promise<{ context: string; orbContext: OrbLifeStageContext; assessmentId?: string } | null> {
  try {
    const assessResult = await assessLifeStage({
      session_id: sessionId,
      include_goals: true,
      include_trajectory: false
    }, authToken);

    if (!assessResult.ok || !assessResult.life_stage) {
      console.warn(`${LOG_PREFIX} Life stage assessment failed or empty`);
      return null;
    }

    // Convert to ORB context
    const orbContext = toOrbContext(assessResult.life_stage, assessResult.goal_set);

    // Format for prompt injection
    const context = formatLifeStageContextForPrompt(orbContext);

    return {
      context,
      orbContext,
      assessmentId: undefined // Would come from assessment if we stored it
    };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error processing for ORB:`, error);
    return null;
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  toOrbContext,
  formatLifeStageContextForPrompt
};

export type {
  LifeStageBundle,
  LifeStageAssessInput,
  LifeStageAssessResponse,
  GetCurrentLifeStageResponse,
  LifeStageOverrideResponse,
  LifeStageExplainResponse,
  GoalSet,
  UserGoal,
  GoalOperationResponse,
  TrajectoryAction,
  TrajectoryScoreResponse,
  OrbLifeStageContext
};
