/**
 * VTID-01146: Execute VTID Runner (One-Button End-to-End Pipeline)
 *
 * Provides a single API call to trigger deterministic VTID execution:
 * Execute VTID → Worker → Validator → PR merge → Deploy health check → Mark terminal
 *
 * This enables the CEO loop to run with one command from Command Hub or curl.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { emitOasisEvent } from "../services/oasis-event-service";

export const router = Router();

// =============================================================================
// Environment Configuration
// =============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const GATEWAY_INTERNAL_URL = process.env.GATEWAY_INTERNAL_URL || 'http://localhost:8080';

// =============================================================================
// Schemas
// =============================================================================

// VTID format: VTID-XXXXX (4+ digits, e.g., VTID-01139)
const VTID_PATTERN = /^VTID-\d{4,}$/;

const ExecuteVtidRequestSchema = z.object({
  vtid: z.string().regex(VTID_PATTERN, "Invalid VTID format (expected VTID-XXXXX)"),
  mode: z.enum(["worker_only", "planner_worker_validator"]).default("worker_only"),
  automerge: z.boolean().default(true),
  head_branch: z.string().optional(), // Auto-detected if not provided
});

type ExecuteVtidRequest = z.infer<typeof ExecuteVtidRequestSchema>;

// Legacy schemas for backward compatibility
const PingSchema = z.object({
  vtid: z.string().regex(/^VTID-\d{4,}$/, "Invalid VTID format"),
  message: z.string().optional(),
});

const WorkflowSchema = z.object({
  vtid: z.string().regex(/^VTID-\d{4,}$/, "Invalid VTID format"),
  action: z.string().min(1, "Action required"),
  params: z.record(z.any()),
});

// =============================================================================
// Types
// =============================================================================

interface OasisTask {
  vtid: string;
  title: string;
  status: string;
  layer?: string;
  module?: string;
  is_terminal?: boolean;
  terminal_outcome?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface OasisSpec {
  vtid: string;
  content: string;
  version?: string;
  created_at?: string;
}

interface ExecutionContext {
  vtid: string;
  run_id: string;
  mode: string;
  automerge: boolean;
  head_branch?: string;
  task?: OasisTask;
  spec?: OasisSpec;
  started_at: string;
}

type ExecutionStage =
  | "requested"
  | "started"
  | "worker.started"
  | "worker.success"
  | "worker.failed"
  | "validator.started"
  | "validator.success"
  | "validator.failed"
  | "deploy.started"
  | "deploy.success"
  | "deploy.failed"
  | "completed"
  | "failed";

// =============================================================================
// OASIS Helpers
// =============================================================================

/**
 * Fetch task record from vtid_ledger
 */
async function fetchTask(vtid: string): Promise<OasisTask | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error("[VTID-01146] Missing Supabase credentials");
    return null;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${vtid}`,
      {
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }
    );

    if (!response.ok) {
      console.error(`[VTID-01146] Failed to fetch task: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as any[];
    if (data.length === 0) return null;

    const row = data[0];
    return {
      vtid: row.vtid,
      title: row.title,
      status: row.status,
      layer: row.layer,
      module: row.module,
      is_terminal: row.is_terminal ?? false,
      terminal_outcome: row.terminal_outcome ?? null,
      metadata: row.metadata ?? {},
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch (error) {
    console.error("[VTID-01146] Error fetching task:", error);
    return null;
  }
}

/**
 * Fetch spec from oasis_specs table
 */
async function fetchSpec(vtid: string): Promise<OasisSpec | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error("[VTID-01146] Missing Supabase credentials");
    return null;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_specs?vtid=eq.${vtid}&order=created_at.desc&limit=1`,
      {
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }
    );

    if (!response.ok) {
      console.error(`[VTID-01146] Failed to fetch spec: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as any[];
    if (data.length === 0) return null;

    const row = data[0];
    return {
      vtid: row.vtid,
      content: row.content || row.spec_content || row.markdown || "",
      version: row.version,
      created_at: row.created_at,
    };
  } catch (error) {
    console.error("[VTID-01146] Error fetching spec:", error);
    return null;
  }
}

/**
 * Check if execution is already in progress for this VTID
 */
async function checkExecutionStatus(vtid: string): Promise<{
  in_progress: boolean;
  run_id?: string;
  is_terminal?: boolean;
  terminal_outcome?: string;
}> {
  const task = await fetchTask(vtid);

  if (!task) {
    return { in_progress: false };
  }

  if (task.is_terminal) {
    return {
      in_progress: false,
      is_terminal: true,
      terminal_outcome: task.terminal_outcome || "unknown",
    };
  }

  if (task.status === "in_progress") {
    const run_id = (task.metadata as any)?.current_run_id;
    return { in_progress: true, run_id };
  }

  return { in_progress: false };
}

/**
 * Update task with run_id and status
 */
async function updateTaskStatus(
  vtid: string,
  status: string,
  run_id: string,
  additionalFields: Record<string, unknown> = {}
): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;

  try {
    const payload: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
      metadata: {
        current_run_id: run_id,
        last_execution_at: new Date().toISOString(),
        ...additionalFields,
      },
    };

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${vtid}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
        body: JSON.stringify(payload),
      }
    );

    return response.ok;
  } catch (error) {
    console.error("[VTID-01146] Error updating task status:", error);
    return false;
  }
}

/**
 * Mark task as terminal (completed or failed)
 */
async function markTerminal(
  vtid: string,
  outcome: "success" | "error",
  run_id: string
): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;

  try {
    const timestamp = new Date().toISOString();
    const payload = {
      status: outcome === "success" ? "completed" : "failed",
      is_terminal: true,
      terminal_outcome: outcome,
      completed_at: timestamp,
      updated_at: timestamp,
      metadata: {
        final_run_id: run_id,
        completed_at: timestamp,
      },
    };

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${vtid}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
        body: JSON.stringify(payload),
      }
    );

    return response.ok;
  } catch (error) {
    console.error("[VTID-01146] Error marking terminal:", error);
    return false;
  }
}

// =============================================================================
// Event Emission
// =============================================================================

/**
 * Emit execution stage event to OASIS
 */
async function emitStageEvent(
  ctx: ExecutionContext,
  stage: ExecutionStage,
  status: "info" | "success" | "warning" | "error",
  message: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await emitOasisEvent({
    vtid: ctx.vtid,
    type: `vtid.execute.${stage}`,
    source: "vtid-runner-v1",
    status,
    message,
    payload: {
      run_id: ctx.run_id,
      mode: ctx.mode,
      automerge: ctx.automerge,
      stage,
      ...payload,
    },
  });
}

// =============================================================================
// Execution Stages
// =============================================================================

/**
 * Execute Worker stage
 * For v1, this is a stub that simulates worker completion
 * In production, this would invoke the actual worker agent
 */
async function executeWorker(ctx: ExecutionContext): Promise<{
  success: boolean;
  error?: string;
  output?: Record<string, unknown>;
}> {
  console.log(`[VTID-01146] ${ctx.vtid} Worker stage starting...`);
  await emitStageEvent(ctx, "worker.started", "info", `Worker execution started for ${ctx.vtid}`);

  try {
    // In v1, worker is a pass-through since the spec drives work externally
    // The runner assumes work was done by Claude Code before this call
    // Future: integrate with worker-core-service for actual execution

    // Simulate minimal processing time
    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log(`[VTID-01146] ${ctx.vtid} Worker stage completed`);
    await emitStageEvent(ctx, "worker.success", "success", `Worker execution completed for ${ctx.vtid}`, {
      executor: "vtid-runner-stub",
      note: "v1 pass-through - work assumed completed externally",
    });

    return { success: true, output: { executor: "vtid-runner-stub" } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown worker error";
    console.error(`[VTID-01146] ${ctx.vtid} Worker failed:`, errorMessage);
    await emitStageEvent(ctx, "worker.failed", "error", `Worker failed: ${errorMessage}`, {
      error_code: "WORKER_ERROR",
      error_summary: errorMessage,
    });
    return { success: false, error: errorMessage };
  }
}

/**
 * Execute Validator stage
 * For v1, this validates that the spec exists and task is valid
 */
async function executeValidator(ctx: ExecutionContext): Promise<{
  success: boolean;
  error?: string;
  validation?: Record<string, unknown>;
}> {
  console.log(`[VTID-01146] ${ctx.vtid} Validator stage starting...`);
  await emitStageEvent(ctx, "validator.started", "info", `Validator execution started for ${ctx.vtid}`);

  try {
    const violations: string[] = [];

    // VAL-RULE-001: Task must exist
    if (!ctx.task) {
      violations.push("VAL-RULE-001: Task not found in OASIS");
    }

    // VAL-RULE-002: Spec should exist (warning if missing)
    if (!ctx.spec) {
      console.warn(`[VTID-01146] ${ctx.vtid} Spec not found - proceeding with warning`);
    }

    // VAL-RULE-003: Task must not be in terminal state
    if (ctx.task?.is_terminal) {
      violations.push("VAL-RULE-003: Task already in terminal state");
    }

    if (violations.length > 0) {
      const errorMessage = violations.join("; ");
      console.error(`[VTID-01146] ${ctx.vtid} Validation failed:`, errorMessage);
      await emitStageEvent(ctx, "validator.failed", "error", `Validation failed: ${errorMessage}`, {
        error_code: "VALIDATION_FAILED",
        violations,
      });
      return { success: false, error: errorMessage, validation: { violations } };
    }

    console.log(`[VTID-01146] ${ctx.vtid} Validator stage completed`);
    await emitStageEvent(ctx, "validator.success", "success", `Validation passed for ${ctx.vtid}`, {
      rules_checked: ["VAL-RULE-001", "VAL-RULE-002", "VAL-RULE-003"],
      spec_present: !!ctx.spec,
    });

    return { success: true, validation: { rules_checked: 3, passed: true } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown validator error";
    console.error(`[VTID-01146] ${ctx.vtid} Validator error:`, errorMessage);
    await emitStageEvent(ctx, "validator.failed", "error", `Validator error: ${errorMessage}`, {
      error_code: "VALIDATOR_ERROR",
      error_summary: errorMessage,
    });
    return { success: false, error: errorMessage };
  }
}

/**
 * Execute PR Merge stage via autonomous-pr-merge endpoint
 */
async function executePrMerge(ctx: ExecutionContext): Promise<{
  success: boolean;
  error?: string;
  pr_number?: number;
  pr_url?: string;
  merged?: boolean;
}> {
  if (!ctx.automerge) {
    console.log(`[VTID-01146] ${ctx.vtid} Skipping PR merge (automerge=false)`);
    return { success: true, merged: false };
  }

  if (!ctx.head_branch) {
    console.log(`[VTID-01146] ${ctx.vtid} No head_branch provided, skipping PR merge`);
    return { success: true, merged: false };
  }

  console.log(`[VTID-01146] ${ctx.vtid} PR merge stage starting...`);

  try {
    const mergePayload = {
      vtid: ctx.vtid,
      repo: "exafyltd/vitana-platform",
      head_branch: ctx.head_branch,
      base_branch: "main",
      title: `${ctx.vtid}: ${ctx.task?.title || "Execute VTID Runner"}`,
      body: `Implements ${ctx.vtid} via Execute VTID Runner.\n\nRun ID: ${ctx.run_id}`,
      merge_method: "squash",
      automerge: true,
      max_ci_wait_seconds: 600,
    };

    // Call the autonomous-pr-merge endpoint internally
    const response = await fetch(`${GATEWAY_INTERNAL_URL}/api/v1/github/autonomous-pr-merge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(mergePayload),
    });

    const result = (await response.json()) as {
      ok: boolean;
      error?: string;
      pr_number?: number;
      pr_url?: string;
      merged?: boolean;
    };

    if (!result.ok) {
      console.error(`[VTID-01146] ${ctx.vtid} PR merge failed:`, result.error);
      return {
        success: false,
        error: result.error || "PR merge failed",
        pr_number: result.pr_number,
        pr_url: result.pr_url,
      };
    }

    console.log(`[VTID-01146] ${ctx.vtid} PR merge completed: PR #${result.pr_number}`);
    return {
      success: true,
      pr_number: result.pr_number,
      pr_url: result.pr_url,
      merged: result.merged,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown PR merge error";
    console.error(`[VTID-01146] ${ctx.vtid} PR merge error:`, errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Execute Deploy Verification stage
 * Checks /alive and performs API smoke test
 */
async function executeDeployVerification(ctx: ExecutionContext): Promise<{
  success: boolean;
  error?: string;
  health?: Record<string, unknown>;
}> {
  console.log(`[VTID-01146] ${ctx.vtid} Deploy verification stage starting...`);
  await emitStageEvent(ctx, "deploy.started", "info", `Deploy verification started for ${ctx.vtid}`);

  try {
    // Resolve gateway URL dynamically via gcloud (in production)
    // For now, use the internal URL
    const gatewayUrl = GATEWAY_INTERNAL_URL;

    // Health check: /alive
    console.log(`[VTID-01146] ${ctx.vtid} Checking /alive...`);
    const aliveResponse = await fetch(`${gatewayUrl}/alive`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!aliveResponse.ok) {
      throw new Error(`Health check failed: ${aliveResponse.status}`);
    }

    const aliveData = (await aliveResponse.json()) as { status: string; [key: string]: unknown };
    console.log(`[VTID-01146] ${ctx.vtid} /alive check passed:`, aliveData);

    // API smoke test: check an API endpoint
    console.log(`[VTID-01146] ${ctx.vtid} Running API smoke test...`);
    const smokeResponse = await fetch(`${gatewayUrl}/api/v1/cicd/health`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!smokeResponse.ok) {
      throw new Error(`API smoke test failed: ${smokeResponse.status}`);
    }

    const smokeData = (await smokeResponse.json()) as { status: string; [key: string]: unknown };
    console.log(`[VTID-01146] ${ctx.vtid} API smoke test passed`);

    await emitStageEvent(ctx, "deploy.success", "success", `Deploy verification passed for ${ctx.vtid}`, {
      alive_status: aliveData.status,
      api_status: smokeData.status,
    });

    return {
      success: true,
      health: {
        alive: aliveData,
        api_smoke: { status: smokeData.status },
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown deploy verification error";
    console.error(`[VTID-01146] ${ctx.vtid} Deploy verification failed:`, errorMessage);
    await emitStageEvent(ctx, "deploy.failed", "error", `Deploy verification failed: ${errorMessage}`, {
      error_code: "DEPLOY_VERIFY_ERROR",
      error_summary: errorMessage,
    });
    return { success: false, error: errorMessage };
  }
}

// =============================================================================
// Main Execute VTID Endpoint
// =============================================================================

/**
 * POST /vtid - Execute VTID Runner
 *
 * Triggers a deterministic VTID execution run:
 * 1. Read task + spec from OASIS
 * 2. Check idempotency (already running/terminal)
 * 3. Execute Worker stage
 * 4. Execute Validator stage
 * 5. Execute PR merge (if automerge=true and head_branch provided)
 * 6. Verify deploy health
 * 7. Mark terminal in OASIS
 */
router.post("/vtid", async (req: Request, res: Response) => {
  const requestId = randomUUID();
  console.log(`[VTID-01146] Execute VTID request ${requestId} started`);

  try {
    // Parse and validate request
    const validation = ExecuteVtidRequestSchema.safeParse(req.body);
    if (!validation.success) {
      const details = validation.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
      return res.status(400).json({
        ok: false,
        error: `Invalid request payload: ${details}`,
        vtid: req.body?.vtid || "UNKNOWN",
      });
    }

    const { vtid, mode, automerge, head_branch } = validation.data;
    const run_id = `run_${new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15)}`;

    console.log(`[VTID-01146] ${vtid}: Starting execution (run_id=${run_id}, mode=${mode}, automerge=${automerge})`);

    // Step 1: Check idempotency
    const executionStatus = await checkExecutionStatus(vtid);

    if (executionStatus.is_terminal) {
      console.log(`[VTID-01146] ${vtid}: Already terminal (outcome=${executionStatus.terminal_outcome})`);
      return res.status(200).json({
        ok: true,
        vtid,
        already_terminal: true,
        terminal_outcome: executionStatus.terminal_outcome,
      });
    }

    if (executionStatus.in_progress && executionStatus.run_id) {
      console.log(`[VTID-01146] ${vtid}: Already running (run_id=${executionStatus.run_id})`);
      return res.status(200).json({
        ok: true,
        vtid,
        already_running: true,
        run_id: executionStatus.run_id,
      });
    }

    // Step 2: Read task and spec from OASIS
    const task = await fetchTask(vtid);
    if (!task) {
      console.error(`[VTID-01146] ${vtid}: Task not found in OASIS`);
      return res.status(404).json({
        ok: false,
        vtid,
        error: `Task ${vtid} not found in OASIS`,
      });
    }

    const spec = await fetchSpec(vtid);
    if (!spec) {
      console.warn(`[VTID-01146] ${vtid}: Spec not found - proceeding without spec`);
    }

    // Step 3: Create execution context
    const ctx: ExecutionContext = {
      vtid,
      run_id,
      mode,
      automerge,
      head_branch,
      task,
      spec: spec || undefined,
      started_at: new Date().toISOString(),
    };

    // Step 4: Emit execution requested event
    await emitStageEvent(ctx, "requested", "info", `VTID execution requested: ${vtid}`);

    // Step 5: Update task status to in_progress
    await updateTaskStatus(vtid, "in_progress", run_id);

    // Step 6: Emit execution started event
    await emitStageEvent(ctx, "started", "info", `VTID execution started: ${vtid}`, {
      task_title: task.title,
      spec_present: !!spec,
    });

    // Respond immediately with started status
    // Execution continues asynchronously
    res.status(200).json({
      ok: true,
      vtid,
      run_id,
      status: "started",
      links: {
        task: `/api/v1/oasis/tasks/${vtid}`,
        events: `/api/v1/oasis/events?vtid=${vtid}&limit=50`,
      },
    });

    // Continue execution asynchronously
    executeAsyncPipeline(ctx).catch((error) => {
      console.error(`[VTID-01146] ${vtid}: Async pipeline error:`, error);
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[VTID-01146] Execute VTID error:`, errorMessage);
    return res.status(500).json({
      ok: false,
      error: `Internal server error: ${errorMessage}`,
      vtid: req.body?.vtid || "UNKNOWN",
    });
  }
});

/**
 * Async execution pipeline
 * Runs Worker → Validator → PR Merge → Deploy Verify → Terminal
 */
async function executeAsyncPipeline(ctx: ExecutionContext): Promise<void> {
  console.log(`[VTID-01146] ${ctx.vtid}: Starting async pipeline...`);

  try {
    // Stage 1: Worker
    const workerResult = await executeWorker(ctx);
    if (!workerResult.success) {
      await markTerminal(ctx.vtid, "error", ctx.run_id);
      await emitStageEvent(ctx, "failed", "error", `Execution failed at worker stage: ${workerResult.error}`, {
        failed_stage: "worker",
        error: workerResult.error,
      });
      return;
    }

    // Stage 2: Validator
    const validatorResult = await executeValidator(ctx);
    if (!validatorResult.success) {
      await markTerminal(ctx.vtid, "error", ctx.run_id);
      await emitStageEvent(ctx, "failed", "error", `Execution failed at validator stage: ${validatorResult.error}`, {
        failed_stage: "validator",
        error: validatorResult.error,
      });
      return;
    }

    // Stage 3: PR Merge (optional)
    if (ctx.automerge && ctx.head_branch) {
      const mergeResult = await executePrMerge(ctx);
      if (!mergeResult.success) {
        await markTerminal(ctx.vtid, "error", ctx.run_id);
        await emitStageEvent(ctx, "failed", "error", `Execution failed at PR merge stage: ${mergeResult.error}`, {
          failed_stage: "pr_merge",
          error: mergeResult.error,
        });
        return;
      }
    }

    // Stage 4: Deploy Verification
    const deployResult = await executeDeployVerification(ctx);
    if (!deployResult.success) {
      await markTerminal(ctx.vtid, "error", ctx.run_id);
      await emitStageEvent(ctx, "failed", "error", `Execution failed at deploy verification: ${deployResult.error}`, {
        failed_stage: "deploy_verification",
        error: deployResult.error,
      });
      return;
    }

    // All stages passed - mark terminal success
    await markTerminal(ctx.vtid, "success", ctx.run_id);
    await emitStageEvent(ctx, "completed", "success", `VTID execution completed successfully: ${ctx.vtid}`, {
      worker: "success",
      validator: "success",
      deploy_verified: true,
    });

    console.log(`[VTID-01146] ${ctx.vtid}: Execution completed successfully!`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown pipeline error";
    console.error(`[VTID-01146] ${ctx.vtid}: Pipeline error:`, errorMessage);
    await markTerminal(ctx.vtid, "error", ctx.run_id);
    await emitStageEvent(ctx, "failed", "error", `Execution failed with error: ${errorMessage}`, {
      failed_stage: "unknown",
      error: errorMessage,
    });
  }
}

// =============================================================================
// Legacy Endpoints (Backward Compatibility)
// =============================================================================

router.post("/ping", async (req: Request, res: Response) => {
  try {
    const body = PingSchema.parse(req.body);
    const now = new Date().toISOString();

    console.log(`🏓 Execute ping: ${body.vtid} - ${body.message || "PING"}`);

    return res.status(200).json({
      ok: true,
      when: now,
      echo: body.message || "PING",
      vtid: body.vtid,
      bridge: "execution-bridge-v1",
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payload",
        detail: e.errors,
      });
    }

    console.error("❌ Execute ping error:", e);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      detail: e.message,
    });
  }
});

router.post("/workflow", async (req: Request, res: Response) => {
  try {
    const body = WorkflowSchema.parse(req.body);

    if (!body.action.includes(".")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid action format",
        detail: "Action must be in format: namespace.operation (e.g., deploy.service)",
      });
    }

    const execution_id = `ex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    console.log(`🚀 Workflow execution requested: ${execution_id}`);
    console.log(`   VTID: ${body.vtid}`);
    console.log(`   Action: ${body.action}`);
    console.log(`   Params:`, JSON.stringify(body.params));

    return res.status(200).json({
      ok: true,
      execution_id,
      vtid: body.vtid,
      action: body.action,
      status: "validated",
      message: "Workflow validated - execution stub only (no actual execution)",
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payload",
        detail: e.errors,
      });
    }

    console.error("❌ Execute workflow error:", e);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      detail: e.message,
    });
  }
});

router.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "execution-bridge",
    version: "1.1.0",
    vtid: "VTID-01146",
    timestamp: new Date().toISOString(),
    capabilities: {
      execute_vtid: true,
      worker_only_mode: true,
      automerge: true,
      deploy_verification: true,
    },
    models: {
      planner: "Claude 3.5 Sonnet",
      executor: "Gemini Pro 1.5",
      forbidden: ["Gemini Flash 1.5"],
    },
  });
});
