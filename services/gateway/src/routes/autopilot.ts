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
import { isAutopilotExecutionArmed } from '../services/system-controls-service';
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
// VTID-01179: Event Loop imports
import {
  startEventLoop,
  stopEventLoop,
  getEventLoopStatus,
  getEventLoopHistory,
  resetEventLoopCursor,
} from '../services/autopilot-event-loop';

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

  // VTID-01187: Secondary governance gate (defense in depth)
  const executionArmed = await isAutopilotExecutionArmed();
  if (!executionArmed) {
    console.log('[VTID-01187] Plan submission BLOCKED - autopilot execution is DISARMED');
    return res.status(403).json({
      ok: false,
      error: 'Autopilot execution is disarmed',
      error_code: 'EXECUTION_DISARMED',
      vtid: 'VTID-01187',
      message: 'The autopilot_execution_enabled control must be armed to submit plans'
    });
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

  // VTID-01187: Secondary governance gate (defense in depth)
  const executionArmed = await isAutopilotExecutionArmed();
  if (!executionArmed) {
    console.log('[VTID-01187] Work start BLOCKED - autopilot execution is DISARMED');
    return res.status(403).json({
      ok: false,
      error: 'Autopilot execution is disarmed',
      error_code: 'EXECUTION_DISARMED',
      vtid: 'VTID-01187',
      message: 'The autopilot_execution_enabled control must be armed to start work'
    });
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

// ==================== VTID-01179: Event Loop Endpoints ====================

/**
 * GET /loop/status → /api/v1/autopilot/loop/status
 * VTID-01179: Get event loop status
 *
 * Returns:
 * - is_running: boolean
 * - poll_ms: number
 * - last_cursor: string | null
 * - processed_1h: number
 * - errors_1h: number
 * - active_runs: number
 * - runs_by_state: Record<string, number>
 */
router.get('/loop/status', async (_req: Request, res: Response) => {
  try {
    const status = await getEventLoopStatus();
    return res.status(200).json({
      vtid: 'VTID-01179',
      timestamp: new Date().toISOString(),
      ...status,
    });
  } catch (error: any) {
    console.error('[VTID-01179] Loop status error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /loop/start → /api/v1/autopilot/loop/start
 * VTID-01179: Start event loop
 */
router.post('/loop/start', async (_req: Request, res: Response) => {
  console.log('[VTID-01179] Loop start requested');
  try {
    const started = await startEventLoop();
    return res.status(200).json({
      ok: true,
      vtid: 'VTID-01179',
      started,
      message: started ? 'Event loop started' : 'Event loop disabled by configuration',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01179] Loop start error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /loop/stop → /api/v1/autopilot/loop/stop
 * VTID-01179: Stop event loop (graceful)
 */
router.post('/loop/stop', async (_req: Request, res: Response) => {
  console.log('[VTID-01179] Loop stop requested');
  try {
    await stopEventLoop();
    return res.status(200).json({
      ok: true,
      vtid: 'VTID-01179',
      message: 'Event loop stopped',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01179] Loop stop error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /loop/history → /api/v1/autopilot/loop/history
 * VTID-01179: Get processed event history
 *
 * Query params:
 * - limit: number (default 100, max 500)
 */
router.get('/loop/history', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 500);
    const history = await getEventLoopHistory(limit);
    return res.status(200).json({
      ok: true,
      vtid: 'VTID-01179',
      count: history.length,
      events: history,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01179] Loop history error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /loop/cursor/reset → /api/v1/autopilot/loop/cursor/reset
 * VTID-01179: Reset event loop cursor to a specific timestamp
 *
 * Body:
 * - timestamp: ISO timestamp or 'now' (required)
 * - reason: Optional reason for the reset
 *
 * Use cases:
 * - Skip ahead to recent events when cursor is far behind
 * - Reset to a specific point after a deployment issue
 */
router.post('/loop/cursor/reset', async (req: Request, res: Response) => {
  try {
    const { timestamp, reason } = req.body;

    if (!timestamp) {
      return res.status(400).json({
        ok: false,
        error: 'timestamp is required (ISO timestamp or "now")',
      });
    }

    // Validate timestamp format (unless 'now')
    if (timestamp !== 'now') {
      const parsed = Date.parse(timestamp);
      if (isNaN(parsed)) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid timestamp format. Use ISO format (e.g., 2026-01-16T00:00:00Z) or "now"',
        });
      }
    }

    const result = await resetEventLoopCursor(timestamp, reason || 'manual-reset-via-api');

    return res.status(result.ok ? 200 : 500).json({
      ...result,
      vtid: 'VTID-01179',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01179] Cursor reset error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== Health Check ====================

/**
 * GET /health → /api/v1/autopilot/health
 * VTID-0532 + VTID-0533 + VTID-0534 + VTID-0535 + VTID-01178 + VTID-01179: Autopilot health check
 */
router.get('/health', async (_req: Request, res: Response) => {
  const controllerStatus = getAutopilotStatus();
  let loopStatus: { ok?: boolean; is_running: boolean; execution_armed?: boolean; error?: string; [key: string]: unknown };
  try {
    loopStatus = await getEventLoopStatus();
  } catch {
    loopStatus = { ok: false, is_running: false, execution_armed: false, error: 'Failed to get loop status' };
  }

  // Determine real health: autopilot is only healthy when the event loop is running
  const loopRunning = loopStatus.is_running === true;
  const loopOk = loopStatus.ok !== false;
  const hasErrors = !!loopStatus.error;

  let status: string;
  let ok: boolean;
  if (!loopOk || hasErrors) {
    status = 'error';
    ok = false;
  } else if (!loopRunning) {
    status = 'degraded';
    ok = false;
  } else {
    status = 'healthy';
    ok = true;
  }

  const httpStatus = ok ? 200 : 200; // Always 200 so the panel can read the JSON body

  return res.status(httpStatus).json({
    ok,
    service: 'autopilot-api',
    timestamp: new Date().toISOString(),
    status,
    vtid: 'VTID-01178',
    reason: !ok
      ? (!loopRunning ? 'Event loop is not running — autopilot is inactive' : loopStatus.error || 'Unknown error')
      : undefined,
    capabilities: {
      task_extraction: true,
      planner_handoff: true,
      execution: true,
      worker_skeleton: true,
      validator_skeleton: true,
      worker_core_engine: true,
      validator_core_engine: true,
      autopilot_controller: true,
      spec_snapshotting: true,
      validator_hard_gate: true,
      post_deploy_verification: true,
      acceptance_assertions: true,
      event_loop: true,
      autonomous_state_machine: true,
      crash_safe_recovery: true,
    },
    controller: controllerStatus,
    event_loop: loopStatus,
  });
});

/**
 * GET /pipeline/health → /api/v1/autopilot/pipeline/health
 * Unified pipeline health dashboard for the E2E execution system.
 * Returns: loop status, task counts by status, worker info, stuck tasks.
 */
router.get('/pipeline/health', async (_req: Request, res: Response) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !svcKey) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }

    // Fetch in parallel: loop status, task counts, stuck tasks, worker count
    const [loopStatus, taskCountsResp, stuckTasksResp, workersResp] = await Promise.all([
      getEventLoopStatus(),
      fetch(
        `${supabaseUrl}/rest/v1/rpc/count_tasks_by_status`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: svcKey,
            Authorization: `Bearer ${svcKey}`,
          },
          body: '{}',
        }
      ).catch(() => null),
      // Find tasks stuck in_progress for >1 hour
      fetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?status=eq.in_progress&updated_at=lt.${encodeURIComponent(new Date(Date.now() - 3600000).toISOString())}&is_terminal=eq.false&select=vtid,title,updated_at&limit=10`,
        {
          headers: {
            apikey: svcKey,
            Authorization: `Bearer ${svcKey}`,
          },
        }
      ).catch(() => null),
      // Count registered workers (from recent heartbeats)
      fetch(
        `${supabaseUrl}/rest/v1/oasis_events?topic=eq.vtid.stage.worker_orchestrator.heartbeat&created_at=gt.${encodeURIComponent(new Date(Date.now() - 300000).toISOString())}&select=id&limit=1`,
        {
          headers: {
            apikey: svcKey,
            Authorization: `Bearer ${svcKey}`,
          },
        }
      ).catch(() => null),
    ]);

    // Parse task counts
    let taskCounts: Record<string, number> = {};
    if (taskCountsResp && taskCountsResp.ok) {
      const countsData = await taskCountsResp.json() as any;
      taskCounts = Array.isArray(countsData)
        ? countsData.reduce((acc: Record<string, number>, r: any) => { acc[r.status] = r.count; return acc; }, {})
        : countsData;
    }

    // Parse stuck tasks
    let stuckTasks: { vtid: string; title: string; stuck_minutes: number }[] = [];
    if (stuckTasksResp && stuckTasksResp.ok) {
      const stuckData = await stuckTasksResp.json() as any[];
      stuckTasks = stuckData.map(t => ({
        vtid: t.vtid,
        title: t.title,
        stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000),
      }));
    }

    // Parse workers
    let workersActive = false;
    if (workersResp && workersResp.ok) {
      const workerData = await workersResp.json() as any[];
      workersActive = workerData.length > 0;
    }

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      loop_running: loopStatus.is_running,
      execution_armed: loopStatus.execution_armed,
      tasks: {
        scheduled: taskCounts.scheduled || taskCounts.pending || 0,
        in_progress: taskCounts.in_progress || 0,
        completed: taskCounts.completed || 0,
        rejected: taskCounts.rejected || 0,
        blocked: taskCounts.blocked || 0,
      },
      stuck_tasks: stuckTasks,
      stuck_count: stuckTasks.length,
      workers_active: workersActive,
      loop_config: loopStatus.config,
      loop_stats: loopStatus.stats || null,
    });
  } catch (error: any) {
    console.error('[pipeline/health] Error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /pipeline/summary → /api/v1/autopilot/pipeline/summary
 * Full pipeline dashboard data: funnel, entry points, attention queue, recommendations, success rate.
 */
router.get('/pipeline/summary', async (_req: Request, res: Response) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !svcKey) {
      return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    }

    const headers = {
      'Content-Type': 'application/json',
      apikey: svcKey,
      Authorization: `Bearer ${svcKey}`,
    };

    // --- Parallel fetches ---
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    const [
      loopStatus,
      taskCountsResp,
      stuckResp,
      brokenResp,
      blockedResp,
      newReadyResp,
      entryPointResp,
      recsResp,
      workersResp,
      completedWeekResp,
      failedWeekResp,
    ] = await Promise.all([
      getEventLoopStatus(),

      // VTID Unification: ALL queries filter by vtid=like.VTID-% to match board (VTID-XXXXX only)
      // Task counts by status — direct queries
      Promise.all([
        fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(scheduled,pending)&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.in_progress&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.completed&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.rejected&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
      ]).catch(() => null),

      // Stuck: in_progress > 1 hour
      fetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.in_progress&updated_at=lt.${encodeURIComponent(oneHourAgo)}&select=vtid,title,updated_at,spec_status&limit=20`,
        { headers }
      ).catch(() => null),

      // Broken: in_progress with last event being error/failure
      fetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.in_progress&updated_at=lt.${encodeURIComponent(oneHourAgo)}&select=vtid,title,updated_at,spec_status&limit=20`,
        { headers }
      ).catch(() => null),

      // Blocked: scheduled/pending with no spec
      fetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(scheduled,pending)&or=(spec_status.is.null,spec_status.eq.missing)&select=vtid,title,updated_at,spec_status&limit=20`,
        { headers }
      ).catch(() => null),

      // New/ready: scheduled/pending with spec validated (awaiting human approval)
      fetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(scheduled,pending)&spec_status=eq.validated&select=vtid,title,updated_at,spec_status&limit=20`,
        { headers }
      ).catch(() => null),

      // Entry points: count oasis_events by source for task creation events (last 7 days)
      fetch(
        `${supabaseUrl}/rest/v1/oasis_events?vtid=like.VTID-%25&topic=in.(email.intake.task_created,vtid.task.scheduled,vtid.lifecycle.execution_approved)&created_at=gt.${encodeURIComponent(sevenDaysAgo)}&select=source,vtid&limit=500`,
        { headers }
      ).catch(() => null),

      // Recommendations: pending, limit 5
      fetch(
        `${supabaseUrl}/rest/v1/autopilot_recommendations?status=eq.pending&order=impact_score.desc&limit=5&select=id,title,summary,domain,risk_level,impact_score,status,created_at`,
        { headers }
      ).catch(() => null),

      // Workers active (recent heartbeat)
      fetch(
        `${supabaseUrl}/rest/v1/oasis_events?topic=eq.vtid.stage.worker_orchestrator.heartbeat&created_at=gt.${encodeURIComponent(new Date(Date.now() - 300000).toISOString())}&select=id&limit=1`,
        { headers }
      ).catch(() => null),

      // Completed in last 7 days (for success rate)
      fetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.completed&updated_at=gt.${encodeURIComponent(sevenDaysAgo)}&select=vtid&limit=500`,
        { headers }
      ).catch(() => null),

      // Failed/rejected in last 7 days (for success rate)
      fetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(rejected,voided)&updated_at=gt.${encodeURIComponent(sevenDaysAgo)}&select=vtid&limit=500`,
        { headers }
      ).catch(() => null),
    ]);

    // --- Parse task counts (from direct queries) ---
    let taskCounts: Record<string, number> = { scheduled: 0, in_progress: 0, completed: 0, rejected: 0 };
    if (Array.isArray(taskCountsResp)) {
      const [scheduledArr, inProgressArr, completedArr, rejectedArr] = taskCountsResp as any[][];
      taskCounts.scheduled = Array.isArray(scheduledArr) ? scheduledArr.length : 0;
      taskCounts.in_progress = Array.isArray(inProgressArr) ? inProgressArr.length : 0;
      taskCounts.completed = Array.isArray(completedArr) ? completedArr.length : 0;
      taskCounts.rejected = Array.isArray(rejectedArr) ? rejectedArr.length : 0;
    }

    // --- Parse stuck tasks ---
    let stuckTasks: any[] = [];
    if (stuckResp && stuckResp.ok) {
      const data = await stuckResp.json() as any[];
      stuckTasks = data.map(t => ({
        vtid: t.vtid,
        title: t.title || t.vtid,
        severity: 'STUCK',
        reason: `In progress for ${Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000)} minutes with no progress`,
        stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000),
        status: 'in_progress',
        spec_status: t.spec_status,
      }));
    }

    // --- Parse broken (reuse stuck data — broken = stuck with error events) ---
    // For now, stuck and broken overlap; we differentiate by duration
    const brokenTasks = stuckTasks
      .filter(t => t.stuck_minutes > 120) // > 2 hours = likely broken
      .map(t => ({ ...t, severity: 'BROKEN', reason: `Execution stalled for ${t.stuck_minutes} minutes — likely broken` }));
    const justStuck = stuckTasks.filter(t => t.stuck_minutes <= 120);

    // --- Parse blocked tasks ---
    let blockedTasks: any[] = [];
    if (blockedResp && blockedResp.ok) {
      const data = await blockedResp.json() as any[];
      blockedTasks = data.map(t => ({
        vtid: t.vtid,
        title: t.title || t.vtid,
        severity: 'BLOCKED',
        reason: 'No spec generated — cannot activate',
        stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000),
        status: 'scheduled',
        spec_status: t.spec_status || 'missing',
      }));
    }

    // --- Parse new/ready tasks ---
    let newReadyTasks: any[] = [];
    if (newReadyResp && newReadyResp.ok) {
      const data = await newReadyResp.json() as any[];
      newReadyTasks = data.map(t => ({
        vtid: t.vtid,
        title: t.title || t.vtid,
        severity: 'NEW',
        reason: 'Spec validated — waiting for human approval',
        stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000),
        status: 'scheduled',
        spec_status: 'validated',
      }));
    }

    // --- Build attention queue (sorted by severity priority) ---
    const severityOrder: Record<string, number> = { BROKEN: 0, STUCK: 1, BLOCKED: 2, NEW: 3 };
    const attentionQueue = [...brokenTasks, ...justStuck, ...blockedTasks, ...newReadyTasks]
      .sort((a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99));

    // --- Parse entry points ---
    const entryPoints: Record<string, number> = {
      'command-hub': 0,
      'orb': 0,
      'operator': 0,
      'email-intake': 0,
      'system': 0,
    };
    if (entryPointResp && entryPointResp.ok) {
      const events = await entryPointResp.json() as any[];
      events.forEach((ev: any) => {
        const src = (ev.source || '').toLowerCase();
        if (src.includes('email')) entryPoints['email-intake']++;
        else if (src.includes('orb')) entryPoints['orb']++;
        else if (src.includes('operator')) entryPoints['operator']++;
        else if (src.includes('command-hub') || src.includes('commandhub')) entryPoints['command-hub']++;
        else if (src.includes('task-intake')) entryPoints['orb']++; // task-intake = ORB/Operator
        else entryPoints['system']++;
      });
    }

    // --- Parse recommendations ---
    let recommendations: any[] = [];
    if (recsResp && recsResp.ok) {
      recommendations = await recsResp.json() as any[];
    }

    // --- Workers active ---
    let workersActive = false;
    if (workersResp && workersResp.ok) {
      const workerData = await workersResp.json() as any[];
      workersActive = workerData.length > 0;
    }

    // --- Success rate (last 7 days) ---
    let completedCount = 0;
    let failedCount = 0;
    if (completedWeekResp && completedWeekResp.ok) {
      const data = await completedWeekResp.json() as any[];
      completedCount = data.length;
    }
    if (failedWeekResp && failedWeekResp.ok) {
      const data = await failedWeekResp.json() as any[];
      failedCount = data.length;
    }
    const totalResolved = completedCount + failedCount + brokenTasks.length;
    const successRate = totalResolved > 0 ? Math.round((completedCount / totalResolved) * 100) : 0;

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      funnel: {
        scheduled: taskCounts.scheduled || taskCounts.pending || 0,
        in_progress: taskCounts.in_progress || 0,
        completed: taskCounts.completed || 0,
        rejected: taskCounts.rejected || 0,
        stuck: justStuck.length,
        broken: brokenTasks.length,
      },
      entry_points: entryPoints,
      success_rate: successRate,
      attention_queue: attentionQueue,
      recommendations,
      loop_running: loopStatus.is_running,
      execution_armed: loopStatus.execution_armed,
      workers_active: workersActive,
    });
  } catch (error: any) {
    console.error('[pipeline/summary] Error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
