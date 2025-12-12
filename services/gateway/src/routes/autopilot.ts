/**
 * Autopilot Routes - VTID-0532 + VTID-0533
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
 */

import { Router, Request, Response } from 'express';
import {
  getPendingPlanTasks,
  submitPlan,
  emitWorkStarted,
  emitWorkCompleted,
  emitValidationResult,
  getAutopilotTaskStatus,
  PlanPayload,
  PlanMetadata,
  WorkStartedPayload,
  WorkCompletedPayload,
  ValidationResultPayload,
  ValidationMetadata
} from '../services/operator-service';

const router = Router();

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
  const { vtid } = req.params;
  const { plan, metadata } = req.body;

  console.log(`[VTID-0533] Plan submission received for ${vtid}`);

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
 * VTID-0533: Worker Skeleton - Mark work started on a step
 *
 * Request body:
 * {
 *   "stepId": "step-1",
 *   "workerModel": "gemini-flash",
 *   "notes": "optional"
 * }
 *
 * Response:
 * { "ok": true, "eventId": "..." }
 */
router.post('/tasks/:vtid/work/start', async (req: Request, res: Response) => {
  const { vtid } = req.params;
  const { stepId, workerModel, notes } = req.body;

  console.log(`[VTID-0533] Work start received for ${vtid}, step: ${stepId}`);

  // Validate request body
  if (!stepId || typeof stepId !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "stepId" string'
    });
  }

  if (!workerModel || typeof workerModel !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "workerModel" string'
    });
  }

  try {
    const result = await emitWorkStarted(vtid, {
      stepId,
      workerModel,
      notes
    } as WorkStartedPayload);

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.error
      });
    }

    return res.status(200).json({
      ok: true,
      eventId: result.eventId
    });
  } catch (error: any) {
    console.warn(`[VTID-0533] Work start error for ${vtid}:`, error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to emit work started event',
      details: error.message
    });
  }
});

/**
 * POST /tasks/:vtid/work/complete → /api/v1/autopilot/tasks/:vtid/work/complete
 * VTID-0533: Worker Skeleton - Mark work completed on a step
 *
 * Request body:
 * {
 *   "stepId": "step-1",
 *   "status": "success",
 *   "outputSummary": "short description",
 *   "details": {}
 * }
 *
 * Response:
 * { "ok": true, "eventId": "..." }
 */
router.post('/tasks/:vtid/work/complete', async (req: Request, res: Response) => {
  const { vtid } = req.params;
  const { stepId, status, outputSummary, details } = req.body;

  console.log(`[VTID-0533] Work complete received for ${vtid}, step: ${stepId}`);

  // Validate request body
  if (!stepId || typeof stepId !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "stepId" string'
    });
  }

  if (!status || !['success', 'failure', 'partial'].includes(status)) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "status" (must be "success", "failure", or "partial")'
    });
  }

  if (!outputSummary || typeof outputSummary !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "outputSummary" string'
    });
  }

  try {
    const result = await emitWorkCompleted(vtid, {
      stepId,
      status,
      outputSummary,
      details
    } as WorkCompletedPayload);

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.error
      });
    }

    return res.status(200).json({
      ok: true,
      eventId: result.eventId
    });
  } catch (error: any) {
    console.warn(`[VTID-0533] Work complete error for ${vtid}:`, error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to emit work completed event',
      details: error.message
    });
  }
});

/**
 * POST /tasks/:vtid/validate → /api/v1/autopilot/tasks/:vtid/validate
 * VTID-0533: Validator Skeleton - Submit validation result
 *
 * Request body:
 * {
 *   "result": {
 *     "status": "approved",
 *     "issues": [
 *       { "code": "MISSING_TESTS", "message": "..." }
 *     ],
 *     "notes": "optional"
 *   },
 *   "metadata": {
 *     "validatorModel": "gpt-5.1",
 *     "validatorRole": "VALIDATOR"
 *   }
 * }
 *
 * Response:
 * { "ok": true, "eventId": "..." }
 */
router.post('/tasks/:vtid/validate', async (req: Request, res: Response) => {
  const { vtid } = req.params;
  const { result, metadata } = req.body;

  console.log(`[VTID-0533] Validation received for ${vtid}`);

  // Validate request body
  if (!result || typeof result !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "result" object in request body'
    });
  }

  if (!result.status || !['approved', 'rejected'].includes(result.status)) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "result.status" (must be "approved" or "rejected")'
    });
  }

  if (!metadata || typeof metadata !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "metadata" object in request body'
    });
  }

  if (!metadata.validatorModel || typeof metadata.validatorModel !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: 'Missing or invalid "metadata.validatorModel" string'
    });
  }

  try {
    const eventResult = await emitValidationResult(
      vtid,
      {
        status: result.status,
        issues: result.issues,
        notes: result.notes
      } as ValidationResultPayload,
      {
        validatorModel: metadata.validatorModel,
        validatorRole: metadata.validatorRole || 'VALIDATOR'
      } as ValidationMetadata
    );

    if (!eventResult.ok) {
      return res.status(400).json({
        ok: false,
        error: eventResult.error
      });
    }

    return res.status(200).json({
      ok: true,
      eventId: eventResult.eventId
    });
  } catch (error: any) {
    console.warn(`[VTID-0533] Validation error for ${vtid}:`, error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to emit validation event',
      details: error.message
    });
  }
});

/**
 * GET /tasks/:vtid/status → /api/v1/autopilot/tasks/:vtid/status
 * VTID-0533: Get task status
 *
 * Response:
 * {
 *   "vtid": "...",
 *   "status": "planned|in-progress|completed|validated",
 *   "title": "...",
 *   "planSteps": 3,
 *   "validationStatus": "pending|approved|rejected",
 *   "createdAt": "...",
 *   "updatedAt": "..."
 * }
 */
router.get('/tasks/:vtid/status', async (req: Request, res: Response) => {
  const { vtid } = req.params;

  console.log(`[VTID-0533] Status requested for ${vtid}`);

  try {
    const taskStatus = await getAutopilotTaskStatus(vtid);

    if (!taskStatus) {
      return res.status(404).json({
        ok: false,
        error: `Task ${vtid} not found`
      });
    }

    return res.status(200).json({
      ok: true,
      ...taskStatus
    });
  } catch (error: any) {
    console.warn(`[VTID-0533] Status error for ${vtid}:`, error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to get task status',
      details: error.message
    });
  }
});

// ==================== Health Check ====================

/**
 * GET /health → /api/v1/autopilot/health
 * VTID-0532 + VTID-0533: Autopilot health check
 */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'autopilot-api',
    timestamp: new Date().toISOString(),
    status: 'healthy',
    vtid: 'VTID-0533',
    capabilities: {
      task_extraction: true,
      planner_handoff: true,
      execution: true,
      worker_skeleton: true,
      validator_skeleton: true
    }
  });
});

export default router;
