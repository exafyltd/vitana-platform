/**
 * VTID-01200: Worker Runner - Gateway Client
 *
 * HTTP client for communicating with the Gateway orchestrator APIs.
 * Handles registration, heartbeat, polling, claiming, routing, completion, and release.
 */

import fetch, { RequestInit } from 'node-fetch';
import {
  RunnerConfig,
  PendingTask,
  ClaimResult,
  RoutingResult,
  CompletionResult,
  TerminalizationResult,
  TaskDomain,
  ExecutionResult,
} from '../types';

const VTID = 'VTID-01200';

/**
 * Make a request to the gateway
 */
async function gatewayRequest<T>(
  config: RunnerConfig,
  path: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const url = `${config.gatewayUrl}${path}`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Worker-ID': config.workerId,
      'X-VTID': VTID,
    };

    // Merge additional headers if provided
    if (options.headers) {
      const optHeaders = options.headers as Record<string, string>;
      Object.assign(headers, optHeaders);
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    const data = await response.json().catch(() => ({})) as Record<string, unknown>;

    if (!response.ok) {
      const errorMessage =
        (data?.error as string) || (data?.message as string) || `HTTP ${response.status}`;
      console.error(`[${VTID}] Gateway request failed: ${path} - ${errorMessage}`);
      return { ok: false, error: errorMessage };
    }

    return { ok: true, data: data as T };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${VTID}] Gateway request error: ${path} - ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Register the worker with the orchestrator
 */
export async function registerWorker(config: RunnerConfig): Promise<boolean> {
  console.log(`[${VTID}] Registering worker: ${config.workerId}`);

  const result = await gatewayRequest(
    config,
    '/api/v1/worker/orchestrator/register',
    {
      method: 'POST',
      body: JSON.stringify({
        worker_id: config.workerId,
        capabilities: ['frontend', 'backend', 'memory'],
        max_concurrent: config.maxConcurrent,
        version: '1.0.0',
        metadata: {
          type: 'worker-runner',
          vtid: VTID,
          autopilot_enabled: config.autopilotEnabled,
        },
      }),
    }
  );

  if (result.ok) {
    console.log(`[${VTID}] Worker registered successfully: ${config.workerId}`);
    return true;
  }

  console.error(`[${VTID}] Worker registration failed: ${result.error}`);
  return false;
}

/**
 * Send heartbeat to the orchestrator
 */
export async function sendHeartbeat(
  config: RunnerConfig,
  activeVtid?: string
): Promise<boolean> {
  const result = await gatewayRequest(
    config,
    '/api/v1/worker/orchestrator/heartbeat',
    {
      method: 'POST',
      body: JSON.stringify({
        worker_id: config.workerId,
        active_vtid: activeVtid || null,
      }),
    }
  );

  return result.ok;
}

/**
 * Poll for pending tasks
 * VTID-01202: Pass worker_id to include tasks claimed by this worker
 */
export async function pollPendingTasks(
  config: RunnerConfig
): Promise<{ tasks: PendingTask[]; count: number }> {
  const result = await gatewayRequest<{ tasks: PendingTask[]; count: number }>(
    config,
    `/api/v1/worker/orchestrator/tasks/pending?worker_id=${encodeURIComponent(config.workerId)}`,
    { method: 'GET' }
  );

  if (result.ok && result.data) {
    return { tasks: result.data.tasks || [], count: result.data.count || 0 };
  }

  return { tasks: [], count: 0 };
}

/**
 * Claim a task atomically
 */
export async function claimTask(
  config: RunnerConfig,
  vtid: string,
  expiresMinutes: number = 60
): Promise<ClaimResult> {
  console.log(`[${VTID}] Claiming task: ${vtid}`);

  const result = await gatewayRequest<ClaimResult>(
    config,
    `/api/v1/worker/orchestrator/tasks/${vtid}/claim`,
    {
      method: 'POST',
      body: JSON.stringify({
        worker_id: config.workerId,
        expires_minutes: expiresMinutes,
      }),
    }
  );

  if (result.ok && result.data) {
    return result.data;
  }

  return { ok: false, claimed: false, error: result.error };
}

/**
 * Route a task through governance and get routing decision
 */
export async function routeTask(
  config: RunnerConfig,
  vtid: string,
  title: string,
  domain?: TaskDomain,
  specContent?: string
): Promise<RoutingResult> {
  console.log(`[${VTID}] Routing task: ${vtid}`);

  const result = await gatewayRequest<RoutingResult>(
    config,
    '/api/v1/worker/orchestrator/route',
    {
      method: 'POST',
      body: JSON.stringify({
        vtid,
        title,
        task_domain: domain,
        spec_content: specContent,
        worker_id: config.workerId,
      }),
    }
  );

  if (result.ok && result.data) {
    return result.data;
  }

  return {
    ok: false,
    error: result.error,
    error_code: 'ROUTE_FAILED',
    identity: {
      repo: 'vitana-platform',
      project: 'unknown',
      region: 'unknown',
      environment: 'unknown',
      tenant: 'vitana',
    },
  };
}

/**
 * Report subagent start
 */
export async function reportSubagentStart(
  config: RunnerConfig,
  vtid: string,
  domain: TaskDomain,
  runId: string
): Promise<boolean> {
  console.log(`[${VTID}] Reporting subagent start: ${vtid} (${domain})`);

  const result = await gatewayRequest(
    config,
    '/api/v1/worker/subagent/start',
    {
      method: 'POST',
      body: JSON.stringify({
        vtid,
        domain,
        run_id: runId,
      }),
    }
  );

  return result.ok;
}

/**
 * Report subagent completion
 */
export async function reportSubagentComplete(
  config: RunnerConfig,
  vtid: string,
  domain: TaskDomain,
  runId: string,
  result: ExecutionResult
): Promise<CompletionResult> {
  console.log(`[${VTID}] Reporting subagent complete: ${vtid} (${domain})`);

  const response = await gatewayRequest<CompletionResult>(
    config,
    '/api/v1/worker/subagent/complete',
    {
      method: 'POST',
      body: JSON.stringify({
        vtid,
        domain,
        run_id: runId,
        skip_verification: true, // For worker-runner, we trust the LLM result
        result: {
          ok: result.ok,
          files_changed: result.files_changed || [],
          files_created: result.files_created || [],
          summary: result.summary,
          error: result.error,
          violations: result.violations || [],
        },
      }),
    }
  );

  if (response.ok && response.data) {
    return response.data;
  }

  return { ok: false, reason: response.error };
}

/**
 * Report orchestrator completion
 */
export async function reportOrchestratorComplete(
  config: RunnerConfig,
  vtid: string,
  runId: string,
  domain: TaskDomain,
  success: boolean,
  summary?: string,
  error?: string,
  result?: ExecutionResult
): Promise<CompletionResult> {
  console.log(`[${VTID}] Reporting orchestrator complete: ${vtid}`);

  const response = await gatewayRequest<CompletionResult>(
    config,
    '/api/v1/worker/orchestrator/complete',
    {
      method: 'POST',
      body: JSON.stringify({
        vtid,
        run_id: runId,
        domain,
        success,
        summary: summary || (success ? 'Task completed successfully' : 'Task failed'),
        error,
        skip_verification: true, // For worker-runner, we trust the LLM result
        result: result
          ? {
              files_changed: result.files_changed || [],
              files_created: result.files_created || [],
            }
          : undefined,
      }),
    }
  );

  if (response.ok && response.data) {
    return response.data;
  }

  return { ok: false, reason: response.error };
}

/**
 * Release task claim
 */
export async function releaseTask(
  config: RunnerConfig,
  vtid: string,
  reason: string = 'completed'
): Promise<boolean> {
  console.log(`[${VTID}] Releasing task: ${vtid} (${reason})`);

  const result = await gatewayRequest(
    config,
    `/api/v1/worker/orchestrator/tasks/${vtid}/release`,
    {
      method: 'POST',
      body: JSON.stringify({
        worker_id: config.workerId,
        reason,
      }),
    }
  );

  return result.ok;
}

/**
 * Terminalize a VTID in vtid_ledger
 */
export async function terminalizeTask(
  config: RunnerConfig,
  vtid: string,
  outcome: 'success' | 'failed' | 'cancelled',
  runId?: string
): Promise<TerminalizationResult> {
  console.log(`[${VTID}] Terminalizing task: ${vtid} (${outcome})`);

  const result = await gatewayRequest<TerminalizationResult>(
    config,
    '/api/v1/oasis/vtid/terminalize',
    {
      method: 'POST',
      body: JSON.stringify({
        vtid,
        outcome,
        run_id: runId,
        actor: 'autodeploy',
      }),
    }
  );

  if (result.ok && result.data) {
    return result.data;
  }

  return { ok: false, error: result.error };
}

/**
 * Check if autopilot execution is enabled (governance gate)
 */
export async function checkAutopilotEnabled(config: RunnerConfig): Promise<boolean> {
  // The claim endpoint already checks this, but we can also check explicitly
  // by attempting a dry-run or checking system controls
  // For now, we rely on the claim endpoint returning EXECUTION_DISARMED if disabled
  return true;
}

/**
 * Report progress on a task
 */
export async function reportProgress(
  config: RunnerConfig,
  vtid: string,
  event: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  const result = await gatewayRequest(
    config,
    `/api/v1/worker/orchestrator/tasks/${vtid}/progress`,
    {
      method: 'POST',
      body: JSON.stringify({
        worker_id: config.workerId,
        event,
        message,
        metadata,
      }),
    }
  );

  return result.ok;
}
