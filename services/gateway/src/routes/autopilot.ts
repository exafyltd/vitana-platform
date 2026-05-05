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
 */

import { Router, Request, Response } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
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
    return false;
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
  return true;
}

// ==================== VTID-0532: Planner Handoff ====================

router.get('/tasks/pending-plan', async (_req: Request, res: Response) => {
  try {
    const tasks = await getPendingPlanTasks();
    return res.status(200).json({ ok: true, data: tasks });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: 'Failed to fetch pending plan tasks', details: error.message });
  }
});

// ==================== VTID-0533: Execution Pipeline ====================

router.post('/tasks/:vtid/plan', async (req: Request, res: Response) => {
  if (checkDeprecatedBypass(req, res, "POST /autopilot/tasks/:vtid/plan", "POST /api/v1/worker/orchestrator/route")) {
    return;
  }

  const executionArmed = await isAutopilotExecutionArmed();
  if (!executionArmed) {
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

  if (!plan || typeof plan !== 'object') return res.status(400).json({ ok: false, error: 'Missing or invalid "plan" object' });
  if (!plan.summary || typeof plan.summary !== 'string') return res.status(400).json({ ok: false, error: 'Missing or invalid "plan.summary" string' });
  if (!Array.isArray(plan.steps)) return res.status(400).json({ ok: false, error: 'Missing or invalid "plan.steps" array' });
  if (!metadata || typeof metadata !== 'object') return res.status(400).json({ ok: false, error: 'Missing or invalid "metadata" object' });
  if (!metadata.plannerModel || typeof metadata.plannerModel !== 'string') return res.status(400).json({ ok: false, error: 'Missing or invalid "metadata.plannerModel"' });

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
      return res.status(400).json({ ok: false, error: result.error });
    }

    await emitOasisEvent({
      vtid: result.vtid || vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-api',
      status: 'success',
      message: `Plan submitted for ${vtid}`,
    });

    return res.status(200).json({ ok: true, vtid: result.vtid, status: result.status, planSteps: result.planSteps });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: 'Failed to submit plan', details: error.message });
  }
});

router.post('/tasks/:vtid/work/start', async (req: Request, res: Response) => {
  if (checkDeprecatedBypass(req, res, "POST /autopilot/tasks/:vtid/work/start", "POST /api/v1/worker/subagent/start")) {
    return;
  }

  const executionArmed = await isAutopilotExecutionArmed();
  if (!executionArmed) {
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

  if (!step_id || typeof step_id !== 'string') return res.status(400).json({ ok: false, error: 'Missing or invalid "step_id"' });
  if (typeof step_index !== 'number') return res.status(400).json({ ok: false, error: 'Missing or invalid "step_index"' });
  if (!label || typeof label !== 'string') return res.status(400).json({ ok: false, error: 'Missing or invalid "label"' });
  if (!agent || typeof agent !== 'string') return res.status(400).json({ ok: false, error: 'Missing or invalid "agent"' });
  if (!executor_type || typeof executor_type !== 'string') return res.status(400).json({ ok: false, error: 'Missing or invalid "executor_type"' });

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
      const httpStatus = result.error.code === 'worker.invalid_transition' ? 409 : 400;
      return res.status(httpStatus).json({ ok: false, error: result.error.message, code: result.error.code });
    }

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-api',
      status: 'success',
      message: `Work started for ${vtid} step ${step_id}`,
    });

    return res.status(200).json({ ok: true, eventId: result.eventId, worker: result.state });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: 'Failed to start work', details: error.message });
  }
});

router.post('/tasks/:vtid/work/complete', async (req: Request, res: Response) => {
  if (checkDeprecatedBypass(req, res, "POST /autopilot/tasks/:vtid/work/complete", "POST /api/v1/worker/subagent/complete")) {
    return;
  }

  const { vtid } = req.params;
  const { step_id, step_index, status, output_summary, error, agent } = req.body;

  if (!step_id || typeof step_id !== 'string') return res.status(400).json({ ok: false, error: 'Missing or invalid "step_id"' });
  if (typeof step_index !== 'number') return res.status(400).json({ ok: false, error: 'Missing or invalid "step_index"' });
  if (!status || !['completed', 'failed'].includes(status)) return res.status(400).json({ ok: false, error: 'Missing or invalid "status"' });

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
      const httpStatus = result.error.code === 'worker.invalid_transition' ? 409 : 400;
      return res.status(httpStatus).json({ ok: false, error: result.error.message, code: result.error.code });
    }

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-api',
      status: 'success',
      message: `Work completed for ${vtid} step ${step_id}`,
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
      message: `Validation triggered for ${vtid}`,
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
    return res.status(500).json({ ok: false, error: error.message });
  }
});

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
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/controller/runs/:vtid', (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid VTID format' });

    const run = getAutopilotRun(vtid);
    if (!run) return res.status(404).json({ ok: false, error: `No autopilot run found for ${vtid}` });

    return res.status(200).json({ ok: true, run });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/controller/runs/:vtid/start', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { title, spec_content, task_domain, target_paths } = req.body;

    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    if (!title || !spec_content) return res.status(400).json({ ok: false, error: 'title and spec_content are required' });

    const run = await startAutopilotRun(vtid, title, spec_content, task_domain, target_paths);

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.approved' as any,
      source: 'autopilot-controller',
      status: 'success',
      message: `Autopilot run started for ${vtid}`,
    });

    return res.status(201).json({
      ok: true,
      vtid,
      run_id: run.id,
      state: run.state,
      spec_snapshot_id: run.spec_snapshot?.id,
      started_at: run.started_at,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/controller/runs/:vtid/verify', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { service, environment = 'dev', deploy_url, merge_sha } = req.body;

    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    if (!service) return res.status(400).json({ ok: false, error: 'service is required' });

    const result = await runVerification({ vtid, service, environment, deploy_url, merge_sha });

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-controller',
      status: 'success',
      message: `Autopilot verification triggered for ${vtid}`,
    });

    return res.status(result.passed ? 200 : 422).json({
      ok: result.ok,
      vtid,
      passed: result.passed,
      result: result.result,
      error: result.error,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/controller/runs/:vtid/validate', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { pr_number, repo = 'exafyltd/vitana-platform', files_changed } = req.body;

    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid VTID format' });
    if (!pr_number) return res.status(400).json({ ok: false, error: 'pr_number is required' });

    const result = await validateForMerge({ vtid, pr_number, repo, files_changed });

    await emitOasisEvent({
      vtid,
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-controller',
      status: 'success',
      message: `Autopilot merge validation triggered for ${vtid}`,
    });

    return res.status(result.passed ? 200 : 422).json({
      ok: result.ok,
      vtid,
      pr_number,
      passed: result.passed,
      result: result.result,
      error: result.error,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/spec/:vtid', (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid VTID format' });

    const snapshot = getSpecSnapshot(vtid);
    if (!snapshot) return res.status(404).json({ ok: false, error: `No spec snapshot found for ${vtid}` });

    const integrityValid = verifySpecIntegrity(vtid);
    return res.status(200).json({ ok: true, vtid, snapshot, integrity_valid: integrityValid });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/validation/:vtid', (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) return res.status(400).json({ ok: false, error: 'Invalid VTID format' });

    const result = getValidationResult(vtid);
    if (!result) return res.status(404).json({ ok: false, error: `No validation result found for ${vtid}` });

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
    
    await emitOasisEvent({
      vtid: 'VTID-01179',
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-loop',
      status: 'success',
      message: `Event loop started`,
    });

    return res.status(200).json({ ok: true, vtid: 'VTID-01179', started, message: started ? 'Event loop started' : 'Event loop disabled by configuration', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/loop/stop', async (_req: Request, res: Response) => {
  try {
    await stopEventLoop();
    
    await emitOasisEvent({
      vtid: 'VTID-01179',
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-loop',
      status: 'success',
      message: `Event loop stopped`,
    });

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

    if (!timestamp) return res.status(400).json({ ok: false, error: 'timestamp is required (ISO timestamp or "now")' });

    if (timestamp !== 'now') {
      if (isNaN(Date.parse(timestamp))) return res.status(400).json({ ok: false, error: 'Invalid timestamp format.' });
    }

    const result = await resetEventLoopCursor(timestamp, reason || 'manual-reset-via-api');

    await emitOasisEvent({
      vtid: 'VTID-01179',
      type: 'dev_autopilot.execution.bridged' as any,
      source: 'autopilot-loop',
      status: 'success',
      message: `Event loop cursor reset triggered`,
    });

    return res.status(result.ok ? 200 : 500).json({ ...result, vtid: 'VTID-01179', timestamp: new Date().toISOString() });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== Health Check ====================

router.get('/health', async (_req: Request, res: Response) => {
  const controllerStatus = getAutopilotStatus();
  let loopStatus: { ok?: boolean; is_running: boolean; execution_armed?: boolean; error?: string; [key: string]: unknown };
  try {
    loopStatus = await getEventLoopStatus();
  } catch {
    loopStatus = { ok: false, is_running: false, execution_armed: false, error: 'Failed to get loop status' };
  }

  const loopRunning = loopStatus.is_running === true;
  const loopOk = loopStatus.ok !== false;
  const hasErrors = !!loopStatus.error;

  let status: string;
  let ok: boolean;
  if (!loopOk || hasErrors) { status = 'error'; ok = false; }
  else if (!loopRunning) { status = 'degraded'; ok = false; }
  else { status = 'healthy'; ok = true; }

  return res.status(200).json({
    ok,
    service: 'autopilot-api',
    timestamp: new Date().toISOString(),
    status,
    vtid: 'VTID-01178',
    reason: !ok ? (!loopRunning ? 'Event loop is not running — autopilot is inactive' : loopStatus.error || 'Unknown error') : undefined,
    capabilities: {
      task_extraction: true, planner_handoff: true, execution: true, worker_skeleton: true, validator_skeleton: true,
      worker_core_engine: true, validator_core_engine: true, autopilot_controller: true, spec_snapshotting: true,
      validator_hard_gate: true, post_deploy_verification: true, acceptance_assertions: true, event_loop: true,
      autonomous_state_machine: true, crash_safe_recovery: true,
    },
    controller: controllerStatus,
    event_loop: loopStatus,
  });
});

router.get('/pipeline/health', async (_req: Request, res: Response) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !svcKey) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

    const [loopStatus, taskCountsResp, stuckTasksResp, workersResp] = await Promise.all([
      getEventLoopStatus(),
      fetch(`${supabaseUrl}/rest/v1/rpc/count_tasks_by_status`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` }, body: '{}' }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/vtid_ledger?status=eq.in_progress&updated_at=lt.${encodeURIComponent(new Date(Date.now() - 3600000).toISOString())}&is_terminal=eq.false&select=vtid,title,updated_at&limit=10`, { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/oasis_events?topic=eq.vtid.stage.worker_orchestrator.heartbeat&created_at=gt.${encodeURIComponent(new Date(Date.now() - 300000).toISOString())}&select=id&limit=1`, { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }).catch(() => null),
    ]);

    let taskCounts: Record<string, number> = {};
    if (taskCountsResp && taskCountsResp.ok) {
      const countsData = await taskCountsResp.json() as any;
      taskCounts = Array.isArray(countsData) ? countsData.reduce((acc: Record<string, number>, r: any) => { acc[r.status] = r.count; return acc; }, {}) : countsData;
    }

    let stuckTasks: { vtid: string; title: string; stuck_minutes: number }[] = [];
    if (stuckTasksResp && stuckTasksResp.ok) {
      const stuckData = await stuckTasksResp.json() as any[];
      stuckTasks = stuckData.map(t => ({ vtid: t.vtid, title: t.title, stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000) }));
    }

    let workersActive = false;
    if (workersResp && workersResp.ok) {
      const workerData = await workersResp.json() as any[];
      workersActive = workerData.length > 0;
    }

    return res.status(200).json({
      ok: true, timestamp: new Date().toISOString(), loop_running: loopStatus.is_running, execution_armed: loopStatus.execution_armed,
      tasks: { scheduled: taskCounts.scheduled || taskCounts.pending || 0, in_progress: taskCounts.in_progress || 0, completed: taskCounts.completed || 0, rejected: taskCounts.rejected || 0, blocked: taskCounts.blocked || 0 },
      stuck_tasks: stuckTasks, stuck_count: stuckTasks.length, workers_active: workersActive, loop_config: loopStatus.config, loop_stats: loopStatus.stats || null,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/pipeline/summary', async (_req: Request, res: Response) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !svcKey) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

    const headers = { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` };

    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    const [
      loopStatus, taskCountsResp, stuckResp, brokenResp, blockedResp, newReadyResp, entryPointResp, recsResp, workersResp, completedWeekResp, failedWeekResp
    ] = await Promise.all([
      getEventLoopStatus(),
      Promise.all([
        fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(scheduled,pending)&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.in_progress&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.completed&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.rejected&select=vtid&limit=500`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
      ]).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.in_progress&updated_at=lt.${encodeURIComponent(oneHourAgo)}&select=vtid,title,updated_at,spec_status&limit=20`, { headers }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.in_progress&updated_at=lt.${encodeURIComponent(oneHourAgo)}&select=vtid,title,updated_at,spec_status&limit=20`, { headers }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(scheduled,pending)&or=(spec_status.is.null,spec_status.eq.missing)&select=vtid,title,updated_at,spec_status&limit=20`, { headers }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(scheduled,pending)&spec_status=eq.validated&select=vtid,title,updated_at,spec_status&limit=20`, { headers }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/oasis_events?vtid=like.VTID-%25&topic=in.(email.intake.task_created,vtid.task.scheduled,vtid.lifecycle.execution_approved)&created_at=gt.${encodeURIComponent(sevenDaysAgo)}&select=source,vtid&limit=500`, { headers }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/autopilot_recommendations?status=eq.pending&order=impact_score.desc&limit=5&select=id,title,summary,domain,risk_level,impact_score,status,created_at`, { headers }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/oasis_events?topic=eq.vtid.stage.worker_orchestrator.heartbeat&created_at=gt.${encodeURIComponent(new Date(Date.now() - 300000).toISOString())}&select=id&limit=1`, { headers }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=eq.completed&updated_at=gt.${encodeURIComponent(sevenDaysAgo)}&select=vtid&limit=500`, { headers }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-%25&status=in.(rejected,voided)&updated_at=gt.${encodeURIComponent(sevenDaysAgo)}&select=vtid&limit=500`, { headers }).catch(() => null),
    ]);

    let taskCounts: Record<string, number> = { scheduled: 0, in_progress: 0, completed: 0, rejected: 0 };
    if (Array.isArray(taskCountsResp)) {
      const [scheduledArr, inProgressArr, completedArr, rejectedArr] = taskCountsResp as any[][];
      taskCounts.scheduled = Array.isArray(scheduledArr) ? scheduledArr.length : 0;
      taskCounts.in_progress = Array.isArray(inProgressArr) ? inProgressArr.length : 0;
      taskCounts.completed = Array.isArray(completedArr) ? completedArr.length : 0;
      taskCounts.rejected = Array.isArray(rejectedArr) ? rejectedArr.length : 0;
    }

    let stuckTasks: any[] = [];
    if (stuckResp && stuckResp.ok) {
      const data = await stuckResp.json() as any[];
      stuckTasks = data.map(t => ({ vtid: t.vtid, title: t.title || t.vtid, severity: 'STUCK', reason: `In progress for ${Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000)} minutes with no progress`, stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000), status: 'in_progress', spec_status: t.spec_status }));
    }

    const brokenTasks = stuckTasks.filter(t => t.stuck_minutes > 120).map(t => ({ ...t, severity: 'BROKEN', reason: `Execution stalled for ${t.stuck_minutes} minutes — likely broken` }));
    const justStuck = stuckTasks.filter(t => t.stuck_minutes <= 120);

    let blockedTasks: any[] = [];
    if (blockedResp && blockedResp.ok) {
      const data = await blockedResp.json() as any[];
      blockedTasks = data.map(t => ({ vtid: t.vtid, title: t.title || t.vtid, severity: 'BLOCKED', reason: 'No spec generated — cannot activate', stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000), status: 'scheduled', spec_status: t.spec_status || 'missing' }));
    }

    let newReadyTasks: any[] = [];
    if (newReadyResp && newReadyResp.ok) {
      const data = await newReadyResp.json() as any[];
      newReadyTasks = data.map(t => ({ vtid: t.vtid, title: t.title || t.vtid, severity: 'NEW', reason: 'Spec validated — waiting for human approval', stuck_minutes: Math.round((Date.now() - new Date(t.updated_at).getTime()) / 60000), status: 'scheduled', spec_status: 'validated' }));
    }

    const severityOrder: Record<string, number> = { BROKEN: 0, STUCK: 1, BLOCKED: 2, NEW: 3 };
    const attentionQueue = [...brokenTasks, ...justStuck, ...blockedTasks, ...newReadyTasks].sort((a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99));

    const entryPoints: Record<string, number> = { 'command-hub': 0, 'orb': 0, 'operator': 0, 'email-intake': 0, 'system': 0 };
    if (entryPointResp && entryPointResp.ok) {
      const events = await entryPointResp.json() as any[];
      events.forEach((ev: any) => {
        const src = (ev.source || '').toLowerCase();
        if (src.includes('email')) entryPoints['email-intake']++;
        else if (src.includes('orb') || src.includes('task-intake')) entryPoints['orb']++;
        else if (src.includes('operator')) entryPoints['operator']++;
        else if (src.includes('command-hub') || src.includes('commandhub')) entryPoints['command-hub']++;
        else entryPoints['system']++;
      });
    }

    let recommendations: any[] = [];
    if (recsResp && recsResp.ok) recommendations = await recsResp.json() as any[];

    let workersActive = false;
    if (workersResp && workersResp.ok) {
      const workerData = await workersResp.json() as any[];
      workersActive = workerData.length > 0;
    }

    let completedCount = 0; let failedCount = 0;
    if (completedWeekResp && completedWeekResp.ok) completedCount = (await completedWeekResp.json() as any[]).length;
    if (failedWeekResp && failedWeekResp.ok) failedCount = (await failedWeekResp.json() as any[]).length;
    
    const totalResolved = completedCount + failedCount + brokenTasks.length;
    const successRate = totalResolved > 0 ? Math.round((completedCount / totalResolved) * 100) : 0;

    return res.status(200).json({
      ok: true, timestamp: new Date().toISOString(),
      funnel: { scheduled: taskCounts.scheduled || taskCounts.pending || 0, in_progress: taskCounts.in_progress || 0, completed: taskCounts.completed || 0, rejected: taskCounts.rejected || 0, stuck: justStuck.length, broken: brokenTasks.length },
      entry_points: entryPoints, success_rate: successRate, attention_queue: attentionQueue, recommendations,
      loop_running: loopStatus.is_running, execution_armed: loopStatus.execution_armed, workers_active: workersActive,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;