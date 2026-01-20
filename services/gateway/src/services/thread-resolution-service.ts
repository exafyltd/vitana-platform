/**
 * VTID-01192: Thread Resolution Service
 *
 * Manages thread ID resolution for ORB conversations.
 * Ensures continuity across device switches and sessions.
 *
 * Key Features:
 * - Resolves thread ID from provided value or active session
 * - 4-hour timeout for session resumption
 * - Voice-first safe: no client-side thread storage required
 *
 * Thread vs Session:
 * - Thread = long-term conversation identity (days/weeks)
 * - Session = active engagement window (4 hours default)
 * - Facts span ALL threads for a user (infinite memory)
 * - Thread determines "which conversation am I continuing?"
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Configuration
// =============================================================================

const VTID = 'VTID-01192';
const SERVICE_NAME = 'thread-resolution-service';

// Default session timeout (hours)
const DEFAULT_SESSION_TIMEOUT_HOURS = 4;

// =============================================================================
// Types
// =============================================================================

export interface ThreadResolutionRequest {
  tenant_id: string;
  user_id: string;
  active_role?: string;
  provided_thread_id?: string;
  session_timeout_hours?: number;
}

export interface ThreadResolutionResult {
  ok: boolean;
  thread_id: string;
  is_new: boolean;
  resumed: boolean;
  turn_count: number;
  error?: string;
}

export interface ThreadTurnResult {
  ok: boolean;
  turn_count: number;
  error?: string;
}

// =============================================================================
// Supabase Client
// =============================================================================

function createServiceClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn(`[${VTID}] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// =============================================================================
// Thread Resolution
// =============================================================================

/**
 * Resolve thread ID for a conversation session.
 *
 * Resolution order:
 * 1. If thread_id provided → use it (client knows the thread)
 * 2. If active thread exists within timeout → resume it
 * 3. Create new thread
 *
 * @param request Thread resolution request
 * @returns Resolved thread ID and metadata
 */
export async function resolveThreadId(
  request: ThreadResolutionRequest
): Promise<ThreadResolutionResult> {
  const startTime = Date.now();

  const supabase = createServiceClient();
  if (!supabase) {
    return {
      ok: false,
      thread_id: '',
      is_new: false,
      resumed: false,
      turn_count: 0,
      error: 'Supabase not configured'
    };
  }

  try {
    const { data, error } = await supabase.rpc('resolve_thread_id', {
      p_tenant_id: request.tenant_id,
      p_user_id: request.user_id,
      p_active_role: request.active_role || 'user',
      p_provided_thread_id: request.provided_thread_id || null,
      p_session_timeout_hours: request.session_timeout_hours || DEFAULT_SESSION_TIMEOUT_HOURS
    });

    if (error) {
      console.error(`[${VTID}] Thread resolution failed:`, error.message);

      await emitOasisEvent({
        vtid: VTID,
        type: 'memory.thread.resolution.failed' as any,
        source: SERVICE_NAME,
        status: 'error',
        message: `Thread resolution failed: ${error.message}`,
        payload: {
          tenant_id: request.tenant_id,
          user_id: request.user_id,
          error: error.message,
          duration_ms: Date.now() - startTime
        }
      });

      return {
        ok: false,
        thread_id: '',
        is_new: false,
        resumed: false,
        turn_count: 0,
        error: error.message
      };
    }

    const result = data[0];

    // Emit success event
    await emitOasisEvent({
      vtid: VTID,
      type: 'memory.thread.resolved' as any,
      source: SERVICE_NAME,
      status: 'success',
      message: `Thread resolved: ${result.thread_id}`,
      payload: {
        tenant_id: request.tenant_id,
        user_id: request.user_id,
        thread_id: result.thread_id,
        is_new: result.is_new,
        resumed: result.resumed,
        turn_count: result.turn_count,
        duration_ms: Date.now() - startTime
      }
    });

    console.log(`[${VTID}] Thread resolved: ${result.thread_id} (new=${result.is_new}, resumed=${result.resumed})`);

    return {
      ok: true,
      thread_id: result.thread_id,
      is_new: result.is_new,
      resumed: result.resumed,
      turn_count: result.turn_count
    };
  } catch (err: any) {
    console.error(`[${VTID}] Thread resolution error:`, err.message);

    return {
      ok: false,
      thread_id: '',
      is_new: false,
      resumed: false,
      turn_count: 0,
      error: err.message
    };
  }
}

/**
 * Increment turn count for a thread.
 *
 * @param tenant_id Tenant ID
 * @param user_id User ID
 * @param thread_id Thread ID
 * @returns New turn count
 */
export async function incrementThreadTurn(
  tenant_id: string,
  user_id: string,
  thread_id: string
): Promise<ThreadTurnResult> {
  const supabase = createServiceClient();
  if (!supabase) {
    return {
      ok: false,
      turn_count: 0,
      error: 'Supabase not configured'
    };
  }

  try {
    const { data, error } = await supabase.rpc('increment_thread_turn', {
      p_tenant_id: tenant_id,
      p_user_id: user_id,
      p_thread_id: thread_id
    });

    if (error) {
      console.error(`[${VTID}] Turn increment failed:`, error.message);
      return {
        ok: false,
        turn_count: 0,
        error: error.message
      };
    }

    return {
      ok: true,
      turn_count: data || 0
    };
  } catch (err: any) {
    return {
      ok: false,
      turn_count: 0,
      error: err.message
    };
  }
}

/**
 * Get thread summary (latest version).
 *
 * @param thread_id Thread ID
 * @param summary_type 'short' or 'long'
 * @returns Summary text and metadata
 */
export async function getThreadSummary(
  thread_id: string,
  summary_type: 'short' | 'long' = 'short'
): Promise<{
  ok: boolean;
  summary_text?: string;
  version?: number;
  covers_turns_to?: number;
  error?: string;
}> {
  const supabase = createServiceClient();
  if (!supabase) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const { data, error } = await supabase.rpc('get_thread_summary', {
      p_thread_id: thread_id,
      p_summary_type: summary_type
    });

    if (error) {
      return { ok: false, error: error.message };
    }

    if (!data || data.length === 0) {
      return { ok: true }; // No summary yet, which is fine
    }

    const result = data[0];
    return {
      ok: true,
      summary_text: result.summary_text,
      version: result.version,
      covers_turns_to: result.covers_turns_to
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// =============================================================================
// Exports
// =============================================================================

export default {
  resolveThreadId,
  incrementThreadTurn,
  getThreadSummary
};
