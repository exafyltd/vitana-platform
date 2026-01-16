/**
 * Worker Connector Service - VTID-01183
 *
 * Connects worker agents (Claude Code sessions) to the Autopilot Event Loop
 * so dispatched tasks are automatically picked up and executed.
 *
 * Features:
 * - Worker registration and heartbeat
 * - Atomic task claiming (prevents duplicate execution)
 * - Progress reporting with OASIS events
 * - Claim expiration and cleanup
 */

import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[VTID-01183]';

// =============================================================================
// Types
// =============================================================================

export interface WorkerRegistration {
  worker_id: string;
  capabilities?: string[];
  max_concurrent?: number;
  metadata?: Record<string, unknown>;
}

export interface WorkerInfo {
  worker_id: string;
  capabilities: string[];
  max_concurrent: number;
  status: 'active' | 'inactive' | 'terminated';
  current_vtid: string | null;
  last_heartbeat_at: string;
  registered_at: string;
}

export interface PendingTask {
  vtid: string;
  title: string | null;
  description: string | null;
  state: string;
  dispatched_at: string;
  spec_snapshot_id: string | null;
}

export interface TaskClaim {
  ok: boolean;
  claimed: boolean;
  claim_id?: string;
  vtid?: string;
  worker_id?: string;
  expires_at?: string;
  reason?: string;
  spec?: string;
}

export interface ProgressEvent {
  event: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Supabase Helper
// =============================================================================

async function supabaseRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation',
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = await response.json() as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function callRpc<T>(
  functionName: string,
  params: Record<string, unknown>
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = await response.json() as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Worker Registration
// =============================================================================

/**
 * Register a new worker agent
 */
export async function registerWorker(
  registration: WorkerRegistration
): Promise<{ ok: boolean; worker?: WorkerInfo; error?: string }> {
  const { worker_id, capabilities = [], max_concurrent = 1, metadata = {} } = registration;

  console.log(`${LOG_PREFIX} Registering worker: ${worker_id}`);

  // Check if already registered
  const existing = await supabaseRequest<WorkerInfo[]>(
    `/rest/v1/worker_registry?worker_id=eq.${encodeURIComponent(worker_id)}&select=*`
  );

  if (existing.ok && existing.data && existing.data.length > 0) {
    // Update existing registration
    const result = await supabaseRequest<WorkerInfo[]>(
      `/rest/v1/worker_registry?worker_id=eq.${encodeURIComponent(worker_id)}`,
      {
        method: 'PATCH',
        body: {
          capabilities,
          max_concurrent,
          metadata,
          status: 'active',
          last_heartbeat_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      }
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    console.log(`${LOG_PREFIX} Worker re-registered: ${worker_id}`);
    return { ok: true, worker: result.data?.[0] };
  }

  // Create new registration
  const result = await supabaseRequest<WorkerInfo[]>(
    '/rest/v1/worker_registry',
    {
      method: 'POST',
      body: {
        worker_id,
        capabilities,
        max_concurrent,
        metadata,
        status: 'active',
        last_heartbeat_at: new Date().toISOString(),
      },
    }
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Emit registration event
  await emitOasisEvent({
    vtid: 'SYSTEM',
    type: 'worker.registered' as any,
    source: 'worker-connector',
    status: 'info',
    message: `Worker registered: ${worker_id}`,
    payload: { worker_id, capabilities },
  });

  console.log(`${LOG_PREFIX} Worker registered: ${worker_id}`);
  return { ok: true, worker: result.data?.[0] };
}

/**
 * Unregister a worker agent
 */
export async function unregisterWorker(
  worker_id: string
): Promise<{ ok: boolean; error?: string }> {
  console.log(`${LOG_PREFIX} Unregistering worker: ${worker_id}`);

  const result = await supabaseRequest(
    `/rest/v1/worker_registry?worker_id=eq.${encodeURIComponent(worker_id)}`,
    {
      method: 'PATCH',
      body: {
        status: 'terminated',
        current_vtid: null,
        updated_at: new Date().toISOString(),
      },
    }
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Release any active claims
  await supabaseRequest(
    `/rest/v1/worker_task_claims?worker_id=eq.${encodeURIComponent(worker_id)}&released_at=is.null`,
    {
      method: 'PATCH',
      body: {
        released_at: new Date().toISOString(),
        release_reason: 'worker_terminated',
        updated_at: new Date().toISOString(),
      },
    }
  );

  return { ok: true };
}

/**
 * Get worker info
 */
export async function getWorker(
  worker_id: string
): Promise<{ ok: boolean; worker?: WorkerInfo; error?: string }> {
  const result = await supabaseRequest<WorkerInfo[]>(
    `/rest/v1/worker_registry?worker_id=eq.${encodeURIComponent(worker_id)}&select=*`
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  if (!result.data || result.data.length === 0) {
    return { ok: false, error: 'Worker not found' };
  }

  return { ok: true, worker: result.data[0] };
}

/**
 * List active workers
 */
export async function listWorkers(): Promise<{
  ok: boolean;
  workers?: WorkerInfo[];
  error?: string;
}> {
  const result = await supabaseRequest<WorkerInfo[]>(
    '/rest/v1/worker_registry?status=eq.active&select=*&order=registered_at.desc'
  );

  return {
    ok: result.ok,
    workers: result.data,
    error: result.error,
  };
}

// =============================================================================
// Task Polling
// =============================================================================

/**
 * Get pending tasks available for workers
 */
export async function getPendingTasks(): Promise<{
  ok: boolean;
  tasks?: PendingTask[];
  error?: string;
}> {
  const result = await supabaseRequest<PendingTask[]>(
    '/rest/v1/worker_pending_tasks?select=*&order=dispatched_at.asc&limit=50'
  );

  return {
    ok: result.ok,
    tasks: result.data || [],
    error: result.error,
  };
}

/**
 * Get spec snapshot for a task
 */
export async function getTaskSpec(
  vtid: string
): Promise<{ ok: boolean; spec?: string; error?: string }> {
  // Get spec from autopilot_spec_snapshots table
  const result = await supabaseRequest<Array<{ spec_text: string }>>(
    `/rest/v1/autopilot_spec_snapshots?vtid=eq.${encodeURIComponent(vtid)}&select=spec_text&order=created_at.desc&limit=1`
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  if (!result.data || result.data.length === 0) {
    // Try getting from vtid_ledger
    const ledgerResult = await supabaseRequest<Array<{ summary: string }>>(
      `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&select=summary`
    );

    if (ledgerResult.ok && ledgerResult.data && ledgerResult.data.length > 0) {
      return { ok: true, spec: ledgerResult.data[0].summary };
    }

    return { ok: false, error: 'Spec not found' };
  }

  return { ok: true, spec: result.data[0].spec_text };
}

// =============================================================================
// Task Claiming
// =============================================================================

/**
 * Claim a task atomically
 */
export async function claimTask(
  vtid: string,
  worker_id: string,
  expires_minutes: number = 60
): Promise<TaskClaim> {
  console.log(`${LOG_PREFIX} Worker ${worker_id} claiming task ${vtid}`);

  const result = await callRpc<TaskClaim>('claim_worker_task', {
    p_vtid: vtid,
    p_worker_id: worker_id,
    p_expires_minutes: expires_minutes,
  });

  if (!result.ok) {
    return { ok: false, claimed: false, reason: result.error };
  }

  const claim = result.data as TaskClaim;

  if (claim.claimed) {
    // Get spec for the worker
    const specResult = await getTaskSpec(vtid);
    claim.spec = specResult.spec;

    // Emit claim event
    await emitOasisEvent({
      vtid,
      type: 'worker.task.claimed' as any,
      source: 'worker-connector',
      status: 'info',
      message: `Task claimed by ${worker_id}`,
      payload: {
        worker_id,
        claim_id: claim.claim_id,
        expires_at: claim.expires_at,
      },
    });

    console.log(`${LOG_PREFIX} Task ${vtid} claimed by ${worker_id}`);
  }

  return claim;
}

/**
 * Release a task claim
 */
export async function releaseTask(
  vtid: string,
  worker_id: string,
  reason: string = 'completed'
): Promise<{ ok: boolean; error?: string }> {
  console.log(`${LOG_PREFIX} Worker ${worker_id} releasing task ${vtid} (${reason})`);

  const result = await callRpc<{ ok: boolean; reason?: string }>('release_worker_task', {
    p_vtid: vtid,
    p_worker_id: worker_id,
    p_reason: reason,
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Emit release event
  await emitOasisEvent({
    vtid,
    type: 'worker.task.released' as any,
    source: 'worker-connector',
    status: 'info',
    message: `Task released: ${reason}`,
    payload: { worker_id, reason },
  });

  return { ok: true };
}

// =============================================================================
// Progress Reporting
// =============================================================================

/**
 * Report worker progress on a task
 */
export async function reportProgress(
  vtid: string,
  worker_id: string,
  progress: ProgressEvent
): Promise<{ ok: boolean; error?: string }> {
  console.log(`${LOG_PREFIX} Progress: ${vtid} - ${progress.event}`);

  // Verify worker has active claim
  const claimCheck = await supabaseRequest<Array<{ id: string }>>(
    `/rest/v1/worker_task_claims?vtid=eq.${encodeURIComponent(vtid)}&worker_id=eq.${encodeURIComponent(worker_id)}&released_at=is.null&select=id`
  );

  if (!claimCheck.ok || !claimCheck.data || claimCheck.data.length === 0) {
    return { ok: false, error: 'No active claim for this task' };
  }

  // Emit OASIS event for the event loop to process
  const eventResult = await emitOasisEvent({
    vtid,
    type: progress.event as any,
    source: 'worker-connector',
    status: 'info',
    message: progress.message || `Worker progress: ${progress.event}`,
    payload: {
      worker_id,
      ...progress.metadata,
    },
  });

  if (!eventResult.ok) {
    return { ok: false, error: eventResult.error };
  }

  // Update claim with progress
  await supabaseRequest(
    `/rest/v1/worker_task_claims?vtid=eq.${encodeURIComponent(vtid)}&worker_id=eq.${encodeURIComponent(worker_id)}&released_at=is.null`,
    {
      method: 'PATCH',
      body: {
        updated_at: new Date().toISOString(),
      },
    }
  );

  return { ok: true };
}

// =============================================================================
// Heartbeat
// =============================================================================

/**
 * Worker heartbeat - keeps claim alive
 */
export async function heartbeat(
  worker_id: string,
  active_vtid?: string
): Promise<{ ok: boolean; error?: string }> {
  const result = await callRpc<{ ok: boolean; reason?: string }>('worker_heartbeat', {
    p_worker_id: worker_id,
    p_active_vtid: active_vtid || null,
  });

  if (!result.ok || !(result.data as { ok: boolean }).ok) {
    return { ok: false, error: result.error || (result.data as { reason?: string }).reason };
  }

  return { ok: true };
}

// =============================================================================
// Cleanup
// =============================================================================

/**
 * Expire stale claims
 */
export async function expireStaleClaims(): Promise<{
  ok: boolean;
  expired_count?: number;
  error?: string;
}> {
  const result = await callRpc<number>('expire_stale_worker_claims', {});

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const count = result.data as number;
  if (count > 0) {
    console.log(`${LOG_PREFIX} Expired ${count} stale claims`);
  }

  return { ok: true, expired_count: count };
}

// =============================================================================
// Stats
// =============================================================================

/**
 * Get worker connector statistics
 */
export async function getWorkerStats(): Promise<{
  ok: boolean;
  stats?: Record<string, unknown>;
  error?: string;
}> {
  const result = await callRpc<Record<string, unknown>>('get_worker_connector_stats', {});

  return {
    ok: result.ok,
    stats: result.data,
    error: result.error,
  };
}

// =============================================================================
// Exports
// =============================================================================

export default {
  registerWorker,
  unregisterWorker,
  getWorker,
  listWorkers,
  getPendingTasks,
  getTaskSpec,
  claimTask,
  releaseTask,
  reportProgress,
  heartbeat,
  expireStaleClaims,
  getWorkerStats,
};
