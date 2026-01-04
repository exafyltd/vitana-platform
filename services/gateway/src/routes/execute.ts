/**
 * VTID-01146: Execute VTID Runner (One-Button End-to-End Pipeline)
 * VTID-01150: Runner → Claude Execution Bridge (No CI/CD Duplication)
 *
 * Provides a single API call to trigger deterministic VTID execution:
 * Execute VTID → Worker → Validator → PR merge → Deploy health check → Mark terminal
 *
 * VTID-01150 Changes:
 * - Spec loading is MANDATORY (hard fail if missing)
 * - Worker execution triggers REAL Claude work via work-order event
 * - Runner WAITS for evidence (PR opened, commits pushed, worker reported)
 * - Runner does NOT emit success events unless externally confirmed
 * - Completion deferred to existing CI/CD terminal gate
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
// VTID-01150: Work Order & Evidence Types
// =============================================================================

/**
 * VTID-01150: Work order dispatched to Claude for real execution
 */
interface WorkOrder {
  vtid: string;
  run_id: string;
  spec_content: string;
  spec_version?: string;
  repository: string;
  branch_convention: string;
  task_title: string;
  dispatched_at: string;
}

/**
 * VTID-01150: Evidence types that confirm worker success
 */
type EvidenceType = 'pr_opened' | 'commits_pushed' | 'worker_reported';

/**
 * VTID-01150: Evidence payload for worker success confirmation
 */
interface WorkerEvidence {
  type: EvidenceType;
  vtid: string;
  run_id: string;
  timestamp: string;
  pr_number?: number;
  pr_url?: string;
  branch_name?: string;
  commit_sha?: string;
  commits?: Array<{ sha: string; message: string }>;
  reporter?: string;
  message?: string;
}

/**
 * VTID-01150: Configuration for evidence polling
 * VTID-01150-fix: Made configurable via environment variables for testing
 */
const EVIDENCE_POLL_CONFIG = {
  /** Maximum time to wait for evidence (in milliseconds) - default 30 minutes, configurable */
  MAX_WAIT_MS: parseInt(process.env.VTID_EVIDENCE_MAX_WAIT_MS || '1800000', 10),
  /** Interval between evidence checks (in milliseconds) - default 30 seconds */
  POLL_INTERVAL_MS: parseInt(process.env.VTID_EVIDENCE_POLL_INTERVAL_MS || '30000', 10),
  /** Repository for work orders */
  REPOSITORY: 'exafyltd/vitana-platform',
  /** Branch naming convention */
  BRANCH_CONVENTION: 'claude/vtid-{vtid}-*',
};

// =============================================================================
// OASIS Helpers
// =============================================================================

/**
 * Fetch task record from vtid_ledger
 */
async function fetchTask(vtid: string): Promise<OasisTask | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error("[VTID-01150] Missing Supabase credentials");
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
      console.error(`[VTID-01150] Failed to fetch task: ${response.status}`);
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
    console.error("[VTID-01150] Error fetching task:", error);
    return null;
  }
}

/**
 * Fetch spec from oasis_specs table
 */
async function fetchSpec(vtid: string): Promise<OasisSpec | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error("[VTID-01150] Missing Supabase credentials");
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
      console.error(`[VTID-01150] Failed to fetch spec: ${response.status}`);
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
    console.error("[VTID-01150] Error fetching spec:", error);
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
    console.error("[VTID-01150] Error updating task status:", error);
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
    console.error("[VTID-01150] Error marking terminal:", error);
    return false;
  }
}

// =============================================================================
// Event Emission
// =============================================================================

/**
 * Emit execution stage event to OASIS
 * VTID-01150: Updated to use vtid-runner-v2 source
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
    source: "vtid-runner-v2", // VTID-01150: Updated from v1 to v2
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
// VTID-01150: Work Order Dispatch & Evidence Functions
// =============================================================================

/**
 * VTID-01150: Dispatch work order to OASIS for Claude to poll
 * Claude is expected to poll for work orders and execute the spec.
 */
async function dispatchWorkOrder(ctx: ExecutionContext): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.spec) {
    return { ok: false, error: 'Cannot dispatch work order without spec' };
  }

  const workOrder: WorkOrder = {
    vtid: ctx.vtid,
    run_id: ctx.run_id,
    spec_content: ctx.spec.content,
    spec_version: ctx.spec.version,
    repository: EVIDENCE_POLL_CONFIG.REPOSITORY,
    branch_convention: EVIDENCE_POLL_CONFIG.BRANCH_CONVENTION.replace('{vtid}', ctx.vtid.replace('VTID-', '').toLowerCase()),
    task_title: ctx.task?.title || ctx.vtid,
    dispatched_at: new Date().toISOString(),
  };

  // Emit work order dispatched event to OASIS
  await emitOasisEvent({
    vtid: ctx.vtid,
    type: 'vtid.workorder.dispatched',
    source: 'vtid-runner-v2',
    status: 'info',
    message: `Work order dispatched for ${ctx.vtid}`,
    payload: {
      run_id: ctx.run_id,
      repository: workOrder.repository,
      branch_convention: workOrder.branch_convention,
      spec_present: true,
      spec_version: workOrder.spec_version,
      task_title: workOrder.task_title,
      work_order: workOrder,
    },
  });

  console.log(`[VTID-01150] ${ctx.vtid}: Work order dispatched (run_id=${ctx.run_id})`);
  return { ok: true };
}

/**
 * VTID-01150: Check for evidence of worker success in OASIS events
 * Returns evidence if found, null otherwise.
 */
async function checkForEvidence(vtid: string, run_id: string): Promise<WorkerEvidence | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error('[VTID-01150] Missing Supabase credentials for evidence check');
    return null;
  }

  try {
    // Query OASIS events for evidence
    // Look for: vtid.evidence.pr_opened, vtid.evidence.commits_pushed, vtid.evidence.worker_reported
    const evidenceTopics = [
      'vtid.evidence.pr_opened',
      'vtid.evidence.commits_pushed',
      'vtid.evidence.worker_reported',
      'vtid.execute.worker.success', // Also check for external worker success
    ];

    const topicFilter = evidenceTopics.map(t => `topic.eq.${t}`).join(',');

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?vtid=eq.${vtid}&or=(${topicFilter})&order=created_at.desc&limit=1`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }
    );

    if (!response.ok) {
      console.error(`[VTID-01150] Failed to check evidence: ${response.status}`);
      return null;
    }

    const events = (await response.json()) as Array<{
      id: string;
      topic: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }>;

    if (events.length === 0) {
      return null;
    }

    const event = events[0];
    const metadata = event.metadata || {};

    // Map topic to evidence type
    let evidenceType: EvidenceType;
    if (event.topic === 'vtid.evidence.pr_opened') {
      evidenceType = 'pr_opened';
    } else if (event.topic === 'vtid.evidence.commits_pushed') {
      evidenceType = 'commits_pushed';
    } else {
      evidenceType = 'worker_reported';
    }

    const evidence: WorkerEvidence = {
      type: evidenceType,
      vtid,
      run_id: (metadata.run_id as string) || run_id,
      timestamp: event.created_at,
      pr_number: metadata.pr_number as number | undefined,
      pr_url: metadata.pr_url as string | undefined,
      branch_name: metadata.branch_name as string | undefined,
      commit_sha: metadata.commit_sha as string | undefined,
      reporter: metadata.reporter as string | undefined,
      message: metadata.message as string | undefined,
    };

    console.log(`[VTID-01150] ${vtid}: Evidence found - ${evidenceType}`);
    return evidence;
  } catch (error) {
    console.error(`[VTID-01150] Error checking evidence:`, error);
    return null;
  }
}

/**
 * VTID-01150: Poll for evidence until found or timeout
 */
async function pollForEvidence(
  vtid: string,
  run_id: string,
  maxWaitMs: number = EVIDENCE_POLL_CONFIG.MAX_WAIT_MS,
  pollIntervalMs: number = EVIDENCE_POLL_CONFIG.POLL_INTERVAL_MS
): Promise<{ found: boolean; evidence?: WorkerEvidence; error?: string }> {
  const startTime = Date.now();

  console.log(`[VTID-01150] ${vtid}: Starting evidence polling (max wait: ${maxWaitMs / 1000}s)`);

  while (Date.now() - startTime < maxWaitMs) {
    const evidence = await checkForEvidence(vtid, run_id);

    if (evidence) {
      return { found: true, evidence };
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[VTID-01150] ${vtid}: No evidence yet (elapsed: ${elapsed}s)`);
  }

  console.warn(`[VTID-01150] ${vtid}: Evidence polling timeout after ${maxWaitMs / 1000}s`);
  return { found: false, error: 'EVIDENCE_TIMEOUT' };
}

// =============================================================================
// Execution Stages
// =============================================================================

/**
 * VTID-01150: Execute Worker stage with REAL Claude execution
 *
 * This replaces the v1 stub with a real execution bridge:
 * 1. Dispatch work order to OASIS (Claude polls for this)
 * 2. Wait for evidence (PR opened, commits pushed, or worker reported)
 * 3. Only emit worker.success when evidence is confirmed
 *
 * Runner does NOT:
 * - Assume success
 * - Emit fake success events
 * - Mark terminal on its own
 */
async function executeWorker(ctx: ExecutionContext): Promise<{
  success: boolean;
  error?: string;
  output?: Record<string, unknown>;
  evidence?: WorkerEvidence;
}> {
  console.log(`[VTID-01150] ${ctx.vtid} Worker stage starting...`);

  // VTID-01150: Emit worker.started (NOT worker.success until evidence confirmed)
  await emitStageEvent(ctx, "worker.started", "info", `Worker execution started for ${ctx.vtid}`, {
    executor: "vtid-runner-v2",
    spec_present: !!ctx.spec,
    mode: "execution-bridge",
  });

  try {
    // VTID-01150: MANDATORY - Spec must be present
    if (!ctx.spec) {
      console.error(`[VTID-01150] ${ctx.vtid}: SPEC_MISSING - cannot proceed`);
      await emitStageEvent(ctx, "worker.failed", "error", `Worker failed: SPEC_MISSING`, {
        error_code: "SPEC_MISSING",
        error_summary: "Spec is required for execution but was not found in OASIS",
      });
      return { success: false, error: "SPEC_MISSING" };
    }

    // Step 1: Dispatch work order to OASIS
    console.log(`[VTID-01150] ${ctx.vtid}: Dispatching work order...`);
    const dispatchResult = await dispatchWorkOrder(ctx);

    if (!dispatchResult.ok) {
      console.error(`[VTID-01150] ${ctx.vtid}: Work order dispatch failed: ${dispatchResult.error}`);
      await emitStageEvent(ctx, "worker.failed", "error", `Worker failed: work order dispatch failed`, {
        error_code: "WORKORDER_DISPATCH_FAILED",
        error_summary: dispatchResult.error,
      });
      return { success: false, error: dispatchResult.error };
    }

    // Step 1.5: NOW update status to "in_progress" - work has actually started
    // Task moves from "scheduled" → "in_progress" only after work order is dispatched
    await updateTaskStatus(ctx.vtid, "in_progress", ctx.run_id, {
      work_started_at: new Date().toISOString(),
      work_order_dispatched: true,
    });

    // Step 2: Wait for evidence
    console.log(`[VTID-01150] ${ctx.vtid}: Waiting for evidence...`);
    const evidenceResult = await pollForEvidence(ctx.vtid, ctx.run_id);

    if (!evidenceResult.found) {
      console.error(`[VTID-01150] ${ctx.vtid}: Evidence timeout - no worker completion observed`);
      await emitStageEvent(ctx, "worker.failed", "error", `Worker failed: ${evidenceResult.error}`, {
        error_code: evidenceResult.error || "EVIDENCE_TIMEOUT",
        error_summary: "No evidence of worker completion within timeout period",
        timeout_seconds: EVIDENCE_POLL_CONFIG.MAX_WAIT_MS / 1000,
      });
      return { success: false, error: evidenceResult.error };
    }

    // Step 3: Evidence found - emit worker.success with evidence metadata
    console.log(`[VTID-01150] ${ctx.vtid}: Worker evidence confirmed: ${evidenceResult.evidence?.type}`);
    await emitStageEvent(ctx, "worker.success", "success", `Worker execution completed for ${ctx.vtid}`, {
      executor: "vtid-runner-v2",
      evidence_type: evidenceResult.evidence?.type,
      evidence_pr_number: evidenceResult.evidence?.pr_number,
      evidence_branch: evidenceResult.evidence?.branch_name,
      evidence_commit: evidenceResult.evidence?.commit_sha,
      note: "Success confirmed via external evidence",
    });

    return {
      success: true,
      output: {
        executor: "vtid-runner-v2",
        evidence_type: evidenceResult.evidence?.type,
      },
      evidence: evidenceResult.evidence,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown worker error";
    console.error(`[VTID-01150] ${ctx.vtid} Worker failed:`, errorMessage);
    await emitStageEvent(ctx, "worker.failed", "error", `Worker failed: ${errorMessage}`, {
      error_code: "WORKER_ERROR",
      error_summary: errorMessage,
    });
    return { success: false, error: errorMessage };
  }
}

/**
 * VTID-01150: Execute Validator stage (External Validation)
 *
 * Validator logic is EXTERNAL (Claude / governance):
 * - Runner emits validator.started
 * - Runner waits for external validation event
 * - Runner does NOT invent validator results
 *
 * For now, we do minimal pre-validation (task exists, not terminal)
 * but defer success confirmation to governance/CI.
 */
async function executeValidator(ctx: ExecutionContext): Promise<{
  success: boolean;
  error?: string;
  validation?: Record<string, unknown>;
}> {
  console.log(`[VTID-01150] ${ctx.vtid} Validator stage starting...`);
  await emitStageEvent(ctx, "validator.started", "info", `Validator execution started for ${ctx.vtid}`, {
    executor: "vtid-runner-v2",
    mode: "external-validation",
  });

  try {
    const violations: string[] = [];

    // VAL-RULE-001: Task must exist
    if (!ctx.task) {
      violations.push("VAL-RULE-001: Task not found in OASIS");
    }

    // VTID-01150: VAL-RULE-002 is now MANDATORY (spec MUST exist)
    if (!ctx.spec) {
      violations.push("VAL-RULE-002: Spec not found in OASIS (MANDATORY for VTID-01150)");
    }

    // VAL-RULE-003: Task must not be in terminal state
    if (ctx.task?.is_terminal) {
      violations.push("VAL-RULE-003: Task already in terminal state");
    }

    if (violations.length > 0) {
      const errorMessage = violations.join("; ");
      console.error(`[VTID-01150] ${ctx.vtid} Validation failed:`, errorMessage);
      await emitStageEvent(ctx, "validator.failed", "error", `Validation failed: ${errorMessage}`, {
        error_code: "VALIDATION_FAILED",
        violations,
      });
      return { success: false, error: errorMessage, validation: { violations } };
    }

    // VTID-01150: Emit validator.success for pre-validation only
    // Final validation is handled by CI/CD governance gate
    console.log(`[VTID-01150] ${ctx.vtid} Pre-validation passed`);
    await emitStageEvent(ctx, "validator.success", "success", `Pre-validation passed for ${ctx.vtid}`, {
      rules_checked: ["VAL-RULE-001", "VAL-RULE-002", "VAL-RULE-003"],
      spec_present: true,
      note: "Final validation deferred to CI/CD governance gate",
    });

    return { success: true, validation: { rules_checked: 3, passed: true } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown validator error";
    console.error(`[VTID-01150] ${ctx.vtid} Validator error:`, errorMessage);
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
    console.log(`[VTID-01150] ${ctx.vtid} Skipping PR merge (automerge=false)`);
    return { success: true, merged: false };
  }

  if (!ctx.head_branch) {
    console.log(`[VTID-01150] ${ctx.vtid} No head_branch provided, skipping PR merge`);
    return { success: true, merged: false };
  }

  console.log(`[VTID-01150] ${ctx.vtid} PR merge stage starting...`);

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
      console.error(`[VTID-01150] ${ctx.vtid} PR merge failed:`, result.error);
      return {
        success: false,
        error: result.error || "PR merge failed",
        pr_number: result.pr_number,
        pr_url: result.pr_url,
      };
    }

    console.log(`[VTID-01150] ${ctx.vtid} PR merge completed: PR #${result.pr_number}`);
    return {
      success: true,
      pr_number: result.pr_number,
      pr_url: result.pr_url,
      merged: result.merged,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown PR merge error";
    console.error(`[VTID-01150] ${ctx.vtid} PR merge error:`, errorMessage);
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
  console.log(`[VTID-01150] ${ctx.vtid} Deploy verification stage starting...`);
  await emitStageEvent(ctx, "deploy.started", "info", `Deploy verification started for ${ctx.vtid}`);

  try {
    // Resolve gateway URL dynamically via gcloud (in production)
    // For now, use the internal URL
    const gatewayUrl = GATEWAY_INTERNAL_URL;

    // Health check: /alive
    console.log(`[VTID-01150] ${ctx.vtid} Checking /alive...`);
    const aliveResponse = await fetch(`${gatewayUrl}/alive`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!aliveResponse.ok) {
      throw new Error(`Health check failed: ${aliveResponse.status}`);
    }

    const aliveData = (await aliveResponse.json()) as { status: string; [key: string]: unknown };
    console.log(`[VTID-01150] ${ctx.vtid} /alive check passed:`, aliveData);

    // API smoke test: check an API endpoint
    console.log(`[VTID-01150] ${ctx.vtid} Running API smoke test...`);
    const smokeResponse = await fetch(`${gatewayUrl}/api/v1/cicd/health`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!smokeResponse.ok) {
      throw new Error(`API smoke test failed: ${smokeResponse.status}`);
    }

    const smokeData = (await smokeResponse.json()) as { status: string; [key: string]: unknown };
    console.log(`[VTID-01150] ${ctx.vtid} API smoke test passed`);

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
    console.error(`[VTID-01150] ${ctx.vtid} Deploy verification failed:`, errorMessage);
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
  console.log(`[VTID-01150] Execute VTID request ${requestId} started`);

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

    console.log(`[VTID-01150] ${vtid}: Starting execution (run_id=${run_id}, mode=${mode}, automerge=${automerge})`);

    // Step 1: Check idempotency
    const executionStatus = await checkExecutionStatus(vtid);

    if (executionStatus.is_terminal) {
      console.log(`[VTID-01150] ${vtid}: Already terminal (outcome=${executionStatus.terminal_outcome})`);
      return res.status(200).json({
        ok: true,
        vtid,
        already_terminal: true,
        terminal_outcome: executionStatus.terminal_outcome,
      });
    }

    if (executionStatus.in_progress && executionStatus.run_id) {
      console.log(`[VTID-01150] ${vtid}: Already running (run_id=${executionStatus.run_id})`);
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
      console.error(`[VTID-01150] ${vtid}: Task not found in OASIS`);
      return res.status(404).json({
        ok: false,
        vtid,
        error: `Task ${vtid} not found in OASIS`,
      });
    }

    // VTID-01150: Spec loading is MANDATORY - HARD FAIL if missing
    const spec = await fetchSpec(vtid);
    if (!spec) {
      console.error(`[VTID-01150] ${vtid}: SPEC_MISSING - cannot proceed (HARD FAIL)`);

      // Emit execution failed event with SPEC_MISSING reason
      await emitOasisEvent({
        vtid,
        type: 'vtid.execute.failed',
        source: 'vtid-runner-v2',
        status: 'error',
        message: `Execution failed: SPEC_MISSING`,
        payload: {
          error_code: 'SPEC_MISSING',
          error_summary: 'Spec is required for execution but was not found in OASIS',
          spec_present: false,
        },
      });

      return res.status(400).json({
        ok: false,
        vtid,
        error: 'SPEC_MISSING',
        message: 'Spec is required for execution but was not found in OASIS. Please create a spec for this VTID first.',
      });
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

    // Step 5: Update task status to "scheduled" (queued for execution)
    // Status moves to "in_progress" only when work actually starts in executeWorker
    await updateTaskStatus(vtid, "scheduled", run_id, {
      queued_at: new Date().toISOString(),
    });

    // Step 6: Emit execution started event
    // VTID-01150: spec_present is always true here (we hard-failed above if missing)
    await emitStageEvent(ctx, "started", "info", `VTID execution started: ${vtid}`, {
      task_title: task.title,
      spec_present: true,
      executor: "vtid-runner-v2",
      mode: "execution-bridge",
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
      console.error(`[VTID-01150] ${vtid}: Async pipeline error:`, error);
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[VTID-01150] Execute VTID error:`, errorMessage);
    return res.status(500).json({
      ok: false,
      error: `Internal server error: ${errorMessage}`,
      vtid: req.body?.vtid || "UNKNOWN",
    });
  }
});

/**
 * VTID-01150: Async execution pipeline
 * Runs Worker → Validator → PR Merge → Deploy Verify
 *
 * IMPORTANT: Runner does NOT mark terminal on its own.
 * Terminal marking is handled by the existing CI/CD terminal gate (cicd-terminal-gate).
 *
 * Runner behavior:
 * - Emits stage events
 * - Updates task status on failure (so tasks don't stay stuck in "in_progress")
 * - Waits for evidence (worker stage)
 * - Defers final completion to CI/CD
 */
async function executeAsyncPipeline(ctx: ExecutionContext): Promise<void> {
  console.log(`[VTID-01150] ${ctx.vtid}: Starting async pipeline...`);

  try {
    // Stage 1: Worker (with real execution via work order + evidence polling)
    const workerResult = await executeWorker(ctx);
    if (!workerResult.success) {
      // VTID-01150: Update task status to "blocked" so it doesn't stay stuck
      // Terminal marking is still deferred to CI/CD gate
      await updateTaskStatus(ctx.vtid, "blocked", ctx.run_id, {
        blocked_reason: workerResult.error,
        blocked_stage: "worker",
        blocked_at: new Date().toISOString(),
      });
      await emitStageEvent(ctx, "failed", "error", `Execution failed at worker stage: ${workerResult.error}`, {
        failed_stage: "worker",
        error: workerResult.error,
        note: "Task marked blocked - terminal marking deferred to CI/CD gate",
      });
      return;
    }

    // Stage 2: Validator (pre-validation only - final validation by CI/CD)
    const validatorResult = await executeValidator(ctx);
    if (!validatorResult.success) {
      await updateTaskStatus(ctx.vtid, "blocked", ctx.run_id, {
        blocked_reason: validatorResult.error,
        blocked_stage: "validator",
        blocked_at: new Date().toISOString(),
      });
      await emitStageEvent(ctx, "failed", "error", `Execution failed at validator stage: ${validatorResult.error}`, {
        failed_stage: "validator",
        error: validatorResult.error,
        note: "Task marked blocked - terminal marking deferred to CI/CD gate",
      });
      return;
    }

    // Stage 3: PR Merge (optional - triggers existing autonomous-pr-merge)
    if (ctx.automerge && ctx.head_branch) {
      const mergeResult = await executePrMerge(ctx);
      if (!mergeResult.success) {
        await updateTaskStatus(ctx.vtid, "blocked", ctx.run_id, {
          blocked_reason: mergeResult.error,
          blocked_stage: "pr_merge",
          blocked_at: new Date().toISOString(),
        });
        await emitStageEvent(ctx, "failed", "error", `Execution failed at PR merge stage: ${mergeResult.error}`, {
          failed_stage: "pr_merge",
          error: mergeResult.error,
          note: "Task marked blocked - terminal marking deferred to CI/CD gate",
        });
        return;
      }
    }

    // Stage 4: Deploy Verification (optional - checks health after CI/CD deploys)
    // Note: The actual deploy is triggered by existing AUTO-DEPLOY workflow
    const deployResult = await executeDeployVerification(ctx);
    if (!deployResult.success) {
      await updateTaskStatus(ctx.vtid, "blocked", ctx.run_id, {
        blocked_reason: deployResult.error,
        blocked_stage: "deploy_verification",
        blocked_at: new Date().toISOString(),
      });
      await emitStageEvent(ctx, "failed", "error", `Execution failed at deploy verification: ${deployResult.error}`, {
        failed_stage: "deploy_verification",
        error: deployResult.error,
        note: "Task marked blocked - terminal marking deferred to CI/CD gate",
      });
      return;
    }

    // VTID-01150: All runner stages passed
    // Update task status to "validating" to indicate waiting for CI/CD
    // Do NOT mark terminal here - wait for existing CI/CD terminal gate
    await updateTaskStatus(ctx.vtid, "validating", ctx.run_id, {
      runner_completed_at: new Date().toISOString(),
      awaiting: "cicd_terminal_gate",
    });

    // The CI/CD terminal gate (cicd-terminal-gate) will emit vtid.lifecycle.completed
    await emitStageEvent(ctx, "completed", "success", `Runner execution completed for ${ctx.vtid}`, {
      worker: "success",
      validator: "success",
      deploy_verified: true,
      executor: "vtid-runner-v2",
      note: "Runner completed - terminal completion deferred to CI/CD terminal gate",
    });

    console.log(`[VTID-01150] ${ctx.vtid}: Runner execution completed (terminal deferred to CI/CD)`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown pipeline error";
    console.error(`[VTID-01150] ${ctx.vtid}: Pipeline error:`, errorMessage);

    // Update task status on unexpected errors
    await updateTaskStatus(ctx.vtid, "blocked", ctx.run_id, {
      blocked_reason: errorMessage,
      blocked_stage: "unknown",
      blocked_at: new Date().toISOString(),
    });

    await emitStageEvent(ctx, "failed", "error", `Execution failed with error: ${errorMessage}`, {
      failed_stage: "unknown",
      error: errorMessage,
      note: "Task marked blocked - terminal marking deferred to CI/CD gate",
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

// =============================================================================
// VTID-01150: Work Order & Evidence Endpoints
// =============================================================================

/**
 * VTID-01150: Schema for evidence submission
 */
const EvidenceSubmitSchema = z.object({
  vtid: z.string().regex(VTID_PATTERN, "Invalid VTID format"),
  run_id: z.string().optional(),
  evidence_type: z.enum(["pr_opened", "commits_pushed", "worker_reported"]),
  pr_number: z.number().optional(),
  pr_url: z.string().optional(),
  branch_name: z.string().optional(),
  commit_sha: z.string().optional(),
  commits: z.array(z.object({
    sha: z.string(),
    message: z.string(),
  })).optional(),
  reporter: z.string().optional(),
  message: z.string().optional(),
});

/**
 * POST /evidence - Submit worker evidence
 * VTID-01150: Workers call this to report evidence of work completion
 *
 * Evidence types:
 * - pr_opened: A PR was opened for the VTID
 * - commits_pushed: Commits were pushed to the branch
 * - worker_reported: Worker explicitly reports success
 */
router.post("/evidence", async (req: Request, res: Response) => {
  try {
    const validation = EvidenceSubmitSchema.safeParse(req.body);
    if (!validation.success) {
      const details = validation.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
      return res.status(400).json({
        ok: false,
        error: `Invalid evidence payload: ${details}`,
      });
    }

    const evidence = validation.data;
    const timestamp = new Date().toISOString();

    // Determine the event type based on evidence type
    let eventType: string;
    switch (evidence.evidence_type) {
      case "pr_opened":
        eventType = "vtid.evidence.pr_opened";
        break;
      case "commits_pushed":
        eventType = "vtid.evidence.commits_pushed";
        break;
      case "worker_reported":
        eventType = "vtid.evidence.worker_reported";
        break;
    }

    // Emit evidence event to OASIS
    await emitOasisEvent({
      vtid: evidence.vtid,
      type: eventType as any,
      source: evidence.reporter || "claude-worker",
      status: "success",
      message: `Evidence submitted: ${evidence.evidence_type}`,
      payload: {
        run_id: evidence.run_id,
        evidence_type: evidence.evidence_type,
        pr_number: evidence.pr_number,
        pr_url: evidence.pr_url,
        branch_name: evidence.branch_name,
        commit_sha: evidence.commit_sha,
        commits: evidence.commits,
        reporter: evidence.reporter,
        message: evidence.message,
        submitted_at: timestamp,
      },
    });

    console.log(`[VTID-01150] Evidence submitted: ${evidence.vtid} - ${evidence.evidence_type}`);

    return res.status(200).json({
      ok: true,
      vtid: evidence.vtid,
      evidence_type: evidence.evidence_type,
      recorded_at: timestamp,
      message: "Evidence recorded successfully",
    });
  } catch (error: any) {
    console.error("[VTID-01150] Evidence submission error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      detail: error.message,
    });
  }
});

/**
 * GET /workorders/:vtid - Get pending work order for a VTID
 * VTID-01150: Claude polls this endpoint to get work orders
 */
router.get("/workorders/:vtid", async (req: Request, res: Response) => {
  const { vtid } = req.params;

  if (!VTID_PATTERN.test(vtid)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid VTID format",
    });
  }

  try {
    // Query for the latest work order event for this VTID
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({
        ok: false,
        error: "Supabase not configured",
      });
    }

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?vtid=eq.${vtid}&topic=eq.vtid.workorder.dispatched&order=created_at.desc&limit=1`,
      {
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }
    );

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: `Failed to query work orders: ${response.status}`,
      });
    }

    const events = (await response.json()) as Array<{
      id: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }>;

    if (events.length === 0) {
      return res.status(404).json({
        ok: false,
        vtid,
        error: "No pending work order found",
      });
    }

    const event = events[0];
    const workOrder = (event.metadata as any)?.work_order;

    return res.status(200).json({
      ok: true,
      vtid,
      work_order: workOrder || event.metadata,
      dispatched_at: event.created_at,
    });
  } catch (error: any) {
    console.error("[VTID-01150] Work order fetch error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      detail: error.message,
    });
  }
});

/**
 * GET /workorders - List pending work orders (for Claude to poll)
 * VTID-01150: Returns all pending work orders (no evidence yet)
 */
router.get("/workorders", async (_req: Request, res: Response) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({
        ok: false,
        error: "Supabase not configured",
      });
    }

    // Get recent work orders (last 24 hours)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?topic=eq.vtid.workorder.dispatched&created_at=gte.${since}&order=created_at.desc&limit=50`,
      {
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }
    );

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: `Failed to query work orders: ${response.status}`,
      });
    }

    const events = (await response.json()) as Array<{
      id: string;
      vtid: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }>;

    // For each work order, check if evidence exists
    const pendingWorkOrders = [];
    for (const event of events) {
      const evidence = await checkForEvidence(event.vtid, (event.metadata as any)?.run_id || '');
      if (!evidence) {
        pendingWorkOrders.push({
          vtid: event.vtid,
          work_order: (event.metadata as any)?.work_order || event.metadata,
          dispatched_at: event.created_at,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      count: pendingWorkOrders.length,
      work_orders: pendingWorkOrders,
    });
  } catch (error: any) {
    console.error("[VTID-01150] Work orders list error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      detail: error.message,
    });
  }
});

// =============================================================================
// Health Check
// =============================================================================

router.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "execution-bridge",
    version: "2.2.0", // VTID-01150: v2.2.0 - proper scheduled→in_progress→blocked/validating flow
    vtid: "VTID-01150", // VTID-01150: Updated reference
    timestamp: new Date().toISOString(),
    capabilities: {
      execute_vtid: true,
      worker_only_mode: true,
      automerge: true,
      deploy_verification: true,
      // VTID-01150: New capabilities
      work_order_dispatch: true,
      evidence_polling: true,
      evidence_submission: true,
      spec_mandatory: true,
      // v2.1.0: Status updates on failure
      status_updates_on_failure: true,
    },
    models: {
      planner: "Claude 3.5 Sonnet",
      executor: "Claude Code", // VTID-01150: Real executor
      forbidden: ["Gemini Flash 1.5"],
    },
    endpoints: {
      execute: "POST /vtid",
      evidence: "POST /evidence",
      workorders: "GET /workorders",
      workorder: "GET /workorders/:vtid",
    },
  });
});
