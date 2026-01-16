/**
 * Worker Connector Routes - VTID-01183
 *
 * API endpoints for worker agents to connect to the Autopilot Event Loop.
 *
 * Endpoints:
 * - POST /register - Register a worker agent
 * - DELETE /register/:worker_id - Unregister a worker
 * - GET /workers - List active workers
 * - GET /tasks/pending - Get tasks available for claiming
 * - POST /tasks/:vtid/claim - Claim a task atomically
 * - POST /tasks/:vtid/release - Release a task claim
 * - POST /tasks/:vtid/progress - Report progress on a task
 * - POST /heartbeat - Worker heartbeat
 * - GET /stats - Get connector statistics
 * - POST /cleanup - Expire stale claims (admin)
 */

import { Router, Request, Response } from 'express';
import {
  registerWorker,
  unregisterWorker,
  getWorker,
  listWorkers,
  getPendingTasks,
  getTaskSpec,
  claimTask,
  releaseTask,
  reportProgress,
  heartbeat,
  expireStaleClaims,
  getWorkerStats,
} from '../services/worker-connector-service';

const router = Router();

// =============================================================================
// Worker Registration
// =============================================================================

/**
 * POST /register
 * Register a worker agent
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { worker_id, capabilities, max_concurrent, metadata } = req.body;

    if (!worker_id) {
      return res.status(400).json({
        ok: false,
        error: 'worker_id is required',
      });
    }

    const result = await registerWorker({
      worker_id,
      capabilities,
      max_concurrent,
      metadata,
    });

    return res.status(result.ok ? 200 : 400).json({
      ...result,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Registration error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * DELETE /register/:worker_id
 * Unregister a worker agent
 */
router.delete('/register/:worker_id', async (req: Request, res: Response) => {
  try {
    const { worker_id } = req.params;

    const result = await unregisterWorker(worker_id);

    return res.status(result.ok ? 200 : 400).json({
      ...result,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Unregistration error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /workers
 * List active workers
 */
router.get('/workers', async (_req: Request, res: Response) => {
  try {
    const result = await listWorkers();

    return res.status(200).json({
      ...result,
      vtid: 'VTID-01183',
      count: result.workers?.length || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] List workers error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /workers/:worker_id
 * Get worker info
 */
router.get('/workers/:worker_id', async (req: Request, res: Response) => {
  try {
    const { worker_id } = req.params;

    const result = await getWorker(worker_id);

    return res.status(result.ok ? 200 : 404).json({
      ...result,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Get worker error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// Task Polling & Claiming
// =============================================================================

/**
 * GET /tasks/pending
 * Get tasks available for workers to claim
 */
router.get('/tasks/pending', async (_req: Request, res: Response) => {
  try {
    const result = await getPendingTasks();

    return res.status(200).json({
      ...result,
      vtid: 'VTID-01183',
      count: result.tasks?.length || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Get pending tasks error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /tasks/:vtid/spec
 * Get spec for a task
 */
router.get('/tasks/:vtid/spec', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;

    const result = await getTaskSpec(vtid);

    return res.status(result.ok ? 200 : 404).json({
      ...result,
      vtid,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Get spec error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /tasks/:vtid/claim
 * Claim a task atomically
 */
router.post('/tasks/:vtid/claim', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { worker_id, expires_minutes } = req.body;

    if (!worker_id) {
      return res.status(400).json({
        ok: false,
        error: 'worker_id is required',
      });
    }

    const result = await claimTask(vtid, worker_id, expires_minutes || 60);

    return res.status(result.claimed ? 200 : 409).json({
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Claim error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /tasks/:vtid/release
 * Release a task claim
 */
router.post('/tasks/:vtid/release', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { worker_id, reason } = req.body;

    if (!worker_id) {
      return res.status(400).json({
        ok: false,
        error: 'worker_id is required',
      });
    }

    const result = await releaseTask(vtid, worker_id, reason || 'completed');

    return res.status(result.ok ? 200 : 400).json({
      ...result,
      vtid,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Release error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// Progress Reporting
// =============================================================================

/**
 * POST /tasks/:vtid/progress
 * Report progress on a task
 */
router.post('/tasks/:vtid/progress', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const { worker_id, event, message, metadata } = req.body;

    if (!worker_id) {
      return res.status(400).json({
        ok: false,
        error: 'worker_id is required',
      });
    }

    if (!event) {
      return res.status(400).json({
        ok: false,
        error: 'event is required',
      });
    }

    const result = await reportProgress(vtid, worker_id, {
      event,
      message,
      metadata,
    });

    return res.status(result.ok ? 200 : 400).json({
      ...result,
      vtid,
      event,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Progress error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// Heartbeat
// =============================================================================

/**
 * POST /heartbeat
 * Worker heartbeat - keeps claim alive
 */
router.post('/heartbeat', async (req: Request, res: Response) => {
  try {
    const { worker_id, active_vtid } = req.body;

    if (!worker_id) {
      return res.status(400).json({
        ok: false,
        error: 'worker_id is required',
      });
    }

    const result = await heartbeat(worker_id, active_vtid);

    return res.status(result.ok ? 200 : 400).json({
      ...result,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Heartbeat error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// Admin & Stats
// =============================================================================

/**
 * GET /stats
 * Get worker connector statistics
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const result = await getWorkerStats();

    return res.status(200).json({
      ...result,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Stats error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /cleanup
 * Expire stale claims (admin endpoint)
 */
router.post('/cleanup', async (_req: Request, res: Response) => {
  try {
    const result = await expireStaleClaims();

    return res.status(200).json({
      ...result,
      vtid: 'VTID-01183',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[VTID-01183] Cleanup error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// Health Check
// =============================================================================

/**
 * GET /health
 * Worker connector health check
 */
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const stats = await getWorkerStats();

    return res.status(200).json({
      ok: true,
      service: 'worker-connector',
      vtid: 'VTID-01183',
      status: 'healthy',
      stats: stats.stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      service: 'worker-connector',
      vtid: 'VTID-01183',
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
