/**
 * Autopilot Loop Store - VTID-01179
 *
 * Supabase persistence wrapper for the autopilot event loop.
 * Handles crash-safe state persistence including:
 * - Loop state (cursor, running status, stats)
 * - Processed events (for idempotency/dedup)
 * - Per-VTID run state (for action coordination)
 *
 * Design principles:
 * - All operations are idempotent
 * - Crash-safe cursor tracking
 * - Exponential backoff support via lock_until
 */

import { AutopilotState } from './autopilot-controller';

// =============================================================================
// Types
// =============================================================================

/**
 * Loop state record from autopilot_loop_state table
 */
export interface LoopState {
  id: string;
  environment: string;
  last_event_cursor: string | null;
  last_event_timestamp: string | null;
  is_running: boolean;
  started_at: string | null;
  stopped_at: string | null;
  poll_interval_ms: number;
  batch_size: number;
  events_processed_total: number;
  events_processed_1h: number;
  errors_1h: number;
  last_error: string | null;
  last_error_at: string | null;
  updated_at: string;
}

/**
 * Processed event record
 */
export interface ProcessedEvent {
  event_id: string;
  vtid: string | null;
  event_type: string;
  event_timestamp: string | null;
  processed_at: string;
  result: Record<string, unknown>;
  action_triggered: string | null;
  transition_from: string | null;
  transition_to: string | null;
  error: string | null;
  raw_event: Record<string, unknown> | null;
}

/**
 * Per-VTID run state record
 */
export interface RunState {
  vtid: string;
  state: AutopilotState;
  run_id: string | null;
  started_at: string;
  last_transition_at: string;
  completed_at: string | null;
  last_event_id: string | null;
  last_event_type: string | null;
  pr_number: number | null;
  pr_url: string | null;
  merge_sha: string | null;
  attempts: ActionAttempts;
  max_attempts: number;
  lock_until: string | null;
  locked_by: string | null;
  validator_passed: boolean | null;
  validator_result: Record<string, unknown> | null;
  verification_passed: boolean | null;
  verification_result: Record<string, unknown> | null;
  error: string | null;
  error_code: string | null;
  error_at: string | null;
  spec_checksum: string | null;
  metadata: Record<string, unknown>;
  updated_at: string;
}

/**
 * Action attempt counters
 */
export interface ActionAttempts {
  dispatch: number;
  create_pr: number;
  validate: number;
  merge: number;
  verify: number;
}

/**
 * Loop statistics for status endpoint
 */
export interface LoopStats {
  is_running: boolean;
  poll_interval_ms: number;
  last_cursor: string | null;
  last_event_timestamp: string | null;
  events_processed_total: number;
  processed_1h: number;
  errors_1h: number;
  active_runs: number;
  runs_by_state: Record<string, number>;
}

// =============================================================================
// Configuration
// =============================================================================

const LOOP_ID = 'gateway';
const LOG_PREFIX = '[VTID-01179]';

// =============================================================================
// Supabase Helpers
// =============================================================================

function getSupabaseCredentials(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !key) {
    console.warn(`${LOG_PREFIX} Missing Supabase credentials`);
    return null;
  }

  return { url, key };
}

async function supabaseRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const creds = getSupabaseCredentials();
  if (!creds) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  const { method = 'GET', body, headers = {} } = options;

  try {
    const response = await fetch(`${creds.url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': creds.key,
        'Authorization': `Bearer ${creds.key}`,
        'Prefer': 'return=representation',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Loop State Operations
// =============================================================================

/**
 * Get the current loop state
 */
export async function getLoopState(): Promise<LoopState | null> {
  const result = await supabaseRequest<LoopState[]>(
    `/rest/v1/autopilot_loop_state?id=eq.${LOOP_ID}&select=*`
  );

  if (!result.ok || !result.data || result.data.length === 0) {
    return null;
  }

  return result.data[0];
}

/**
 * Update loop running status
 */
export async function setLoopRunning(running: boolean): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const body: Partial<LoopState> = {
    is_running: running,
    updated_at: timestamp,
    ...(running ? { started_at: timestamp } : { stopped_at: timestamp }),
  };

  const result = await supabaseRequest(
    `/rest/v1/autopilot_loop_state?id=eq.${LOOP_ID}`,
    { method: 'PATCH', body }
  );

  if (result.ok) {
    console.log(`${LOG_PREFIX} Loop ${running ? 'started' : 'stopped'}`);
  }

  return result.ok;
}

/**
 * Update loop cursor position
 */
export async function updateLoopCursor(
  eventId: string,
  eventTimestamp: string
): Promise<boolean> {
  const result = await supabaseRequest(
    `/rest/v1/autopilot_loop_state?id=eq.${LOOP_ID}`,
    {
      method: 'PATCH',
      body: {
        last_event_cursor: eventId,
        last_event_timestamp: eventTimestamp,
        updated_at: new Date().toISOString(),
      },
    }
  );

  return result.ok;
}

/**
 * Reset loop cursor to a specific timestamp
 * VTID-01179: Manual cursor reset for catching up or skipping ahead
 */
export async function resetLoopCursor(
  timestamp: string,
  reason: string = 'manual-reset'
): Promise<boolean> {
  const result = await supabaseRequest(
    `/rest/v1/autopilot_loop_state?id=eq.${LOOP_ID}`,
    {
      method: 'PATCH',
      body: {
        last_event_cursor: `reset-${Date.now()}`,
        last_event_timestamp: timestamp,
        updated_at: new Date().toISOString(),
      },
    }
  );

  if (result.ok) {
    console.log(`${LOG_PREFIX} Cursor reset to ${timestamp} (reason: ${reason})`);
  } else {
    console.error(`${LOG_PREFIX} Failed to reset cursor: ${result.error}`);
  }

  return result.ok;
}

/**
 * Increment processed events counter
 */
export async function incrementProcessedCount(count: number = 1): Promise<boolean> {
  // Use raw SQL via RPC for atomic increment
  const result = await supabaseRequest(
    `/rest/v1/autopilot_loop_state?id=eq.${LOOP_ID}`,
    {
      method: 'PATCH',
      body: {
        updated_at: new Date().toISOString(),
      },
      headers: {
        'Prefer': 'return=minimal',
      },
    }
  );

  // Note: For proper atomic increment, we'd use an RPC function
  // This is a simplified version that updates the timestamp
  return result.ok;
}

/**
 * Record a loop error
 */
export async function recordLoopError(error: string): Promise<boolean> {
  const result = await supabaseRequest(
    `/rest/v1/autopilot_loop_state?id=eq.${LOOP_ID}`,
    {
      method: 'PATCH',
      body: {
        last_error: error,
        last_error_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    }
  );

  return result.ok;
}

/**
 * Get loop statistics
 */
export async function getLoopStats(): Promise<LoopStats | null> {
  const result = await supabaseRequest<LoopStats[]>(
    `/rest/v1/rpc/get_autopilot_loop_stats`,
    {
      method: 'POST',
      body: { p_loop_id: LOOP_ID },
    }
  );

  if (!result.ok || !result.data || result.data.length === 0) {
    // Fallback to direct query
    const state = await getLoopState();
    if (!state) return null;

    return {
      is_running: state.is_running,
      poll_interval_ms: state.poll_interval_ms,
      last_cursor: state.last_event_cursor,
      last_event_timestamp: state.last_event_timestamp,
      events_processed_total: state.events_processed_total,
      processed_1h: state.events_processed_1h,
      errors_1h: state.errors_1h,
      active_runs: 0,
      runs_by_state: {},
    };
  }

  return result.data[0];
}

// =============================================================================
// Processed Events Operations
// =============================================================================

/**
 * Check if an event has been processed
 */
export async function isEventProcessed(eventId: string): Promise<boolean> {
  const result = await supabaseRequest<ProcessedEvent[]>(
    `/rest/v1/autopilot_processed_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id`
  );

  return Boolean(result.ok && result.data && result.data.length > 0);
}

/**
 * Record a processed event
 */
export async function recordProcessedEvent(event: {
  event_id: string;
  vtid?: string;
  event_type: string;
  event_timestamp?: string;
  result: Record<string, unknown>;
  action_triggered?: string;
  transition_from?: string;
  transition_to?: string;
  error?: string;
  raw_event?: Record<string, unknown>;
}): Promise<boolean> {
  const record: Partial<ProcessedEvent> = {
    event_id: event.event_id,
    vtid: event.vtid || null,
    event_type: event.event_type,
    event_timestamp: event.event_timestamp || null,
    processed_at: new Date().toISOString(),
    result: event.result,
    action_triggered: event.action_triggered || null,
    transition_from: event.transition_from || null,
    transition_to: event.transition_to || null,
    error: event.error || null,
    raw_event: event.raw_event || null,
  };

  const result = await supabaseRequest(
    `/rest/v1/autopilot_processed_events`,
    {
      method: 'POST',
      body: record,
      headers: {
        'Prefer': 'resolution=ignore-duplicates,return=minimal',
      },
    }
  );

  return result.ok;
}

/**
 * Get recent processed events for history endpoint
 */
export async function getProcessedEventHistory(
  limit: number = 100
): Promise<ProcessedEvent[]> {
  const result = await supabaseRequest<ProcessedEvent[]>(
    `/rest/v1/autopilot_processed_events?select=*&order=processed_at.desc&limit=${limit}`
  );

  return result.ok && result.data ? result.data : [];
}

// =============================================================================
// Run State Operations
// =============================================================================

/**
 * Get run state for a VTID
 */
export async function getRunState(vtid: string): Promise<RunState | null> {
  const result = await supabaseRequest<RunState[]>(
    `/rest/v1/autopilot_run_state?vtid=eq.${encodeURIComponent(vtid)}&select=*`
  );

  if (!result.ok || !result.data || result.data.length === 0) {
    return null;
  }

  return result.data[0];
}

/**
 * Create or update run state for a VTID
 */
export async function upsertRunState(
  vtid: string,
  updates: Partial<RunState>
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const body = {
    vtid,
    ...updates,
    updated_at: timestamp,
  };

  const result = await supabaseRequest(
    `/rest/v1/autopilot_run_state`,
    {
      method: 'POST',
      body,
      headers: {
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
    }
  );

  return result.ok;
}

/**
 * Update run state
 */
export async function updateRunState(
  vtid: string,
  updates: Partial<RunState>
): Promise<boolean> {
  const result = await supabaseRequest(
    `/rest/v1/autopilot_run_state?vtid=eq.${encodeURIComponent(vtid)}`,
    {
      method: 'PATCH',
      body: {
        ...updates,
        updated_at: new Date().toISOString(),
      },
    }
  );

  return result.ok;
}

/**
 * Transition run to new state
 */
export async function transitionRunState(
  vtid: string,
  newState: AutopilotState,
  eventId: string,
  eventType: string
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const updates: Partial<RunState> = {
    state: newState,
    last_transition_at: timestamp,
    last_event_id: eventId,
    last_event_type: eventType,
    updated_at: timestamp,
  };

  // Mark completion time for terminal states
  if (newState === 'completed' || newState === 'failed') {
    updates.completed_at = timestamp;
  }

  return updateRunState(vtid, updates);
}

/**
 * Check if run is locked (for action coordination)
 */
export async function isRunLocked(vtid: string): Promise<boolean> {
  const state = await getRunState(vtid);
  if (!state || !state.lock_until) {
    return false;
  }

  return new Date(state.lock_until) > new Date();
}

/**
 * Acquire lock on run (returns true if acquired)
 */
export async function acquireRunLock(
  vtid: string,
  lockedBy: string,
  durationMs: number = 30000
): Promise<boolean> {
  const result = await supabaseRequest<{ acquire_autopilot_run_lock: boolean }[]>(
    `/rest/v1/rpc/acquire_autopilot_run_lock`,
    {
      method: 'POST',
      body: {
        p_vtid: vtid,
        p_locked_by: lockedBy,
        p_lock_duration_ms: durationMs,
      },
    }
  );

  if (!result.ok || !result.data) {
    // Fallback: try direct update if RPC not available
    const state = await getRunState(vtid);
    if (!state) return false;
    if (state.lock_until && new Date(state.lock_until) > new Date()) {
      return false;
    }

    return updateRunState(vtid, {
      lock_until: new Date(Date.now() + durationMs).toISOString(),
      locked_by: lockedBy,
    });
  }

  return result.data[0]?.acquire_autopilot_run_lock ?? false;
}

/**
 * Release lock on run
 */
export async function releaseRunLock(vtid: string, lockedBy?: string): Promise<boolean> {
  return updateRunState(vtid, {
    lock_until: null,
    locked_by: null,
  });
}

/**
 * Increment action attempt counter
 */
export async function incrementActionAttempt(
  vtid: string,
  actionType: keyof ActionAttempts
): Promise<number> {
  const state = await getRunState(vtid);
  if (!state) return 0;

  const newCount = (state.attempts[actionType] || 0) + 1;
  const newAttempts = { ...state.attempts, [actionType]: newCount };

  await updateRunState(vtid, { attempts: newAttempts });
  return newCount;
}

/**
 * Check if action can be attempted (under max attempts)
 */
export async function canAttemptAction(
  vtid: string,
  actionType: keyof ActionAttempts
): Promise<boolean> {
  const state = await getRunState(vtid);
  if (!state) return false;

  const attempts = state.attempts[actionType] || 0;
  return attempts < state.max_attempts;
}

/**
 * Set backoff lock (exponential backoff)
 */
export async function setBackoffLock(
  vtid: string,
  attemptNumber: number,
  baseDelayMs: number = 2000
): Promise<boolean> {
  // Exponential backoff: 2s, 4s, 8s, 16s...
  const delayMs = baseDelayMs * Math.pow(2, attemptNumber - 1);
  const lockUntil = new Date(Date.now() + delayMs).toISOString();

  return updateRunState(vtid, { lock_until: lockUntil });
}

/**
 * Get all active (non-terminal) runs
 */
export async function getActiveRuns(): Promise<RunState[]> {
  const result = await supabaseRequest<RunState[]>(
    `/rest/v1/autopilot_run_state?state=not.in.(completed,failed)&select=*&order=updated_at.desc`
  );

  return result.ok && result.data ? result.data : [];
}

/**
 * Mark run as failed with error
 */
export async function markRunFailed(
  vtid: string,
  error: string,
  errorCode?: string
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  return updateRunState(vtid, {
    state: 'failed',
    completed_at: timestamp,
    error,
    error_code: errorCode || null,
    error_at: timestamp,
  });
}

/**
 * Mark run as completed (VTID-01208: supports recovery from failed state)
 * This is called when terminalization succeeds, even after a prior failure.
 */
export async function markRunCompleted(vtid: string): Promise<boolean> {
  const timestamp = new Date().toISOString();
  return updateRunState(vtid, {
    state: 'completed',
    completed_at: timestamp,
    error: null,
    error_code: null,
  });
}

// =============================================================================
// Exports
// =============================================================================

export default {
  // Loop state
  getLoopState,
  setLoopRunning,
  updateLoopCursor,
  incrementProcessedCount,
  recordLoopError,
  getLoopStats,

  // Processed events
  isEventProcessed,
  recordProcessedEvent,
  getProcessedEventHistory,

  // Run state
  getRunState,
  upsertRunState,
  updateRunState,
  transitionRunState,
  isRunLocked,
  acquireRunLock,
  releaseRunLock,
  incrementActionAttempt,
  canAttemptAction,
  setBackoffLock,
  getActiveRuns,
  markRunFailed,
  markRunCompleted, // VTID-01208: Recovery from failed state
};
