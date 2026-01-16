/**
 * Autopilot Routes - VTID-0532 + VTID-0533 + VTID-0534 + VTID-0535
 *
 * ============================================================================
 * VTID-01170: DEPRECATION NOTICE - Operational Safety Lock
 * ============================================================================
 * These endpoints run PARALLEL to the canonical Worker Orchestrator (VTID-01163).
 *
 * CANONICAL PATH: POST /api/v1/worker/orchestrator/route
 *
 * The following execution endpoints will be DEPRECATED:
 * - POST /tasks/:vtid/plan       → Use orchestrator routing
 * - POST /tasks/:vtid/work/start → Use orchestrator subagent/start
 * - POST /tasks/:vtid/work/complete → Use orchestrator subagent/complete
 *
 * Read-only endpoints remain available:
 * - GET /tasks/pending-plan      → Still available (read-only)
 * - GET /tasks/:vtid/status      → Still available (read-only)
 * - POST /tasks/:vtid/validate   → Still available (validation is governance)
 *
 * See: VTID-01170 (Freeze Parallel Paths)
 * ============================================================================
 *
 * Planner Handoff API and Execution Pipeline for multi-agent planning workflows.
 *
 * Final API endpoints (after mounting at /api/v1/autopilot):
 *
 * VTID-0532 (Planner Handoff):
 * - GET /api/v1/autopilot/tasks/pending-plan - List pending tasks for planner agents
 * - GET /api/v1/autopilot/health - Health check
 *
 * VTID-0533 (Execution Pipeline):
 * - POST /api/v1/autopilot/tasks/:vtid/plan - Submit a structured plan for a task
 * - POST /api/v1/autopilot/tasks/:vtid/work/start - Mark work started on a step
 * - POST /api/v1/autopilot/tasks/:vtid/work/complete - Mark work completed on a step
 * - POST /api/v1/autopilot/tasks/:vtid/validate - Submit validation result
 * - GET /api/v1/autopilot/tasks/:vtid/status - Get task status
 *
 * VTID-0534 (Worker-Core Engine v1):
 * - Enhanced work/start and work/complete with step-level state machine
 * - Worker state reconstruction from OASIS events
 * - Rich worker section in status endpoint
 *
 * VTID-0535 (Validator-Core Engine v1):
 * - Deterministic validation rules (VAL-RULE-001 to VAL-RULE-006)
 * - No LLM calls - purely rule-based validation
 * - Rich validator section in status endpoint
 * - autopilot.validation.completed and autopilot.task.finalized events
 */

import { Router, Request, Response } from 'express';
import {
  getPendingPlanTasks,
  submitPlan,
  emitValidationResult,
  getAutopilotTaskStatus,
  PlanPayload,
  PlanMetadata,
  ValidationResultPayload,
  ValidationMetadata
} from '../services/operator-service';
import {
  startWork,
  completeWork,
  getWorkerState,
  WorkStartRequest,
  WorkCompleteRequest
} from '../services/worker-core-service';
import {
  runValidation,
  getValidatorState,
  ValidateRequest
} from '../services/validator-core-service';
// VTID-01178: Autopilot Controller imports
import {
  startAutopilotRun,
  getAutopilotRun,
  getActiveRuns,
  getSpecSnapshot,
  verifySpecIntegrity,
  getAutopilotStatus,
} from '../services/autopilot-controller';
import { runVerification } from '../services/autopilot-verification';
import { validateForMerge, getValidationResult } from '../services/autopilot-validator';

const router = Router();

// =============================================================================
// VTID-01170: Deprecation Guard
// =============================================================================

/**
 * VTID-01170: Check if request is attempting to bypass canonical orchestrator
 * Returns 400 DEPRECATED unless X-BYPASS-ORCHESTRATOR header is set
 */
function checkDeprecatedBypass(
  req: Request,
  res: Response,
  endpointName: string,
  canonicalPath: string
): boolean {
  const bypassHeader = req.get("X-BYPASS-ORCHESTRATOR");

  if (bypassHeader === "EMERGENCY-BYPASS") {
    // Log the governance violation
    console.warn(`[VTID-01170] DEPRECATED endpoint used with bypass: ${endpointName}`);
    console.warn(`[VTID-01170] Canonical path: ${canonicalPath}`);
    return false; // Continue with deprecated endpoint
  }

  // Block access to deprecated endpoint
  console.warn(`[VTID-01170] Blocked access to deprecated endpoint: ${endpointName}`);
  res.status(400).json({
    ok: false,
    error: "DEPRECATED",
    code: "VTID-01170-DEPRECATED",
    endpoint: endpointName,
    message: `This endpoint is DEPRECATED by VTID-01170. Use the canonical orchestrator path instead.`,
    canonical_path: canonicalPath,
    how_to_migrate: `Use POST /api/v1/worker/orchestrator/route for all agent execution`,
    bypass_header: "Set X-BYPASS-ORCHESTRATOR: EMERGENCY-BYPASS to override (governance violation)",
  });
  return true; // Blocked
}

// ==================== VTID-0532: Planner Handoff ====================

/**
 * GET /tasks/pending-plan → /api/v1/autopilot/tasks/pending-plan
 * VTID-0532: Planner Handoff API
 *
 * Returns tasks that:
 * - Have a VTID
 * - Are in "pending" / "scheduled" status
 * - Have at least one autopilot.task.spec.created event
 */
router.get('/tasks/pending-plan', async (_req: Request, res: Response) => {
  console.log('[VTID-0532] Pending plan tasks requested');

  try {
    const tasks = await getPendingPlanTasks();

    console.log(`[VTID-0532] Returning ${tasks.length} pending plan tasks`);

    return res.status(200).json({
      ok: true,
      data: tasks
    });
  } catch (error: any) {
    console.warn('[VTID-0532] Pending plan tasks error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to fetch pending plan tasks',
      details: error.message
    });
  }
});

// ==================== VTID-0533: Execution Pipeline ====================

/**
 * POST /tasks/:vtid/plan → /api/v1/autopilot/tasks/:vtid/plan
 * VTID-0533: Submit a structured plan for a task
 *
 * Request body:
 * {
 *   "plan": {
 *     "summary": "One-line human readable summary",
 *     "steps": [
 *       {
 *         "id": "step-1",
 *         "title": "Short title",
 *         "description": "Human-readable explanation",
 *         "owner": "WORKER",
 *         "estimated_effort": "S",
 *         "dependencies": []
 *       }
 *     ]
 *   },
 *   "metadata": {
 *     "plannerModel": "gemini-pro",
 *     "plannerRole": "PLANNER",
 *     "source": "autopilot",
 *     "notes": "optional"
 *   }
 * }
 *
 * Response:
 * { "ok": true, "vtid": "...", "status": "planned", "planSteps": 3 }
 */
router.post('/tasks/:vtid/plan', async (req: Request, res: Response) => {
  // VTID-01170: Deprecation check - use orchestrator for plan routing
  if (checkDeprecatedBypass(req, res, "POST /autopilot/tasks/:vtid/plan", "POST /api/v1/worker/orchestrator/route")) {
    return; // Blocked by deprecation guard
  }

  const { vtid } = req.params;
  const { plan, metadata } = req.body;

  console.log(`[VTID-0533] Plan submission received for ${vtid} (DEPRECATED - bypassing orchestrator)`);

  // Validate request body
  if (!plan || typeof plan !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "plan" object in request body'
    });
  }

  if (!plan.summary || typeof plan.summary !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "plan.summary" string'
    });
  }

  if (!Array.isArray(plan.steps)) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "plan.steps" array'
    });
  }

  if (!metadata || typeof metadata !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "metadata" object in request body'
    });
  }

  if (!metadata.plannerModel || typeof metadata.plannerModel !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "metadata.plannerModel" string'
    });
  }

  try {
    const result = await submitPlan(
      vtid,
      plan as PlanPayload,
      {
        plannerModel: metadata.plannerModel,
        plannerRole: metadata.plannerRole || 'PLANNER',
        source: metadata.source,
        notes: metadata.notes
      } as PlanMetadata
    );

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.error
      });
    }

    return res.status(200).json({
      ok: true,
      vtid: result.vtid,
      status: result.status,
      planSteps: result.planSteps
    });
  } catch (error: any) {
    console.warn(`[VTID-0533] Plan submission error for ${vtid}:`, error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to submit plan',
      details: error.message
    });
  }
});

/**
 * POST /tasks/:vtid/work/start → /api/v1/autopilot/tasks/:vtid/work/start
 * VTID-0534: Worker-Core Engine - Mark work started on a step
 *
 * Request body (v1):
 * {
 *   "step_id": "step-1",
 *   "step_index": 0,
 *   "label": "Analyze repository and list services",
 *   "agent": "Gemini-Worker",
 *   "executor_type": "llm",
 *   "notes": "optional"
 * }
 *
 * Response:
 * {
 *   "ok": true,
 *   "eventId": "...",
 *   "worker": { "overall_status": "in_progress", "steps": [...] }
 * }
 *
 * Error codes:
 * - 400 + worker.step_not_found: Step not in plan
 * - 400 + worker.plan_missing: No plan for VTID
 * - 409 + worker.invalid_transition: Step not in pending state
 */
router.post('/tasks/:vtid/work/start', async (req: Request, res: Response) => {
  // VTID-01170: Deprecation check - use orchestrator for work start
  if (checkDeprecatedBypass(req, res, "POST /autopilot/tasks/:vtid/work/start", "POST /api/v1/worker/subagent/start")) {
    return; // Blocked by deprecation guard
  }

  const { vtid } = req.params;
  const { step_id, step_index, label, agent, executor_type, notes } = req.body;

  console.log(`[VTID-0534] Work start received for ${vtid}, step: ${step_id} (DEPRECATED - bypassing orchestrator)`);

  // Validate request body
  if (!step_id || typeof step_id !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "step_id" string'
    });
  }

  if (typeof step_index !== 'number') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "step_index" number'
    });
  }

  if (!label || typeof label !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "label" string'
    });
  }

  if (!agent || typeof agent !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "agent" string'
    });
  }

  if (!executor_type || typeof executor_type !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "executor_type" string'
    });
  }

  try {
    const result = await startWork(vtid, {
      step_id,
      step_index,
      label,
      agent,
      executor_type,
      notes
    } as WorkStartRequest);

    if (!result.ok) {
      // Determine appropriate HTTP status based on error code
      const httpStatus = result.error.code === 'worker.invalid_transition' ? 409 : 400;
      return res.status(httpStatus).json({
        ok: false,
        error: result.error.message,
        code: result.error.code
      });
    }

    return res.status(200).json({
      ok: true,
      eventId: result.eventId,
      worker: result.state
    });
  } catch (error: any) {
    console.warn(`[VTID-0534] Work start error for ${vtid}:`, error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to start work',
      details: error.message
    });
  }
});

/**
 * POST /tasks/:vtid/work/complete → /api/v1/autopilot/tasks/:vtid/work/complete
 * VTID-0534: Worker-Core Engine - Mark work completed on a step
 *
 * Request body (v1):
 * {
 *   "step_id": "step-1",
 *   "step_index": 0,
 *   "status": "completed",
 *   "output_summary": "Services identified and categorized.",
 *   "error": null,
 *   "agent": "Gemini-Worker"
 * }
 *
 * Response:
 * {
 *   "ok": true,
 *   "eventId": "...",
 *   "worker": { "overall_status": "completed", "steps": [...] }
 * }
 *
 * Error codes:
 * - 400 + worker.step_not_found: Step not in plan
 * - 400 + worker.plan_missing: No plan for VTID
 * - 400 + worker.error_required: Error required when status is "failed"
 * - 409 + worker.invalid_transition: Step not in in_progress state
 */
router.post('/tasks/:vtid/work/complete', async (req: Request, res: Response) => {
  // VTID-01170: Deprecation check - use orchestrator for work complete
  if (checkDeprecatedBypass(req, res, "POST /autopilot/tasks/:vtid/work/complete", "POST /api/v1/worker/subagent/complete")) {
    return; // Blocked by deprecation guard
  }

  const { vtid } = req.params;
  const { step_id, step_index, status, output_summary, error, agent } = req.body;

  console.log(`[VTID-0534] Work complete received for ${vtid}, step: ${step_id} (DEPRECATED - bypassing orchestrator)`);

  // Validate request body
  if (!step_id || typeof step_id !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "step_id" string'
    });
  }

  if (typeof step_index !== 'number') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "step_index" number'
    });
  }

  if (!status || !['completed', 'failed'].includes(status)) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "status" (must be "completed" or "failed")'
    });
  }

  try {
    const result = await completeWork(vtid, {
      step_id,
      step_index,
      status,
      output_summary,
      error,
      agent
    } as WorkCompleteRequest);

    if (!result.ok) {
      // Determine appropriate HTTP status based on error code
      const httpStatus = result.error.code === 'worker.invalid_transition' ? 409 : 400;
      return res.status(httpStatus).json({
        ok: false,
        error: result.error.message,
        code: result.error.code
      });
    }

    return res.status(200).json({
      ok: true,
      eventId: result.eventId,
      worker: result.state
    });
  } catch (error: any) {
    console.warn(`[VTID-0534] Work complete error for ${vtid}:`, error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to complete work',
      details: error.message
    });
  }
});

/**
 * POST /tasks/:vtid/validate → /api/v1/autopilot/tasks/:vtid/validate
 * VTID-0535: Validator-Core Engine v1 - Run deterministic validation
 *
 * Request body (v1):
 * {
 *   "mode": "auto",
 *   "override": null
 * }
 *
 * Response (success):
 * {
 *   "ok": true,
 *   "vtid": "...",
 *   "validation": {
 *     "final_status": "success" | "failed",
 *     "rules_checked": ["VAL-RULE-001", ...],
 *     "violations": [],
 *     "summary": "...",
 *     "validated_at": "..."
 *   }
 * }
 *
 * Error codes:
 * - validator.plan_missing: No plan found for VTID
 * - validator.worker_state_missing: Cannot reconstruct worker state
 * - validator.no_steps: Plan has zero steps
 */
router.post('/tasks/:vtid/validate', async (req: Request, res: Response) => {
  const { vtid } = req.params;
  const { mode, override } = req.body;

  console.log(`[VTID-0535] Validation requested for ${vtid}`);

  // Build request (mode defaults to 'auto')
  const validateRequest: ValidateRequest = {
    mode: mode || 'auto',
    override: override || null
  };

  try {
    const validationResult = await runValidation(vtid, validateRequest);

    if (!validationResult.ok) {
      // Return error with appropriate status code
      const statusCode = validationResult.error.code === 'validator.internal_error' ? 500 : 400;
      return res.status(statusCode).json({
        ok: false,
        error: validationResult.error.message,
        code: validationResult.error.code
      });
    }

    return res.status(200).json({
      ok: true,
      vtid,
      validation: validationResult.result
    });
  } catch (error: any) {
    console.warn(`[VTID-0535] Validation error for ${vtid}:`, error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to run validation',
      code: 'validator.internal_error',
      details: error.message
    });
  }
});

/**
 * GET /tasks/:vtid/status → /api/v1/autopilot/tasks/:vtid/status
 * VTID-0535: Get task status with worker and validator sections
 *
 * Response:
 * {
 *   "ok": true,
 *   "vtid": "...",
 *   "status": {
 *     "planner": { ... },
 *     "worker": {
 *       "overall_status": "in_progress",
 *       "steps": [...]
 *     },
 *     "validator": {
 *       "final_status": "pending" | "success" | "failed",
 *       "summary": "...",
 *       "rules_checked": [...],
 *       "violations": [...],
 *       "validated_at": "..."
 *     }
 *   }
 * }
 */
router.get('/tasks/:vtid/status', async (req: Request, res: Response) => {
  const { vtid } = req.params;

  console.log(`[VTID-0535] Status requested for ${vtid}`);

  try {
    const taskStatus = await getAutopilotTaskStatus(vtid);

    if (!taskStatus) {
      return res.status(404).json({
        ok: false,
        error: `Task ${vtid} not found`
      });
    }

    // Get worker state from OASIS events
    const workerResult = await getWorkerState(vtid);

    // Get validator state from OASIS events (VTID-0535)
    const validatorState = await getValidatorState(vtid);

    // Build the enhanced status response
    const statusResponse: Record<string, unknown> = {
      ok: true,
      vtid: taskStatus.vtid,
      status: {
        // Planner info
        planner: {
          status: taskStatus.status,
          planSteps: taskStatus.planSteps || 0
        },
        // Worker info (VTID-0534)
        worker: workerResult.ok ? workerResult.state : {
          overall_status: 'pending',
          steps: []
        },
        // Validator info (VTID-0535)
        validator: validatorState
      },
      // Preserve backward compatibility with flat fields
      title: taskStatus.title,
      planSteps: taskStatus.planSteps,
      validationStatus: validatorState.final_status,
      createdAt: taskStatus.createdAt,
      updatedAt: taskStatus.updatedAt
    };

    return res.status(200).json(statusResponse);
  } catch (error: any) {
    console.warn(`[VTID-0535] Status error for ${vtid}:`, error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to get task status',
      details: error.message
    });
  }
});

// ==================== VTID-01178: Autopilot Controller Endpoints ====================

/**
 * GET /controller/status → /api/v1/autopilot/controller/status
 * VTID-01178: Get autopilot controller status
 */
router.get('/controller/status', (_req: Request, res: Response) => {
  try {
    const status = getAutopilotStatus();
    return res.status(200).json({
      ok: true,
      service: 'autopilot-controller',
      version: '1.0.0',
      vtid: 'VTID-01178',
      timestamp: new Date().toISOString(),
      ...status,
    });
  } catch (error: any) {
    console.error(`[VTID-01178] Status error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /controller/runs → /api/v1/autopilot/controller/runs
 * VTID-01178: List active autopilot runs
 */
router.get('/controller/runs', (_req: Request, res: Response) => {
  try {
    const runs = getActiveRuns();
    return res.status(200).json({
      ok: true,
      count: runs.length,
      runs: runs.map(run => ({
        id: run.id,
        vtid: run.vtid,
        state: run.state,
        started_at: run.started_at,
        updated_at: run.updated_at,
        pr_number: run.pr_number,
        retry_count: run.retry_count,
      })),
    });
  } catch (error: any) {
    console.error(`[VTID-01178] List runs error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /controller/runs/:vtid → /api/v1/autopilot/controller/runs/:vtid
 * VTID-01178: Get specific run details
 */
router.get('/controller/runs/:vtid', (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) {
      return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    }

    const run = getAutopilotRun(vtid);
    if (!run) {
      return res.status(404).json({ ok: false, error: `No autopilot run found for ${vtid}` });
    }

    return res.status(200).json({ ok: true, run });
  } catch (error: any) {
    console.error(`[VTID-01178] Get run error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /controller/runs/:vtid/start → /api/v1/autopilot/controller/runs/:vtid/start
 * VTID-01178: Start autopilot run for VTID
 */
router.post('/controller/runs/:vtid/start', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { title, spec_content, task_domain, target_paths } = req.body;

    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) {
      return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    }
    if (!title || !spec_content) {
      return res.status(400).json({ ok: false, error: 'title and spec_content are required' });
    }

    console.log(`[VTID-01178] Starting autopilot run for ${vtid}`);
    const run = await startAutopilotRun(vtid, title, spec_content, task_domain, target_paths);

    return res.status(201).json({
      ok: true,
      vtid,
      run_id: run.id,
      state: run.state,
      spec_snapshot_id: run.spec_snapshot?.id,
      started_at: run.started_at,
    });
  } catch (error: any) {
    console.error(`[VTID-01178] Start run error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /controller/runs/:vtid/verify → /api/v1/autopilot/controller/runs/:vtid/verify
 * VTID-01178: Trigger post-deploy verification
 */
router.post('/controller/runs/:vtid/verify', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { service, environment = 'dev', deploy_url, merge_sha } = req.body;

    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) {
      return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    }
    if (!service) {
      return res.status(400).json({ ok: false, error: 'service is required' });
    }

    console.log(`[VTID-01178] Triggering verification for ${vtid} (${service}@${environment})`);
    const result = await runVerification({ vtid, service, environment, deploy_url, merge_sha });

    return res.status(result.passed ? 200 : 422).json({
      ok: result.ok,
      vtid,
      passed: result.passed,
      result: result.result,
      error: result.error,
    });
  } catch (error: any) {
    console.error(`[VTID-01178] Verification error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /controller/runs/:vtid/validate → /api/v1/autopilot/controller/runs/:vtid/validate
 * VTID-01178: Run validator (pre-merge check)
 */
router.post('/controller/runs/:vtid/validate', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { pr_number, repo = 'exafyltd/vitana-platform', files_changed } = req.body;

    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) {
      return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    }
    if (!pr_number) {
      return res.status(400).json({ ok: false, error: 'pr_number is required' });
    }

    console.log(`[VTID-01178] Running validation for ${vtid} PR #${pr_number}`);
    const result = await validateForMerge({ vtid, pr_number, repo, files_changed });

    return res.status(result.passed ? 200 : 422).json({
      ok: result.ok,
      vtid,
      pr_number,
      passed: result.passed,
      result: result.result,
      error: result.error,
    });
  } catch (error: any) {
    console.error(`[VTID-01178] Validation error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /spec/:vtid → /api/v1/autopilot/spec/:vtid
 * VTID-01178: Get spec snapshot for VTID
 */
router.get('/spec/:vtid', (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) {
      return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    }

    const snapshot = getSpecSnapshot(vtid);
    if (!snapshot) {
      return res.status(404).json({ ok: false, error: `No spec snapshot found for ${vtid}` });
    }

    const integrityValid = verifySpecIntegrity(vtid);
    return res.status(200).json({
      ok: true,
      vtid,
      snapshot,
      integrity_valid: integrityValid,
    });
  } catch (error: any) {
    console.error(`[VTID-01178] Get spec error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /validation/:vtid → /api/v1/autopilot/validation/:vtid
 * VTID-01178: Get validation result for VTID
 */
router.get('/validation/:vtid', (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) {
      return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    }

    const result = getValidationResult(vtid);
    if (!result) {
      return res.status(404).json({ ok: false, error: `No validation result found for ${vtid}` });
    }

    return res.status(200).json({ ok: true, vtid, result });
  } catch (error: any) {
    console.error(`[VTID-01178] Get validation error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== Health Check ====================

/**
 * GET /health → /api/v1/autopilot/health
 * VTID-0532 + VTID-0533 + VTID-0534 + VTID-0535 + VTID-01178: Autopilot health check
 */
router.get('/health', (_req: Request, res: Response) => {
  const controllerStatus = getAutopilotStatus();

  return res.status(200).json({
    ok: true,
    service: 'autopilot-api',
    timestamp: new Date().toISOString(),
    status: 'healthy',
    vtid: 'VTID-01178',
    capabilities: {
      task_extraction: true,
      planner_handoff: true,
      execution: true,
      worker_skeleton: true,
      validator_skeleton: true,
      worker_core_engine: true,
      validator_core_engine: true,
      // VTID-01178: New capabilities
      autopilot_controller: true,
      spec_snapshotting: true,
      validator_hard_gate: true,
      post_deploy_verification: true,
      acceptance_assertions: true,
    },
    controller: controllerStatus,
  });
});

export default router;
