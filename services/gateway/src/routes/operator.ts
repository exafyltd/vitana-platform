/**
 * Operator Routes - VTID-0510 Software Version Tracking
 *
 * Final API endpoints (after mounting in index.ts):
 * - GET /api/v1/operator/deployments - Get deployment history feed
 *
 * Mounting (in index.ts):
 * - app.use('/api/v1/operator', operatorRouter);
 */

import { Router, Request, Response } from 'express';
import { getDeploymentHistory, getNextSWV, insertSoftwareVersion } from '../lib/versioning';

const router = Router();

// ==================== GET /deployments ====================
// Returns latest 20 deployment records formatted for UI
router.get('/deployments', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const result = await getDeploymentHistory(limit);

    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Database query failed',
        detail: result.error,
      });
    }

    // Format for UI feed
    const deployments = (result.deployments || []).map((d) => ({
      swv_id: d.swv_id,
      created_at: d.created_at,
      git_commit: d.git_commit,
      status: d.status,
      initiator: d.initiator,
      deploy_type: d.deploy_type,
      service: d.service,
      environment: d.environment,
    }));

    return res.status(200).json(deployments);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Operator] Error fetching deployments: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      detail: errorMessage,
    });
  }
});

// ==================== POST /deployments ====================
// Record a new deployment (internal use - called after successful deploy)
router.post('/deployments', async (req: Request, res: Response) => {
  try {
    const { service, git_commit, deploy_type, initiator, environment } = req.body;

    // Validate required fields
    if (!service || typeof service !== 'string') {
      return res.status(400).json({ ok: false, error: 'service is required' });
    }
    if (!git_commit || typeof git_commit !== 'string') {
      return res.status(400).json({ ok: false, error: 'git_commit is required' });
    }
    if (!deploy_type || !['normal', 'rollback'].includes(deploy_type)) {
      return res.status(400).json({ ok: false, error: 'deploy_type must be "normal" or "rollback"' });
    }
    if (!initiator || !['user', 'agent'].includes(initiator)) {
      return res.status(400).json({ ok: false, error: 'initiator must be "user" or "agent"' });
    }

    // Get next SWV ID
    const swv_id = await getNextSWV();

    // Insert the deployment record
    const result = await insertSoftwareVersion({
      swv_id,
      service,
      git_commit,
      deploy_type,
      initiator,
      status: 'success',
      environment: environment || 'dev-sandbox',
    });

    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Failed to record deployment',
        detail: result.error,
      });
    }

    console.log(`[Operator] Deployment recorded: ${swv_id} for ${service}`);

    return res.status(201).json({
      ok: true,
      swv_id: result.swv_id,
      service,
      git_commit,
      deploy_type,
      initiator,
      environment: environment || 'dev-sandbox',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Operator] Error recording deployment: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      detail: errorMessage,
    });
  }
});

// ==================== GET /deployments/health ====================
// Health check for deployments subsystem
router.get('/deployments/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_SERVICE_ROLE;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'operator-deployments',
    version: '1.0.0',
    vtid: 'VTID-0510',
    timestamp: new Date().toISOString(),
    capabilities: {
      database_connection: hasSupabaseUrl && hasSupabaseKey,
      version_tracking: true,
    },
  });
});

export default router;
