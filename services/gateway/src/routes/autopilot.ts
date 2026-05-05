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
 */

import { Router, Request, Response } from 'express';
import { isAutopilotExecutionArmed } from '../services/system-controls-service';
import { emitOasisEvent } from '../services/oasis-event-service';
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

function checkDeprecatedBypass(
  req: Request,
  res: Response,
  endpointName: string,
  canonicalPath: string
): boolean {
  const bypassHeader = req.get("X-BYPASS-ORCHESTRATOR");

  if (bypassHeader === "EMERGENCY-BYPASS") {
    console.warn(`[VTID-01170] DEPRECATED endpoint used with bypass: ${endpointName}`);
    console.warn(`[VTID-01170] Canonical path: ${canonicalPath}`);
    return false; // Continue with deprecated endpoint
  }

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

router.get('/tasks/pending-plan', async (_req: Request, res: Response) => {
  console.log('[VTID-0532] Pending plan tasks requested');
  try {
    const tasks = await getPendingPlanTasks();
    return res.status(200).json({ ok: true, data: tasks });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: 'Failed to fetch pending plan tasks', details: error.message });
  }
});

// ==================== VTID-0533: Execution Pipeline ====================

router.post('/tasks/:vtid/plan', async (req: Request, res: Response) => {
  if (checkDeprecatedBypass(req, res, "POST /autopilot/tasks/:vtid/plan", "POST /api/v1/worker/orchestrator/route")) return;

  const executionArmed = await isAutopilotExecutionArmed();
  if (!executionArmed) {
    return res.status(403).json({ ok: false, error: 'Autopilot execution is disarmed', error_code: 'EXECUTION_DISARMED', vtid: 'VTID-01187', message: 'The autopilot_execution_enabled control must be armed to submit plans' });
  }

  const { vtid } = req.params;
  const { plan, metadata } = req.body;

  if (!plan || typeof plan !== 'object') return res.status(400).json({ ok: false, error: 'Validation failed' });
  if (!plan.summary || typeof plan.summary !== 'string') return res.status(400).json({ ok: false, error: 'Validation failed' });
  if (!Array.isArray(plan.steps)) return res.status(400).json({ ok: false, error: 'Validation failed' });
  if (!metadata || typeof metadata !== 'object') return res.status(400).json({ ok: false, error: 'Validation failed' });
  if (!metadata.plannerModel || typeof metadata.plannerModel !== 'string') return res.status(400).json({ ok: false, error: 'Validation failed' });

  try {
    const result = await submitPlan(vtid, plan as PlanPayload, {
      plannerModel: metadata.plannerModel,
      plannerRole: metadata.plannerRole || 'PLANNER',
      source: metadata.source,
      notes: metadata.notes
    } as PlanMetadata);

    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-api',
      status: 'success',
      message: 'Plan submitted'
    });

    return res.status(200).json({ ok: true, vtid: result.vtid, status: result.status, planSteps: result.planSteps });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: 'Failed to submit plan', details: error.message });
  }
});

router.post('/tasks/:vtid/work/start', async (req: Request, res: Response) => {
  if (checkDeprecatedBypass(req, res, "POST /autopilot/tasks/:vtid/work/start", "POST /api/v1/worker/subagent/start")) return;

  const executionArmed = await isAutopilotExecutionArmed();
  if (!executionArmed) {
    return res.status(403).json({ ok: false, error: 'Autopilot execution is disarmed', error_code: 'EXECUTION_DISARMED', vtid: 'VTID-01187' });
  }

  const { vtid } = req.params;
  const { step_id, step_index, label, agent, executor_type, notes } = req.body;

  if (!step_id || typeof step_id !== 'string') return res.status(400).json({ ok: false, error: 'Validation failed' });
  if (typeof step_index !== 'number') return res.status(400).json({ ok: false, error: 'Validation failed' });
  if (!label || typeof label !== 'string') return res.status(400).json({ ok: false, error: 'Validation failed' });
  if (!agent || typeof agent !== 'string') return res.status(400).json({ ok: false, error: 'Validation failed' });
  if (!executor_type || typeof executor_type !== 'string') return res.status(400).json({ ok: false, error: 'Validation failed' });

  try {
    const result = await startWork(vtid, { step_id, step_index, label, agent, executor_type, notes } as WorkStartRequest);
    if (!result.ok) {
      const httpStatus = result.error.code === 'worker.invalid_transition' ? 409 : 400;
      return res.status(httpStatus).json({ ok: false, error: result.error.message, code: result.error.code });
    }

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-api',
      status: 'success',
      message: `Work started on step ${step_id}`
    });

    return res.status(200).json({ ok: true, eventId: result.eventId, worker: result.state });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: 'Failed to start work', details: error.message });
  }
});

router.post('/tasks/:vtid/work/complete', async (req: Request, res: Response) => {
  if (checkDeprecatedBypass(req, res, "POST /autopilot/tasks/:vtid/work/complete", "POST /api/v1/worker/subagent/complete")) return;

  const { vtid } = req.params;
  const { step_id, step_index, status, output_summary, error, agent } = req.body;

  if (!step_id || typeof step_id !== 'string') return res.status(400).json({ ok: false, error: 'Validation failed' });
  if (typeof step_index !== 'number') return res.status(400).json({ ok: false, error: 'Validation failed' });
  if (!status || !['completed', 'failed'].includes(status)) return res.status(400).json({ ok: false, error: 'Validation failed' });

  try {
    const result = await completeWork(vtid, { step_id, step_index, status, output_summary, error, agent } as WorkCompleteRequest);
    if (!result.ok) {
      const httpStatus = result.error.code === 'worker.invalid_transition' ? 409 : 400;
      return res.status(httpStatus).json({ ok: false, error: result.error.message, code: result.error.code });
    }

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-api',
      status: 'success',
      message: `Work completed on step ${step_id}`
    });

    return res.status(200).json({ ok: true, eventId: result.eventId, worker: result.state });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: 'Failed to complete work', details: error.message });
  }
});

router.post('/tasks/:vtid/validate', async (req: Request, res: Response) => {
  const { vtid } = req.params;
  const { mode, override } = req.body;

  const validateRequest: ValidateRequest = { mode: mode || 'auto', override: override || null };

  try {
    const validationResult = await runValidation(vtid, validateRequest);

    if (!validationResult.ok) {
      const statusCode = validationResult.error.code === 'validator.internal_error' ? 500 : 400;
      return res.status(statusCode).json({ ok: false, error: validationResult.error.message, code: validationResult.error.code });
    }

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-api',
      status: 'success',
      message: 'Validation processed'
    });

    return res.status(200).json({ ok: true, vtid, validation: validationResult.result });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: 'Failed to run validation', code: 'validator.internal_error', details: error.message });
  }
});

router.get('/tasks/:vtid/status', async (req: Request, res: Response) => {
  const { vtid } = req.params;
  try {
    const taskStatus = await getAutopilotTaskStatus(vtid);
    if (!taskStatus) return res.status(404).json({ ok: false, error: `Task ${vtid} not found` });

    const workerResult = await getWorkerState(vtid);
    const validatorState = await getValidatorState(vtid);

    const statusResponse: Record<string, unknown> = {
      ok: true,
      vtid: taskStatus.vtid,
      status: {
        planner: { status: taskStatus.status, planSteps: taskStatus.planSteps || 0 },
        worker: workerResult.ok ? workerResult.state : { overall_status: 'pending', steps: [] },
        validator: validatorState
      },
      title: taskStatus.title,
      planSteps: taskStatus.planSteps,
      validationStatus: validatorState.final_status,
      createdAt: taskStatus.createdAt,
      updatedAt: taskStatus.updatedAt
    };

    return res.status(200).json(statusResponse);
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: 'Failed to get task status', details: error.message });
  }
});

// ==================== VTID-01178: Autopilot Controller Endpoints ====================

router.get('/controller/status', (_req: Request, res: Response) => {
  try {
    return res.status(200).json({ ok: true, service: 'autopilot-controller', version: '1.0.0', vtid: 'VTID-01178', timestamp: new Date().toISOString(), ...getAutopilotStatus() });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/controller/runs', (_req: Request, res: Response) => {
  try {
    const runs = getActiveRuns();
    return res.status(200).json({ ok: true, count: runs.length, runs: runs.map(r => ({ id: r.id, vtid: r.vtid, state: r.state, started_at: r.started_at, updated_at: r.updated_at, pr_number: r.pr_number, retry_count: r.retry_count })) });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/controller/runs/:vtid', (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    if (!/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    const run = getAutopilotRun(vtid);
    if (!run) return res.status(404).json({ ok: false, error: `No run found for ${vtid}` });
    return res.status(200).json({ ok: true, run });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/controller/runs/:vtid/start', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { title, spec_content, task_domain, target_paths } = req.body;

    if (!/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    if (!title || !spec_content) return res.status(400).json({ ok: false, error: 'title and spec_content are required' });

    const run = await startAutopilotRun(vtid, title, spec_content, task_domain, target_paths);

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-controller',
      status: 'success',
      message: 'Run started'
    });

    return res.status(201).json({ ok: true, vtid, run_id: run.id, state: run.state, spec_snapshot_id: run.spec_snapshot?.id, started_at: run.started_at });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/controller/runs/:vtid/verify', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { service, environment = 'dev', deploy_url, merge_sha } = req.body;

    if (!/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    if (!service) return res.status(400).json({ ok: false, error: 'service is required' });

    const result = await runVerification({ vtid, service, environment, deploy_url, merge_sha });

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-controller',
      status: 'success',
      message: 'Verification triggered'
    });

    return res.status(result.passed ? 200 : 422).json({ ok: result.ok, vtid, passed: result.passed, result: result.result, error: result.error });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/controller/runs/:vtid/validate', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { pr_number, repo = 'exafyltd/vitana-platform', files_changed } = req.body;

    if (!/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    if (!pr_number) return res.status(400).json({ ok: false, error: 'pr_number is required' });

    const result = await validateForMerge({ vtid, pr_number, repo, files_changed });

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-controller',
      status: 'success',
      message: 'Validation triggered'
    });

    return res.status(result.passed ? 200 : 422).json({ ok: result.ok, vtid, pr_number, passed: result.passed, result: result.result, error: result.error });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/spec/:vtid', (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    if (!/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid format' });
    const snapshot = getSpecSnapshot(vtid);
    if (!snapshot) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.status(200).json({ ok: true, vtid, snapshot, integrity_valid: verifySpecIntegrity(vtid) });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/validation/:vtid', (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    if (!/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid format' });
    const result = getValidationResult(vtid);
    if (!result) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.status(200).json({ ok: true, vtid, result });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== VTID-01179: Event Loop Endpoints ====================

router.get('/loop/status', async (_req: Request, res: Response) => {
  try {
    const status = await getEventLoopStatus();
    return res.status(200).json({ vtid: 'VTID-01179', timestamp: new Date().toISOString(), ...status });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/loop/start', async (_req: Request, res: Response) => {
  try {
    const started = await startEventLoop();
    await emitOasisEvent({ vtid: 'VTID-01179', type: 'dev_autopilot.execution.bridged' as any, source: 'autopilot-loop', status: 'success', message: 'Loop started' });
    return res.status(200).json({ ok: true, vtid: 'VTID-01179', started, message: started ? 'Event loop started' : 'Disabled by config', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/loop/stop', async (_req: Request, res: Response) => {
  try {
    await stopEventLoop();
    await emitOasisEvent({ vtid: 'VTID-01179', type: 'dev_autopilot.execution.bridged' as any, source: 'autopilot-loop', status: 'success', message: 'Loop stopped' });
    return res.status(200).json({ ok: true, vtid: 'VTID-01179', message: 'Event loop stopped', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/loop/history', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 500);
    const history = await getEventLoopHistory(limit);
    return res.status(200).json({ ok: true, vtid: 'VTID-01179', count: history.length, events: history, timestamp: new Date().toISOString() });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/loop/cursor/reset', async (req: Request, res: Response) => {
  try {
    const { timestamp, reason } = req.body;
    if (!timestamp) return res.status(400).json({ ok: false, error: 'timestamp is required' });
    if (timestamp !== 'now' && isNaN(Date.parse(timestamp))) return res.status(400).json({ ok: false, error: 'Invalid timestamp format' });

    const result = await resetEventLoopCursor(timestamp, reason || 'manual-reset-via-api');
    await emitOasisEvent({ vtid: 'VTID-01179', type: 'dev_autopilot.execution.bridged' as any, source: 'autopilot-loop', status: 'success', message: 'Cursor reset' });

    return res.status(result.ok ? 200 : 500).json({ ...result, vtid: 'VTID-01179', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== Health Check ====================

router.get('/health', async (_req: Request, res: Response) => {
  const controllerStatus = getAutopilotStatus();
  let loopStatus: any;
  try { loopStatus = await getEventLoopStatus(); } catch { loopStatus = { ok: false, is_running: false, error: 'Failed' }; }

  const loopRunning = loopStatus.is_running === true;
  const loopOk = loopStatus.ok !== false;
  const hasErrors = !!loopStatus.error;

  const ok = loopOk && !hasErrors && loopRunning;
  const status = !loopOk || hasErrors ? 'error' : (!loopRunning ? 'degraded' : 'healthy');

  return res.status(200).json({
    ok, service: 'autopilot-api', timestamp: new Date().toISOString(), status, vtid: 'VTID-01178',
    reason: !ok ? (!loopRunning ? 'Event loop is not running' : loopStatus.error) : undefined,
    capabilities: { execution: true },
    controller: controllerStatus, event_loop: loopStatus,
  });
});

router.get('/pipeline/health', async (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true });
});

router.get('/pipeline/summary', async (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true });
});

export default router;