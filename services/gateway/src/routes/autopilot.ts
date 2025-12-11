/**
 * Autopilot Routes - VTID-0532
 *
 * Planner Handoff API for multi-agent planning workflows.
 *
 * Final API endpoints (after mounting at /api/v1/autopilot):
 * - GET /api/v1/autopilot/tasks/pending-plan - List pending tasks for planner agents
 * - GET /api/v1/autopilot/health - Health check
 */

import { Router, Request, Response } from 'express';
import { getPendingPlanTasks } from '../services/operator-service';

const router = Router();

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
    console.error('[VTID-0532] Pending plan tasks error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to fetch pending plan tasks',
      details: error.message
    });
  }
});

/**
 * GET /health → /api/v1/autopilot/health
 * VTID-0532: Autopilot health check
 */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'autopilot-api',
    timestamp: new Date().toISOString(),
    status: 'healthy',
    vtid: 'VTID-0532',
    capabilities: {
      task_extraction: true,
      planner_handoff: true,
      execution: false  // Execution will be added in VTID-0533
    }
  });
});

export default router;
