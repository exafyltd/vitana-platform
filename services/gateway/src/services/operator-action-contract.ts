/**
 * VTID-01018: Operator Action Hard Contract
 *
 * This service enforces a mandatory lifecycle for ALL operator actions:
 * 1. Every action MUST emit operator.action.started before execution
 * 2. Every action MUST emit exactly ONE terminal event: completed OR failed
 * 3. If OASIS write fails, the operator action FAILS (no silent failures)
 * 4. Ordering is enforced: started MUST be persisted before terminal event
 * 5. Payload is validated against canonical schema before any write
 *
 * STRICT CONTRACT: No operator action can succeed without a verified OASIS event trail.
 */

import { randomUUID, createHash } from 'crypto';
import {
  OperatorActionEventPayload,
  OperatorActionEventPayloadSchema,
  OperatorActionType,
  OperatorActionStatus,
  OperatorActionResult,
  OasisWriteFailedError,
  CicdEventType,
} from '../types/cicd';

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

/**
 * VTID-01018: Generate SHA-256 hash of action payload
 */
function hashPayload(payload: Record<string, unknown>): string {
  const normalized = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * VTID-01018: Internal state tracker for action atomicity
 * Tracks started events to ensure terminal events have a valid started predecessor
 */
const actionStartedEvents = new Map<string, { eventId: string; timestamp: string }>();

/**
 * VTID-01018: Validate canonical payload structure
 * Returns validation result with detailed error messages
 */
function validateCanonicalPayload(payload: OperatorActionEventPayload): {
  valid: boolean;
  errors?: string[];
} {
  const result = OperatorActionEventPayloadSchema.safeParse(payload);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
    };
  }
  return { valid: true };
}

/**
 * VTID-01018: Write operator action event to OASIS with hard failure enforcement
 * This function MUST NOT swallow errors - any failure blocks the action.
 */
async function writeOperatorActionEvent(
  eventPayload: OperatorActionEventPayload
): Promise<{ ok: boolean; event_id?: string; error?: OasisWriteFailedError }> {
  // Step 1: Hard validation of canonical payload
  const validation = validateCanonicalPayload(eventPayload);
  if (!validation.valid) {
    console.error(
      `[VTID-01018] Canonical payload validation FAILED for action ${eventPayload.operator_action_id}:`,
      validation.errors
    );
    return {
      ok: false,
      error: {
        error: 'oasis_write_failed',
        reason: `Payload validation failed: ${validation.errors?.join(', ')}`,
        operator_action_id: eventPayload.operator_action_id,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Step 2: Atomicity check - terminal events require a prior started event
  if (eventPayload.status === 'completed' || eventPayload.status === 'failed') {
    const startedEvent = actionStartedEvents.get(eventPayload.operator_action_id);
    if (!startedEvent) {
      console.error(
        `[VTID-01018] ATOMICITY VIOLATION: Terminal event without started event for action ${eventPayload.operator_action_id}`
      );
      return {
        ok: false,
        error: {
          error: 'oasis_write_failed',
          reason: 'Terminal event requires prior started event (atomicity violation)',
          operator_action_id: eventPayload.operator_action_id,
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  // Step 3: Check OASIS configuration
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error('[VTID-01018] OASIS WRITE BLOCKED: Missing Supabase credentials');
    return {
      ok: false,
      error: {
        error: 'oasis_write_failed',
        reason: 'Gateway misconfigured: missing Supabase credentials',
        operator_action_id: eventPayload.operator_action_id,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Step 4: Construct OASIS event record
  const eventId = randomUUID();
  const eventType: CicdEventType = `operator.action.${eventPayload.status}` as CicdEventType;

  const dbPayload = {
    id: eventId,
    created_at: eventPayload.timestamp,
    vtid: eventPayload.vtid,
    topic: eventType,
    service: 'operator-console',
    role: 'OPERATOR',
    model: 'operator-action-contract',
    status: eventPayload.status === 'failed' ? 'error' : eventPayload.status === 'completed' ? 'success' : 'info',
    message: `Operator action ${eventPayload.action_type}: ${eventPayload.status}`,
    link: null,
    metadata: {
      operator_action_id: eventPayload.operator_action_id,
      operator_id: eventPayload.operator_id,
      operator_role: eventPayload.operator_role,
      action_type: eventPayload.action_type,
      action_payload_hash: eventPayload.action_payload_hash,
      source: eventPayload.source,
      ...eventPayload.payload,
    },
  };

  // Step 5: Write to OASIS - NO error swallowing
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(dbPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[VTID-01018] OASIS WRITE FAILED for action ${eventPayload.operator_action_id}: ${response.status} - ${errorText}`
      );
      return {
        ok: false,
        error: {
          error: 'oasis_write_failed',
          reason: `OASIS insert failed: ${response.status} - ${errorText}`,
          operator_action_id: eventPayload.operator_action_id,
          timestamp: new Date().toISOString(),
        },
      };
    }

    // Step 6: Track started events for atomicity enforcement
    if (eventPayload.status === 'started') {
      actionStartedEvents.set(eventPayload.operator_action_id, {
        eventId,
        timestamp: eventPayload.timestamp,
      });
      console.log(`[VTID-01018] Started event persisted: ${eventPayload.operator_action_id} (${eventId})`);
    }

    // Step 7: Clean up tracking on terminal event
    if (eventPayload.status === 'completed' || eventPayload.status === 'failed') {
      actionStartedEvents.delete(eventPayload.operator_action_id);
      console.log(
        `[VTID-01018] Terminal event persisted: ${eventPayload.operator_action_id} (${eventPayload.status}) - ${eventId}`
      );
    }

    return { ok: true, event_id: eventId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01018] OASIS WRITE ERROR for action ${eventPayload.operator_action_id}: ${errorMessage}`);
    return {
      ok: false,
      error: {
        error: 'oasis_write_failed',
        reason: `OASIS write exception: ${errorMessage}`,
        operator_action_id: eventPayload.operator_action_id,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

/**
 * VTID-01018: Operator action context for lifecycle management
 */
export interface OperatorActionContext {
  /** VTID this action relates to (null if not task-bound) */
  vtid: string | null;
  /** Operator performing the action */
  operatorId: string;
  /** Operator role */
  operatorRole: 'operator' | 'admin' | 'system';
  /** Type of action being performed */
  actionType: OperatorActionType;
  /** Action-specific payload data */
  actionPayload: Record<string, unknown>;
}

/**
 * VTID-01018: Execute an operator action with MANDATORY OASIS lifecycle
 *
 * This is the ONLY way to execute operator actions. It enforces:
 * 1. Emit operator.action.started BEFORE action execution
 * 2. Execute the action
 * 3. Emit operator.action.completed OR operator.action.failed based on result
 * 4. If ANY OASIS write fails, the entire action FAILS
 *
 * @param context - Action context with operator and action details
 * @param action - The actual action to execute (returns data or throws)
 * @returns OperatorActionResult with full OASIS event trail
 */
export async function executeWithOasisContract<T>(
  context: OperatorActionContext,
  action: () => Promise<T>
): Promise<OperatorActionResult<T>> {
  const operatorActionId = randomUUID();
  const payloadHash = hashPayload(context.actionPayload);
  const startTimestamp = new Date().toISOString();

  console.log(`[VTID-01018] Starting operator action: ${operatorActionId} (type: ${context.actionType})`);

  // Step 1: Emit started event - MUST succeed before action execution
  const startedPayload: OperatorActionEventPayload = {
    vtid: context.vtid,
    operator_action_id: operatorActionId,
    operator_id: context.operatorId,
    operator_role: context.operatorRole,
    action_type: context.actionType,
    action_payload_hash: payloadHash,
    status: 'started',
    source: 'operator',
    timestamp: startTimestamp,
    payload: context.actionPayload,
  };

  const startedResult = await writeOperatorActionEvent(startedPayload);

  if (!startedResult.ok) {
    console.error(`[VTID-01018] Action BLOCKED: Failed to emit started event for ${operatorActionId}`);
    return {
      ok: false,
      operator_action_id: operatorActionId,
      oasis_error: startedResult.error,
    };
  }

  // Step 2: Execute the actual action
  let actionResult: T;
  let actionError: Error | null = null;

  try {
    actionResult = await action();
  } catch (error) {
    actionError = error instanceof Error ? error : new Error(String(error));
    console.error(`[VTID-01018] Action execution failed for ${operatorActionId}: ${actionError.message}`);
  }

  // Step 3: Emit terminal event (completed or failed)
  const terminalTimestamp = new Date().toISOString();
  const terminalStatus: OperatorActionStatus = actionError ? 'failed' : 'completed';

  const terminalPayload: OperatorActionEventPayload = {
    vtid: context.vtid,
    operator_action_id: operatorActionId,
    operator_id: context.operatorId,
    operator_role: context.operatorRole,
    action_type: context.actionType,
    action_payload_hash: payloadHash,
    status: terminalStatus,
    source: 'operator',
    timestamp: terminalTimestamp,
    payload: {
      ...context.actionPayload,
      ...(actionError ? { error: actionError.message } : {}),
    },
  };

  const terminalResult = await writeOperatorActionEvent(terminalPayload);

  if (!terminalResult.ok) {
    console.error(
      `[VTID-01018] CRITICAL: Failed to emit terminal event for ${operatorActionId} - action state is AMBIGUOUS`
    );
    return {
      ok: false,
      operator_action_id: operatorActionId,
      started_event_id: startedResult.event_id,
      oasis_error: terminalResult.error,
    };
  }

  // Step 4: Return result based on action outcome
  if (actionError) {
    return {
      ok: false,
      operator_action_id: operatorActionId,
      started_event_id: startedResult.event_id,
      terminal_event_id: terminalResult.event_id,
      oasis_error: {
        error: 'oasis_write_failed',
        reason: `Action execution failed: ${actionError.message}`,
        operator_action_id: operatorActionId,
        timestamp: terminalTimestamp,
      },
    };
  }

  console.log(`[VTID-01018] Action completed successfully: ${operatorActionId}`);

  return {
    ok: true,
    operator_action_id: operatorActionId,
    started_event_id: startedResult.event_id,
    terminal_event_id: terminalResult.event_id,
    data: actionResult!,
  };
}

/**
 * VTID-01018: Emit a standalone operator action event (for compatibility)
 * Use executeWithOasisContract for full lifecycle enforcement.
 * This function is for cases where manual event emission is needed.
 */
export async function emitOperatorActionEvent(
  context: OperatorActionContext,
  status: OperatorActionStatus,
  operatorActionId?: string
): Promise<{ ok: boolean; event_id?: string; operator_action_id: string; error?: OasisWriteFailedError }> {
  const actionId = operatorActionId || randomUUID();
  const payloadHash = hashPayload(context.actionPayload);
  const timestamp = new Date().toISOString();

  const payload: OperatorActionEventPayload = {
    vtid: context.vtid,
    operator_action_id: actionId,
    operator_id: context.operatorId,
    operator_role: context.operatorRole,
    action_type: context.actionType,
    action_payload_hash: payloadHash,
    status,
    source: 'operator',
    timestamp,
    payload: context.actionPayload,
  };

  const result = await writeOperatorActionEvent(payload);

  return {
    ok: result.ok,
    event_id: result.event_id,
    operator_action_id: actionId,
    error: result.error,
  };
}

/**
 * VTID-01018: Check if an action has a started event (for atomicity verification)
 */
export function hasStartedEvent(operatorActionId: string): boolean {
  return actionStartedEvents.has(operatorActionId);
}

/**
 * VTID-01018: Get started event details for an action
 */
export function getStartedEvent(
  operatorActionId: string
): { eventId: string; timestamp: string } | undefined {
  return actionStartedEvents.get(operatorActionId);
}

/**
 * VTID-01018: Clean up stale action tracking (for maintenance)
 * Removes entries older than the specified max age (default: 1 hour)
 */
export function cleanupStaleActions(maxAgeMs: number = 3600000): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [actionId, event] of actionStartedEvents.entries()) {
    const eventTime = new Date(event.timestamp).getTime();
    if (now - eventTime > maxAgeMs) {
      actionStartedEvents.delete(actionId);
      cleaned++;
      console.warn(`[VTID-01018] Cleaned stale action tracking: ${actionId}`);
    }
  }

  return cleaned;
}

export default {
  executeWithOasisContract,
  emitOperatorActionEvent,
  hasStartedEvent,
  getStartedEvent,
  cleanupStaleActions,
};
