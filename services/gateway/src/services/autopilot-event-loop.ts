/**
 * Autopilot Event Loop - VTID-01179
 *
 * Autonomous state machine driver that:
 * - Polls OASIS events continuously
 * - Maps events to autopilot state transitions
 * - Triggers actions (dispatch/validate/merge/verify)
 * - Guarantees idempotency, retry, and crash safety
 *
 * Design principles:
 * - Crash-safe: persists cursor and state
 * - Idempotent: deduplicates events
 * - Rate-limited: exponential backoff on failures
 * - Deterministic: strict event → transition mapping
 */

import { emitOasisEvent } from './oasis-event-service';
import {
  AutopilotState,
  markInProgress,
  markBuilding,
  markPrCreated,
  markReviewing,
  markValidated,
  markMerged,
  markDeploying,
  markVerifying,
  markCompleted,
  markFailed,
  getAutopilotRun,
  startAutopilotRun,
  hasValidatorPass,
} from './autopilot-controller';
import {
  getLoopState,
  setLoopRunning,
  updateLoopCursor,
  resetLoopCursor,
  recordLoopError,
  getLoopStats,
  isEventProcessed,
  recordProcessedEvent,
  getProcessedEventHistory,
  getRunState,
  upsertRunState,
  updateRunState,
  transitionRunState,
  acquireRunLock,
  releaseRunLock,
  incrementActionAttempt,
  canAttemptAction,
  setBackoffLock,
  markRunFailed,
  LoopStats,
  ProcessedEvent,
  RunState,
} from './autopilot-loop-store';
import {
  OasisEvent,
  mapEventToTransition,
  isAutopilotRelevantEvent,
  normalizeEventType,
  AutopilotAction,
} from './autopilot-event-mapper';

// =============================================================================
// Types
// =============================================================================

interface LoopConfig {
  pollIntervalMs: number;
  batchSize: number;
  enabled: boolean;
}

interface ActionResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

// =============================================================================
// Configuration
// =============================================================================

const LOG_PREFIX = '[VTID-01179]';
const DEFAULT_POLL_MS = 2000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BACKOFF_MS = 60000;

// Loop instance state
let loopRunning = false;
let loopTimeout: NodeJS.Timeout | null = null;
let currentConfig: LoopConfig = {
  pollIntervalMs: DEFAULT_POLL_MS,
  batchSize: DEFAULT_BATCH_SIZE,
  enabled: false,
};

// =============================================================================
// OASIS Event Polling
// =============================================================================

/**
 * Fetch events from OASIS events table
 */
async function fetchOasisEvents(
  cursor: string | null,
  limit: number
): Promise<{ ok: boolean; events: OasisEvent[]; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, events: [], error: 'Missing Supabase credentials' };
  }

  try {
    // Build query - fetch events after cursor, ordered by created_at
    let url = `${supabaseUrl}/rest/v1/oasis_events?select=*&order=created_at.asc,id.asc&limit=${limit}`;

    if (cursor) {
      // Use cursor as created_at filter
      url += `&created_at=gte.${encodeURIComponent(cursor)}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, events: [], error: `${response.status}: ${errorText}` };
    }

    const events = await response.json() as OasisEvent[];
    return { ok: true, events };
  } catch (error) {
    return { ok: false, events: [], error: String(error) };
  }
}

// =============================================================================
// Event Processing
// =============================================================================

/**
 * Process a single OASIS event
 */
async function processEvent(event: OasisEvent): Promise<{
  processed: boolean;
  transitioned: boolean;
  actionTriggered: boolean;
  error?: string;
}> {
  const eventId = event.id;
  const eventType = normalizeEventType(event);
  const vtid = event.vtid;

  // Skip if no VTID
  if (!vtid) {
    return { processed: true, transitioned: false, actionTriggered: false };
  }

  // Check if already processed (idempotency)
  const alreadyProcessed = await isEventProcessed(eventId);
  if (alreadyProcessed) {
    console.log(`${LOG_PREFIX} Skipping already processed event: ${eventId}`);
    return { processed: true, transitioned: false, actionTriggered: false };
  }

  // Check if event is relevant to autopilot
  if (!isAutopilotRelevantEvent(event)) {
    // Record as processed but no action
    await recordProcessedEvent({
      event_id: eventId,
      vtid,
      event_type: eventType,
      event_timestamp: event.created_at,
      result: { skipped: true, reason: 'not_relevant' },
      raw_event: event as unknown as Record<string, unknown>,
    });
    return { processed: true, transitioned: false, actionTriggered: false };
  }

  // Get or create run state
  let runState = await getRunState(vtid);
  if (!runState) {
    // Create initial run state
    await upsertRunState(vtid, {
      vtid,
      state: 'allocated',
      run_id: event.id,
    });
    runState = await getRunState(vtid);
    if (!runState) {
      const error = `Failed to create run state for ${vtid}`;
      console.error(`${LOG_PREFIX} ${error}`);
      return { processed: false, transitioned: false, actionTriggered: false, error };
    }
  }

  const currentState = runState.state as AutopilotState;

  // Map event to transition
  const mapping = mapEventToTransition(event, currentState);

  if (!mapping.matched) {
    // No matching rule - record and continue
    await recordProcessedEvent({
      event_id: eventId,
      vtid,
      event_type: eventType,
      event_timestamp: event.created_at,
      result: { skipped: true, reason: mapping.reason },
      raw_event: event as unknown as Record<string, unknown>,
    });
    return { processed: true, transitioned: false, actionTriggered: false };
  }

  const toState = mapping.toState!;
  const triggerAction = mapping.triggerAction;

  console.log(`${LOG_PREFIX} Processing ${vtid}: ${currentState} → ${toState} (event: ${eventType})`);

  // Execute transition
  let transitioned = false;
  let actionTriggered = false;
  let error: string | undefined;

  try {
    // Acquire lock for this VTID
    const lockAcquired = await acquireRunLock(vtid, 'event-loop', 30000);
    if (!lockAcquired) {
      console.log(`${LOG_PREFIX} Could not acquire lock for ${vtid}, will retry`);
      return { processed: false, transitioned: false, actionTriggered: false, error: 'lock_failed' };
    }

    try {
      // Perform state transition
      transitioned = await performTransition(vtid, currentState, toState, event);

      if (transitioned && triggerAction) {
        // Trigger associated action
        actionTriggered = await triggerActionForState(vtid, triggerAction, event);
      }

      // Record processed event
      await recordProcessedEvent({
        event_id: eventId,
        vtid,
        event_type: eventType,
        event_timestamp: event.created_at,
        result: {
          transitioned,
          actionTriggered,
          from_state: currentState,
          to_state: toState,
          action: triggerAction,
        },
        action_triggered: triggerAction,
        transition_from: currentState,
        transition_to: toState,
        raw_event: event as unknown as Record<string, unknown>,
      });

      // Emit loop event
      await emitLoopEvent('autopilot.loop.event_processed', vtid, {
        event_id: eventId,
        event_type: eventType,
        transitioned,
        actionTriggered,
        from_state: currentState,
        to_state: toState,
      });

    } finally {
      await releaseRunLock(vtid, 'event-loop');
    }
  } catch (err) {
    error = String(err);
    console.error(`${LOG_PREFIX} Error processing event ${eventId}: ${error}`);

    await recordProcessedEvent({
      event_id: eventId,
      vtid,
      event_type: eventType,
      event_timestamp: event.created_at,
      result: { error },
      error,
      raw_event: event as unknown as Record<string, unknown>,
    });

    await recordLoopError(error);
  }

  return { processed: true, transitioned, actionTriggered, error };
}

/**
 * Perform state transition
 */
async function performTransition(
  vtid: string,
  fromState: AutopilotState,
  toState: AutopilotState,
  event: OasisEvent
): Promise<boolean> {
  const eventId = event.id;

  // Update persisted run state
  await transitionRunState(vtid, toState, eventId, normalizeEventType(event));

  // Update in-memory controller state
  switch (toState) {
    case 'in_progress':
      await markInProgress(vtid);
      break;
    case 'building':
      await markBuilding(vtid);
      break;
    case 'pr_created':
      const meta = event.metadata || event.meta || {};
      await markPrCreated(vtid, meta.pr_number as number || 0, meta.pr_url as string || '');
      break;
    case 'reviewing':
      await markReviewing(vtid);
      break;
    case 'validated':
      // Note: actual validation result should come from validate action
      break;
    case 'merged':
      const mergeMeta = event.metadata || event.meta || {};
      await markMerged(vtid, mergeMeta.merge_sha as string || mergeMeta.sha as string || '');
      break;
    case 'deploying':
      const deployMeta = event.metadata || event.meta || {};
      await markDeploying(vtid, deployMeta.workflow_url as string);
      break;
    case 'verifying':
      await markVerifying(vtid);
      break;
    case 'completed':
      await markCompleted(vtid);
      break;
    case 'failed':
      const errorMsg = (event.message || event.metadata?.error || 'Unknown error') as string;
      await markFailed(vtid, errorMsg);
      break;
  }

  // Emit transition event
  await emitLoopEvent('autopilot.loop.transition', vtid, {
    from_state: fromState,
    to_state: toState,
    trigger_event_id: eventId,
  });

  console.log(`${LOG_PREFIX} Transitioned ${vtid}: ${fromState} → ${toState}`);
  return true;
}

// =============================================================================
// Action Triggers
// =============================================================================

/**
 * Trigger an action based on the state transition
 */
async function triggerActionForState(
  vtid: string,
  action: AutopilotAction,
  event: OasisEvent
): Promise<boolean> {
  // Check if we can attempt this action
  const canAttempt = await canAttemptAction(vtid, action);
  if (!canAttempt) {
    console.log(`${LOG_PREFIX} Max attempts reached for ${action} on ${vtid}`);
    await markRunFailed(vtid, `Max attempts reached for ${action}`, 'MAX_ATTEMPTS');
    return false;
  }

  // Increment attempt counter
  const attemptNum = await incrementActionAttempt(vtid, action);
  console.log(`${LOG_PREFIX} Triggering ${action} for ${vtid} (attempt ${attemptNum})`);

  let result: ActionResult;

  try {
    switch (action) {
      case 'dispatch':
        result = await triggerDispatch(vtid, event);
        break;
      case 'create_pr':
        result = await triggerCreatePr(vtid, event);
        break;
      case 'validate':
        result = await triggerValidate(vtid, event);
        break;
      case 'merge':
        result = await triggerMerge(vtid, event);
        break;
      case 'verify':
        result = await triggerVerify(vtid, event);
        break;
      default:
        result = { ok: false, error: `Unknown action: ${action}` };
    }

    if (!result.ok) {
      console.warn(`${LOG_PREFIX} Action ${action} failed for ${vtid}: ${result.error}`);

      // Set backoff for retry
      await setBackoffLock(vtid, attemptNum);

      return false;
    }

    // Emit action triggered event
    await emitLoopEvent('autopilot.loop.action_triggered', vtid, {
      action,
      attempt: attemptNum,
      result: result.data,
    });

    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} Action ${action} threw error for ${vtid}: ${error}`);
    await setBackoffLock(vtid, attemptNum);
    return false;
  }
}

/**
 * Trigger dispatch to worker orchestrator
 */
async function triggerDispatch(vtid: string, event: OasisEvent): Promise<ActionResult> {
  // Get spec from event metadata or fetch from ledger
  const meta = event.metadata || event.meta || {};
  const title = (meta.title || event.title || vtid) as string;
  const specContent = (meta.spec_content || meta.description || '') as string;

  if (!specContent) {
    // Try to fetch from vtid_ledger
    const ledgerData = await fetchVtidFromLedger(vtid);
    if (!ledgerData) {
      return { ok: false, error: 'No spec content available' };
    }

    // Start autopilot run with ledger data
    await startAutopilotRun(vtid, ledgerData.title || vtid, ledgerData.description || '');
  } else {
    await startAutopilotRun(vtid, title, specContent);
  }

  // Note: Actual worker dispatch would happen via worker-orchestrator
  // This just ensures the run is initialized
  return { ok: true, data: { vtid, dispatched: true } };
}

/**
 * Trigger PR creation
 */
async function triggerCreatePr(vtid: string, event: OasisEvent): Promise<ActionResult> {
  // PR creation is typically done by the worker
  // This is a fallback if worker completed without creating PR
  console.log(`${LOG_PREFIX} PR creation fallback for ${vtid} - worker should handle this`);
  return { ok: true, data: { vtid, note: 'PR creation delegated to worker' } };
}

/**
 * Trigger pre-merge validation
 */
async function triggerValidate(vtid: string, event: OasisEvent): Promise<ActionResult> {
  const runState = await getRunState(vtid);
  if (!runState?.pr_number) {
    return { ok: false, error: 'No PR number available for validation' };
  }

  // Call validation endpoint
  const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:8080';
  try {
    const response = await fetch(`${gatewayUrl}/api/v1/autopilot/controller/runs/${vtid}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pr_number: runState.pr_number,
        repo: 'exafyltd/vitana-platform',
      }),
    });

    const result = await response.json() as { ok?: boolean; passed?: boolean; error?: string; result?: Record<string, unknown> };
    if (!response.ok || !result.passed) {
      return { ok: false, error: result.error || 'Validation failed' };
    }

    // Update run state with validation result
    await updateRunState(vtid, {
      validator_passed: true,
      validator_result: result.result || {},
    });

    // Mark validated in controller
    await markValidated(vtid, {
      passed: true,
      code_review_passed: true,
      governance_passed: true,
      security_scan_passed: true,
      issues: [],
      validated_at: new Date().toISOString(),
    });

    return { ok: true, data: result as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * Trigger safe-merge
 */
async function triggerMerge(vtid: string, event: OasisEvent): Promise<ActionResult> {
  // Check validator pass (hard gate)
  if (!hasValidatorPass(vtid)) {
    return { ok: false, error: 'Validator pass required before merge' };
  }

  const runState = await getRunState(vtid);
  if (!runState?.pr_number) {
    return { ok: false, error: 'No PR number available for merge' };
  }

  // Call safe-merge endpoint
  const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:8080';
  try {
    const response = await fetch(`${gatewayUrl}/api/v1/cicd/safe-merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vtid,
        pr_number: runState.pr_number,
        repo: 'exafyltd/vitana-platform',
      }),
    });

    const result = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) {
      return { ok: false, error: result.error || 'Merge failed' };
    }

    return { ok: true, data: result as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * Trigger post-deploy verification
 */
async function triggerVerify(vtid: string, event: OasisEvent): Promise<ActionResult> {
  const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:8080';
  try {
    const response = await fetch(`${gatewayUrl}/api/v1/autopilot/controller/runs/${vtid}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: 'gateway',
        environment: 'dev',
      }),
    });

    const result = await response.json() as { ok?: boolean; passed?: boolean; error?: string; result?: Record<string, unknown> };
    if (!response.ok || !result.passed) {
      return { ok: false, error: result.error || 'Verification failed' };
    }

    // Update run state with verification result
    await updateRunState(vtid, {
      verification_passed: true,
      verification_result: result.result || {},
    });

    return { ok: true, data: result as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Fetch VTID data from ledger
 */
async function fetchVtidFromLedger(vtid: string): Promise<{
  title?: string;
  description?: string;
} | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&select=title,summary`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!response.ok) return null;

    const data = await response.json() as Array<{ title?: string; summary?: string }>;
    if (!data || data.length === 0) return null;

    return {
      title: data[0].title,
      description: data[0].summary,
    };
  } catch {
    return null;
  }
}

/**
 * Emit loop-specific OASIS event
 */
async function emitLoopEvent(
  type: string,
  vtid: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid,
      type: type as any,
      source: 'autopilot-event-loop',
      status: 'info',
      message: `${type}: ${vtid}`,
      payload: {
        ...payload,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to emit loop event: ${error}`);
  }
}

// =============================================================================
// Main Loop
// =============================================================================

/**
 * Single iteration of the event loop
 */
async function runLoopIteration(): Promise<void> {
  if (!loopRunning) {
    return;
  }

  try {
    // Get current cursor
    const state = await getLoopState();
    const cursor = state?.last_event_cursor || null;

    // Fetch events
    const { ok, events, error } = await fetchOasisEvents(cursor, currentConfig.batchSize);

    if (!ok) {
      console.error(`${LOG_PREFIX} Failed to fetch events: ${error}`);
      await recordLoopError(error || 'Unknown fetch error');
      return;
    }

    if (events.length === 0) {
      // No new events
      return;
    }

    console.log(`${LOG_PREFIX} Processing ${events.length} events`);

    // Process events sequentially
    let lastProcessedEvent: OasisEvent | null = null;

    for (const event of events) {
      if (!loopRunning) break; // Check for graceful stop

      const result = await processEvent(event);

      if (result.processed) {
        lastProcessedEvent = event;
      }
    }

    // Update cursor to last processed event
    if (lastProcessedEvent) {
      await updateLoopCursor(lastProcessedEvent.created_at, lastProcessedEvent.created_at);
    }

  } catch (error) {
    console.error(`${LOG_PREFIX} Loop iteration error: ${error}`);
    await recordLoopError(String(error));
  }
}

/**
 * Start the event loop
 */
export async function startEventLoop(): Promise<boolean> {
  if (loopRunning) {
    console.log(`${LOG_PREFIX} Event loop already running`);
    return true;
  }

  // Load config from environment
  const pollMs = parseInt(process.env.AUTOPILOT_LOOP_POLL_MS || String(DEFAULT_POLL_MS), 10);
  const batchSize = parseInt(process.env.AUTOPILOT_LOOP_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10);
  const enabled = process.env.AUTOPILOT_LOOP_ENABLED === 'true';

  currentConfig = {
    pollIntervalMs: Math.min(Math.max(pollMs, 500), 60000),
    batchSize: Math.min(Math.max(batchSize, 1), 500),
    enabled,
  };

  if (!currentConfig.enabled) {
    console.log(`${LOG_PREFIX} Event loop disabled by configuration`);
    return false;
  }

  console.log(`${LOG_PREFIX} Starting event loop (poll=${currentConfig.pollIntervalMs}ms, batch=${currentConfig.batchSize})`);

  loopRunning = true;
  await setLoopRunning(true);

  // Start the loop
  scheduleNextIteration();

  return true;
}

/**
 * Schedule next loop iteration
 */
function scheduleNextIteration(): void {
  if (!loopRunning) return;

  loopTimeout = setTimeout(async () => {
    await runLoopIteration();
    scheduleNextIteration();
  }, currentConfig.pollIntervalMs);
}

/**
 * Stop the event loop (graceful)
 */
export async function stopEventLoop(): Promise<void> {
  console.log(`${LOG_PREFIX} Stopping event loop`);

  loopRunning = false;

  if (loopTimeout) {
    clearTimeout(loopTimeout);
    loopTimeout = null;
  }

  await setLoopRunning(false);
}

/**
 * Get loop status
 */
export async function getEventLoopStatus(): Promise<{
  ok: boolean;
  is_running: boolean;
  config: LoopConfig;
  stats?: LoopStats;
  error?: string;
}> {
  try {
    const stats = await getLoopStats();

    return {
      ok: true,
      is_running: loopRunning,
      config: currentConfig,
      stats: stats || undefined,
    };
  } catch (error) {
    return {
      ok: false,
      is_running: loopRunning,
      config: currentConfig,
      error: String(error),
    };
  }
}

/**
 * Get processed event history
 */
export async function getEventLoopHistory(limit: number = 100): Promise<ProcessedEvent[]> {
  return getProcessedEventHistory(limit);
}

/**
 * Initialize event loop (called at startup)
 */
export async function initializeEventLoop(): Promise<void> {
  const enabled = process.env.AUTOPILOT_LOOP_ENABLED === 'true';

  console.log(`${LOG_PREFIX} Initializing event loop (enabled=${enabled})`);

  if (enabled) {
    await startEventLoop();
  }
}

/**
 * Reset event loop cursor to a specific timestamp
 * VTID-01179: Allows manual cursor reset for catching up or skipping ahead
 *
 * @param timestamp - ISO timestamp to reset cursor to (or 'now' for current time)
 * @param reason - Reason for the reset (for logging)
 */
export async function resetEventLoopCursor(
  timestamp: string,
  reason: string = 'manual-reset'
): Promise<{ ok: boolean; cursor: string; reason: string }> {
  const effectiveTimestamp = timestamp === 'now'
    ? new Date().toISOString()
    : timestamp;

  console.log(`${LOG_PREFIX} Resetting cursor to ${effectiveTimestamp} (reason: ${reason})`);

  const success = await resetLoopCursor(effectiveTimestamp, reason);

  return {
    ok: success,
    cursor: effectiveTimestamp,
    reason,
  };
}

// =============================================================================
// Exports
// =============================================================================

export default {
  startEventLoop,
  stopEventLoop,
  getEventLoopStatus,
  getEventLoopHistory,
  initializeEventLoop,
  resetEventLoopCursor,
};
