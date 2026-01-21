/**
 * VTID-01200: Worker Runner - OASIS Event Emitter
 *
 * Emits OASIS events for observability of the worker-runner execution plane.
 * Uses the same event emitter pattern as the gateway.
 */

import { randomUUID } from 'crypto';
import { OasisEventPayload, RunnerConfig, TaskDomain, TerminalOutcome } from '../types';

const VTID = 'VTID-01200';

/**
 * Emit an event to OASIS via Supabase
 */
export async function emitOasisEvent(
  config: RunnerConfig,
  event: OasisEventPayload
): Promise<{ ok: boolean; event_id?: string; error?: string }> {
  const { supabaseUrl, supabaseKey } = config;

  if (!supabaseUrl || !supabaseKey) {
    console.error(`[${VTID}] Missing Supabase credentials for event emission`);
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  const payload = {
    id: eventId,
    created_at: timestamp,
    vtid: event.vtid,
    topic: event.type,
    service: event.source,
    role: 'CICD',
    model: 'worker-runner-execution-plane',
    status: event.status,
    message: event.message,
    link: null,
    metadata: event.payload || {},
  };

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Failed to emit event: ${response.status} - ${errorText}`);
      return { ok: false, error: `Failed to emit event: ${response.status}` };
    }

    console.log(`[OASIS Event] Emitted: ${event.type} for ${event.vtid} (${eventId})`);
    return { ok: true, event_id: eventId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${VTID}] Error emitting event: ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Worker Runner Event Helpers
 */
export const runnerEvents = {
  /**
   * Emit worker registered event
   */
  registered: (config: RunnerConfig) =>
    emitOasisEvent(config, {
      vtid: VTID,
      type: 'worker_runner.registered',
      source: 'worker-runner',
      status: 'success',
      message: `Worker runner registered: ${config.workerId}`,
      payload: {
        worker_id: config.workerId,
        max_concurrent: config.maxConcurrent,
        poll_interval_ms: config.pollIntervalMs,
        autopilot_enabled: config.autopilotEnabled,
        registered_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit heartbeat event
   */
  heartbeat: (config: RunnerConfig, activeVtid?: string) =>
    emitOasisEvent(config, {
      vtid: activeVtid || VTID,
      type: 'worker_runner.heartbeat',
      source: 'worker-runner',
      status: 'info',
      message: `Heartbeat from ${config.workerId}`,
      payload: {
        worker_id: config.workerId,
        active_vtid: activeVtid || null,
        heartbeat_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit polled event
   */
  polled: (
    config: RunnerConfig,
    pendingCount: number,
    eligibleCount: number
  ) =>
    emitOasisEvent(config, {
      vtid: VTID,
      type: 'worker_runner.polled',
      source: 'worker-runner',
      status: 'info',
      message: `Polled: ${pendingCount} pending, ${eligibleCount} eligible`,
      payload: {
        worker_id: config.workerId,
        pending_count: pendingCount,
        eligible_count: eligibleCount,
        polled_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit claimed event
   */
  claimed: (config: RunnerConfig, vtid: string, expiresAt: string) =>
    emitOasisEvent(config, {
      vtid,
      type: 'worker_runner.claimed',
      source: 'worker-runner',
      status: 'success',
      message: `Task ${vtid} claimed by ${config.workerId}`,
      payload: {
        worker_id: config.workerId,
        vtid,
        expires_at: expiresAt,
        claimed_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit claim failed event
   */
  claimFailed: (config: RunnerConfig, vtid: string, reason: string) =>
    emitOasisEvent(config, {
      vtid,
      type: 'worker_runner.claim_failed',
      source: 'worker-runner',
      status: 'warning',
      message: `Claim failed for ${vtid}: ${reason}`,
      payload: {
        worker_id: config.workerId,
        vtid,
        reason,
        failed_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit routed event
   */
  routed: (
    config: RunnerConfig,
    vtid: string,
    dispatchedTo: string,
    runId: string
  ) =>
    emitOasisEvent(config, {
      vtid,
      type: 'worker_runner.routed',
      source: 'worker-runner',
      status: 'info',
      message: `Task ${vtid} routed to ${dispatchedTo}`,
      payload: {
        worker_id: config.workerId,
        vtid,
        dispatched_to: dispatchedTo,
        run_id: runId,
        routed_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit execution started event
   */
  execStarted: (
    config: RunnerConfig,
    vtid: string,
    domain: TaskDomain,
    runId: string,
    model: string,
    provider: string
  ) =>
    emitOasisEvent(config, {
      vtid,
      type: 'worker_runner.exec_started',
      source: 'worker-runner',
      status: 'info',
      message: `Execution started for ${vtid} (${domain})`,
      payload: {
        worker_id: config.workerId,
        vtid,
        domain,
        run_id: runId,
        model,
        provider,
        started_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit execution completed event
   */
  execCompleted: (
    config: RunnerConfig,
    vtid: string,
    domain: TaskDomain,
    runId: string,
    durationMs: number,
    model: string,
    provider: string,
    success: boolean,
    summary?: string
  ) =>
    emitOasisEvent(config, {
      vtid,
      type: 'worker_runner.exec_completed',
      source: 'worker-runner',
      status: success ? 'success' : 'error',
      message: success
        ? `Execution completed for ${vtid}: ${summary || 'Success'}`
        : `Execution failed for ${vtid}`,
      payload: {
        worker_id: config.workerId,
        vtid,
        domain,
        run_id: runId,
        duration_ms: durationMs,
        model,
        provider,
        success,
        summary,
        completed_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit terminalized event
   */
  terminalized: (
    config: RunnerConfig,
    vtid: string,
    outcome: TerminalOutcome,
    runId: string
  ) =>
    emitOasisEvent(config, {
      vtid,
      type: 'worker_runner.terminalized',
      source: 'worker-runner',
      status: outcome === 'success' ? 'success' : 'error',
      message: `Task ${vtid} terminalized: ${outcome}`,
      payload: {
        worker_id: config.workerId,
        vtid,
        outcome,
        run_id: runId,
        terminalized_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit runner error event
   */
  error: (config: RunnerConfig, error: string, vtid?: string) =>
    emitOasisEvent(config, {
      vtid: vtid || VTID,
      type: 'worker_runner.error',
      source: 'worker-runner',
      status: 'error',
      message: `Runner error: ${error}`,
      payload: {
        worker_id: config.workerId,
        error,
        vtid,
        error_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit governance blocked event
   */
  governanceBlocked: (config: RunnerConfig, reason: string) =>
    emitOasisEvent(config, {
      vtid: VTID,
      type: 'worker_runner.governance_blocked',
      source: 'worker-runner',
      status: 'warning',
      message: `Runner idle: ${reason}`,
      payload: {
        worker_id: config.workerId,
        reason,
        blocked_at: new Date().toISOString(),
      },
    }),
};
