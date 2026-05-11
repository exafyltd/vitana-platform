/**
 * VTID-01200: Worker Runner - Runner Service
 *
 * Main runner service that orchestrates the execution loop:
 * 1. Register with orchestrator
 * 2. Heartbeat automatically
 * 3. Poll for pending tasks
 * 4. Claim eligible tasks
 * 5. Route through governance
 * 6. Execute work via LLM
 * 7. Complete and terminalize
 */

import { randomUUID } from 'crypto';
import {
  RunnerConfig,
  RunnerMetrics,
  RunnerState,
  PendingTask,
  TaskDomain,
  TerminalOutcome,
  ExecutionResult,
} from '../types';
import {
  registerWorker,
  sendHeartbeat,
  pollPendingTasks,
  claimTask,
  routeTask,
  reportSubagentStart,
  reportSubagentComplete,
  reportOrchestratorComplete,
  releaseTask,
  terminalizeTask,
  reportProgress,
} from './gateway-client';
import { executeTask, getModelInfo } from './execution-service';
import { runnerEvents } from './event-emitter';

const VTID = 'VTID-01200';
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
const MAX_CLAIM_RETRIES = 3;

function isSelfHealingTask(task: PendingTask): boolean {
  return task.metadata?.source === 'self-healing';
}

function hasRepairEvidence(result: ExecutionResult): boolean {
  return (result.files_changed?.length || 0) + (result.files_created?.length || 0) > 0;
}

/**
 * Worker Runner Service
 */
export class WorkerRunner {
  private config: RunnerConfig;
  private metrics: RunnerMetrics;
  private running: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private activeVtid: string | null = null;

  constructor(config: RunnerConfig) {
    this.config = config;
    this.metrics = {
      registered_at: '',
      last_heartbeat_at: '',
      tasks_polled: 0,
      tasks_claimed: 0,
      tasks_completed: 0,
      tasks_failed: 0,
      state: 'idle',
    };
  }

  /**
   * Start the runner
   */
  async start(): Promise<boolean> {
    if (this.running) {
      console.log(`[${VTID}] Runner already running`);
      return true;
    }

    console.log(`[${VTID}] Starting worker runner: ${this.config.workerId}`);

    // Check if autopilot is enabled
    if (!this.config.autopilotEnabled) {
      console.log(`[${VTID}] Autopilot disabled, runner will idle`);
      await runnerEvents.governanceBlocked(this.config, 'AUTOPILOT_LOOP_ENABLED=false');
    }

    // Register with orchestrator
    const registered = await registerWorker(this.config);
    if (!registered) {
      console.error(`[${VTID}] Failed to register worker`);
      return false;
    }

    this.metrics.registered_at = new Date().toISOString();
    await runnerEvents.registered(this.config);

    this.running = true;

    // Start heartbeat timer
    this.heartbeatTimer = setInterval(
      () => this.doHeartbeat(),
      HEARTBEAT_INTERVAL_MS
    );

    // Start poll timer
    this.pollTimer = setInterval(
      () => this.doPoll(),
      this.config.pollIntervalMs
    );

    // Do initial poll
    await this.doPoll();

    console.log(`[${VTID}] Runner started successfully`);
    return true;
  }

  /**
   * Stop the runner
   */
  async stop(): Promise<void> {
    console.log(`[${VTID}] Stopping worker runner`);

    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Release any active claim
    if (this.activeVtid) {
      await releaseTask(this.config, this.activeVtid, 'runner_stopped');
      this.activeVtid = null;
    }

    console.log(`[${VTID}] Runner stopped`);
  }

  /**
   * Send heartbeat
   */
  private async doHeartbeat(): Promise<void> {
    const success = await sendHeartbeat(this.config, this.activeVtid || undefined);
    if (success) {
      this.metrics.last_heartbeat_at = new Date().toISOString();
      // Heartbeats are telemetry, not state changes - log only, no OASIS event
    }
  }

  /**
   * Poll for pending tasks
   */
  private async doPoll(): Promise<void> {
    if (!this.running) return;

    // Don't poll if we're already processing a task
    if (this.activeVtid) {
      return;
    }

    // Don't poll if autopilot is disabled
    if (!this.config.autopilotEnabled) {
      return;
    }

    this.metrics.state = 'polling';
    this.metrics.last_poll_at = new Date().toISOString();

    try {
      const { tasks, count } = await pollPendingTasks(this.config);
      this.metrics.tasks_polled += count;

      // Filter for eligible tasks
      const eligible = tasks.filter((task) => this.isTaskEligible(task));

      // Log for debugging (no OASIS event - polling is telemetry, not state change)
      console.log(`[${VTID}] Polled: ${count} pending, ${eligible.length} eligible`);

      if (eligible.length === 0) {
        this.metrics.state = 'idle';
        return;
      }

      // Process the first eligible task
      const task = eligible[0];
      await this.processTask(task);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${VTID}] Poll error: ${errorMessage}`);
      await runnerEvents.error(this.config, `Poll error: ${errorMessage}`);
      this.metrics.state = 'idle';
    }
  }

  /**
   * Check if a task is eligible for execution
   */
  private isTaskEligible(task: PendingTask): boolean {
    // Accept scheduled (ready for pickup) or in_progress (already transitioned).
    // Self-healing injector sets 'scheduled'; worker-runner is the reliable
    // pickup mechanism — claim + route transitions status to in_progress.
    if (task.status !== 'in_progress' && task.status !== 'scheduled') {
      return false;
    }

    // Spec must be approved
    if (task.spec_status !== 'approved') {
      return false;
    }

    // Must not be terminal
    if (task.is_terminal) {
      return false;
    }

    // Must not be claimed by another worker
    if (task.claimed_by && task.claimed_by !== this.config.workerId) {
      return false;
    }

    return true;
  }

  /**
   * Process a single task through the execution pipeline
   */
  private async processTask(task: PendingTask): Promise<void> {
    const vtid = task.vtid;
    console.log(`[${VTID}] Processing task: ${vtid}`);

    // Step 1: Claim the task
    this.metrics.state = 'claiming';
    const claimResult = await this.claimWithRetry(vtid);

    if (!claimResult.claimed) {
      console.log(`[${VTID}] Failed to claim ${vtid}: ${claimResult.error}`);
      await runnerEvents.claimFailed(this.config, vtid, claimResult.error || 'Unknown');
      this.metrics.state = 'idle';
      return;
    }

    this.activeVtid = vtid;
    this.metrics.tasks_claimed++;
    await runnerEvents.claimed(this.config, vtid, claimResult.expires_at || '');

    // Track execution for cleanup
    let executionSuccess = false;
    let runId = `run_${randomUUID().slice(0, 8)}`;
    let domain: TaskDomain = 'backend';
    let executionResult: ExecutionResult = { ok: false, error: 'Not executed', duration_ms: 0 };

    try {
      if (isSelfHealingTask(task) && !task.spec_content?.trim()) {
        throw new Error(`Self-healing task ${vtid} has no hydrated spec_content`);
      }

      // Step 2: Route through governance
      this.metrics.state = 'executing';
      const routingResult = await routeTask(
        this.config,
        vtid,
        task.title,
        task.task_domain,
        task.spec_content,
        task.target_paths
      );

      if (!routingResult.ok) {
        console.error(`[${VTID}] Routing failed for ${vtid}: ${routingResult.error}`);
        await runnerEvents.error(this.config, `Routing failed: ${routingResult.error}`, vtid);

        // Mark as failed
        executionSuccess = await this.completeTask(vtid, runId, domain, false, routingResult.error);
        return;
      }

      runId = routingResult.run_id || runId;

      // Resolve execution domain(s) from routing result
      // For mixed tasks, routing returns stages instead of dispatched_to
      const stages = routingResult.stages;
      if (stages && stages.length > 0) {
        // Mixed task: execute stages sequentially, succeed if ANY stage succeeds
        domain = stages[0].domain;
        console.log(`[${VTID}] Mixed task ${vtid}: ${stages.length} stages: ${stages.map(s => s.domain).join(' → ')}`);

        await runnerEvents.routed(
          this.config,
          vtid,
          `worker-${stages.map(s => s.domain).join('+')}`,
          runId
        );

        const modelInfo = getModelInfo(this.config);
        let anyStageSucceeded = false;
        let lastError: string | undefined;
        const allResults: ExecutionResult[] = [];

        for (const stage of stages) {
          const stageDomain = stage.domain;
          console.log(`[${VTID}] Executing stage ${stage.order}/${stages.length}: ${stageDomain} for ${vtid}`);

          await reportSubagentStart(this.config, vtid, stageDomain, runId);
          await runnerEvents.execStarted(this.config, vtid, stageDomain, runId, modelInfo.model, modelInfo.provider);

          const stageResult = await executeTask(this.config, task, routingResult, stageDomain);
          allResults.push(stageResult);

          await runnerEvents.execCompleted(
            this.config, vtid, stageDomain, runId,
            stageResult.duration_ms || 0, modelInfo.model, modelInfo.provider,
            stageResult.ok, stageResult.summary
          );

          if (stageResult.ok) {
            anyStageSucceeded = true;
            // Merge successful results
            executionResult = {
              ...executionResult,
              ...stageResult,
              ok: true,
              summary: (executionResult.summary ? executionResult.summary + ' | ' : '') + (stageResult.summary || ''),
              files_changed: [...(executionResult.files_changed || []), ...(stageResult.files_changed || [])],
              files_created: [...(executionResult.files_created || []), ...(stageResult.files_created || [])],
            };
          } else {
            lastError = stageResult.error;
            console.log(`[${VTID}] Stage ${stageDomain} failed for ${vtid}: ${stageResult.error} — continuing to next stage`);
          }
        }

        executionSuccess = anyStageSucceeded;
        domain = stages[0].domain; // Use first stage domain for completion reporting

        if (!anyStageSucceeded) {
          executionResult = { ok: false, error: lastError || 'All stages failed', duration_ms: 0 };
        }

        executionResult = this.applySelfHealingEvidenceGate(task, executionResult);
        executionSuccess = executionResult.ok;
      } else {
        // Single domain: original behavior
        domain = (routingResult.dispatched_to?.replace('worker-', '') || 'backend') as TaskDomain;

        await runnerEvents.routed(
          this.config,
          vtid,
          routingResult.dispatched_to || 'worker-backend',
          runId
        );

        // Step 3: Report subagent start
        await reportSubagentStart(this.config, vtid, domain, runId);

        // Get model info for events
        const modelInfo = getModelInfo(this.config);

        await runnerEvents.execStarted(
          this.config,
          vtid,
          domain,
          runId,
          modelInfo.model,
          modelInfo.provider
        );

        // Step 4: Execute the actual work
        executionResult = await executeTask(this.config, task, routingResult, domain);

        await runnerEvents.execCompleted(
          this.config,
          vtid,
          domain,
          runId,
          executionResult.duration_ms || 0,
          modelInfo.model,
          modelInfo.provider,
          executionResult.ok,
          executionResult.summary
        );

        executionResult = this.applySelfHealingEvidenceGate(task, executionResult);
        executionSuccess = executionResult.ok;
      }

      // Step 5: Complete the task
      executionSuccess = await this.completeTask(
        vtid,
        runId,
        domain,
        executionSuccess,
        executionResult.error,
        executionResult
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${VTID}] Task processing error for ${vtid}: ${errorMessage}`);
      await runnerEvents.error(this.config, `Processing error: ${errorMessage}`, vtid);

      // Attempt to complete as failed
      executionSuccess = await this.completeTask(vtid, runId, domain, false, errorMessage);
    } finally {
      // Always release claim and cleanup
      await releaseTask(this.config, vtid, executionSuccess ? 'completed' : 'failed');
      this.activeVtid = null;
      this.metrics.state = 'idle';
    }
  }

  private applySelfHealingEvidenceGate(task: PendingTask, result: ExecutionResult): ExecutionResult {
    if (!isSelfHealingTask(task) || !result.ok) {
      return result;
    }

    if (hasRepairEvidence(result)) {
      return result;
    }

    return {
      ...result,
      ok: false,
      error: `Self-healing task ${task.vtid} reported success without repair evidence`,
      summary: result.summary || 'Self-healing success rejected: no files changed or created',
    };
  }

  /**
   * Claim a task with retry
   */
  private async claimWithRetry(
    vtid: string,
    retries: number = MAX_CLAIM_RETRIES
  ): Promise<{ claimed: boolean; expires_at?: string; error?: string }> {
    for (let i = 0; i < retries; i++) {
      const result = await claimTask(this.config, vtid);

      if (result.claimed) {
        return result;
      }

      // Check for governance blocked
      if (result.error?.includes('EXECUTION_DISARMED')) {
        return { claimed: false, error: 'Execution is disarmed' };
      }

      // Wait before retry
      if (i < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
      }
    }

    return { claimed: false, error: 'Max retries exceeded' };
  }

  /**
   * Complete a task (subagent complete + orchestrator complete + terminalize)
   */
  private async completeTask(
    vtid: string,
    runId: string,
    domain: TaskDomain,
    success: boolean,
    error?: string,
    result?: { ok: boolean; files_changed?: string[]; files_created?: string[]; summary?: string; error?: string }
  ): Promise<boolean> {
    this.metrics.state = 'completing';

    try {
      let finalSuccess = success;
      let finalError = error;
      const completionPayload: ExecutionResult = {
        ok: success,
        files_changed: result?.files_changed || [],
        files_created: result?.files_created || [],
        summary: result?.summary || (success ? 'Task completed' : error),
        error: success ? undefined : error,
      };

      // Report subagent completion
      const subagentCompletion = await reportSubagentComplete(this.config, vtid, domain, runId, completionPayload);

      if (!subagentCompletion.ok) {
        finalSuccess = false;
        finalError = `Subagent completion rejected: ${subagentCompletion.reason || 'unknown reason'}`;
        await runnerEvents.error(this.config, finalError, vtid);
      }

      const orchestratorPayload: ExecutionResult = finalSuccess
        ? completionPayload
        : {
            ...completionPayload,
            ok: false,
            summary: 'Worker completion rejected by verification',
            error: finalError,
          };

      // Report orchestrator completion
      const orchestratorCompletion = await reportOrchestratorComplete(
        this.config,
        vtid,
        runId,
        domain,
        finalSuccess,
        finalSuccess ? result?.summary : 'Worker completion rejected by verification',
        finalSuccess ? error : finalError,
        orchestratorPayload
      );

      if (!orchestratorCompletion.ok) {
        finalSuccess = false;
        finalError = `Orchestrator completion rejected: ${orchestratorCompletion.reason || 'unknown reason'}`;
        await runnerEvents.error(this.config, finalError, vtid);
      }

      // Update metrics
      if (finalSuccess) {
        this.metrics.tasks_completed++;
      } else {
        this.metrics.tasks_failed++;
      }

      // Step 6: Terminalize the VTID
      this.metrics.state = 'terminalizing';
      const outcome: TerminalOutcome = finalSuccess ? 'success' : 'failed';
      const termResult = await terminalizeTask(this.config, vtid, outcome, runId);

      if (termResult.ok) {
        await runnerEvents.terminalized(this.config, vtid, outcome, runId);
        console.log(`[${VTID}] Task ${vtid} terminalized: ${outcome}`);
        return finalSuccess;
      } else if (!termResult.already_terminal) {
        console.error(`[${VTID}] Failed to terminalize ${vtid}: ${termResult.error}`);
        await runnerEvents.error(this.config, `Terminalization failed: ${termResult.error}`, vtid);
      } else {
        console.log(`[${VTID}] Task ${vtid} already terminal (idempotent)`);
        return finalSuccess;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${VTID}] Completion error for ${vtid}: ${errorMessage}`);
      await runnerEvents.error(this.config, `Completion error: ${errorMessage}`, vtid);
    }

    return false;
  }

  /**
   * VTID-01206: Trigger execution of a specific VTID immediately
   * Called by gateway when task moves to in_progress - push model instead of polling
   */
  async triggerExecution(vtid: string): Promise<{ ok: boolean; error?: string }> {
    console.log(`[${VTID}] Trigger execution received for ${vtid}`);

    // Check if already processing a task
    if (this.activeVtid) {
      console.log(`[${VTID}] Already processing ${this.activeVtid}, cannot trigger ${vtid}`);
      return { ok: false, error: `Already processing ${this.activeVtid}` };
    }

    // Check if autopilot is enabled
    if (!this.config.autopilotEnabled) {
      console.log(`[${VTID}] Autopilot disabled, cannot trigger ${vtid}`);
      return { ok: false, error: 'Autopilot disabled' };
    }

    // Fetch the task from pending queue to get full details
    try {
      const { tasks } = await pollPendingTasks(this.config);
      const task = tasks.find(t => t.vtid === vtid);

      if (!task) {
        console.log(`[${VTID}] Task ${vtid} not found in pending queue`);
        return { ok: false, error: 'Task not found in pending queue' };
      }

      // Check eligibility
      if (!this.isTaskEligible(task)) {
        console.log(`[${VTID}] Task ${vtid} not eligible for execution`);
        return { ok: false, error: 'Task not eligible (check status, spec_status, is_terminal)' };
      }

      // Process the task immediately
      console.log(`[${VTID}] Starting immediate execution of ${vtid}`);
      await this.processTask(task);

      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${VTID}] Trigger execution error for ${vtid}: ${errorMessage}`);
      return { ok: false, error: errorMessage };
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): RunnerMetrics {
    return {
      ...this.metrics,
      active_vtid: this.activeVtid || undefined,
    };
  }

  /**
   * Check if runner is healthy
   */
  isHealthy(): boolean {
    return this.running;
  }
}

/**
 * Create a runner with configuration from environment
 */
export function createRunnerFromEnv(): WorkerRunner {
  const config: RunnerConfig = {
    workerId: `${process.env.WORKER_ID_PREFIX || 'worker-runner'}-${randomUUID().slice(0, 8)}`,
    gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:8080',
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE || '',
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
    autopilotEnabled: process.env.AUTOPILOT_LOOP_ENABLED !== 'false',
    maxConcurrent: 1, // Hard governance: one VTID at a time per worker
    vertexProject: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT,
    vertexLocation: process.env.VERTEX_LOCATION,
    vertexModel: process.env.VERTEX_MODEL,
  };

  return new WorkerRunner(config);
}
