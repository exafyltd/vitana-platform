import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const router = Router();

// Helper to emit events to OASIS
async function emitOasisEvent(event: {
  vtid: string;
  type: string;
  source: string;
  status: 'info' | 'warning' | 'error' | 'success';
  message: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseUrl = process.env.SUPABASE_URL;

  if (!svcKey || !supabaseUrl) {
    console.log(`[OASIS] Event (local only): ${event.type}`, event);
    return;
  }

  const eventId = randomUUID();
  const payload = {
    id: eventId,
    created_at: new Date().toISOString(),
    vtid: event.vtid,
    topic: event.type,
    service: event.source,
    role: 'API',
    model: 'cicd-gateway',
    status: event.status,
    message: event.message,
    link: null,
    metadata: event.payload || {},
  };

  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[OASIS] Insert failed: ${resp.status} - ${text}`);
    } else {
      console.log(`[OASIS] Event emitted: ${eventId} - ${event.vtid}/${event.type}`);
    }
  } catch (error) {
    console.error('[OASIS] Failed to emit event:', error);
  }
}

// Schema for safe-merge request
const SafeMergeSchema = z.object({
  vtid: z.string().min(1, 'vtid required'),
  repo: z.string().min(1, 'repo required'),
  pr_number: z.number().int().positive('pr_number must be positive'),
  require_checks: z.boolean().optional().default(true),
});

// Schema for deploy service request
const DeployServiceSchema = z.object({
  vtid: z.string().min(1, 'vtid required'),
  service: z.string().min(1, 'service name required'),
  environment: z.enum(['dev', 'staging', 'prod']).optional().default('dev'),
  trigger_source: z.string().optional().default('api'),
});

/**
 * GET /api/v1/cicd/health - CICD health check endpoint
 */
router.get('/api/v1/cicd/health', async (_req: Request, res: Response) => {
  const timestamp = new Date().toISOString();

  await emitOasisEvent({
    vtid: 'VTID-0515',
    type: 'cicd.health.check',
    source: 'gateway-cicd',
    status: 'info',
    message: 'CICD health check performed',
    payload: { timestamp },
  });

  res.status(200).json({
    status: 'ok',
    service: 'cicd-gateway',
    timestamp,
    endpoints: {
      health: '/api/v1/cicd/health',
      safeMerge: '/api/v1/github/safe-merge',
      deployService: '/api/v1/deploy/service',
    },
  });
});

/**
 * POST /api/v1/github/safe-merge - Governance-validated PR merge
 */
router.post('/api/v1/github/safe-merge', async (req: Request, res: Response) => {
  try {
    const validation = SafeMergeSchema.safeParse(req.body);

    if (!validation.success) {
      console.error('[CICD] safe-merge validation error:', validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
      });
    }

    const { vtid, repo, pr_number, require_checks } = validation.data;

    await emitOasisEvent({
      vtid,
      type: 'cicd.github.safe_merge.requested',
      source: 'gateway-cicd',
      status: 'info',
      message: `Safe merge requested for PR #${pr_number} in ${repo}`,
      payload: { repo, pr_number, require_checks },
    });

    // Governance check - verify PR meets requirements
    const governanceResult = await performGovernanceCheck(vtid, repo, pr_number, require_checks);

    if (!governanceResult.passed) {
      await emitOasisEvent({
        vtid,
        type: 'cicd.github.safe_merge.blocked',
        source: 'gateway-cicd',
        status: 'warning',
        message: `Safe merge blocked: ${governanceResult.reason}`,
        payload: { repo, pr_number, reason: governanceResult.reason },
      });

      return res.status(403).json({
        ok: false,
        error: 'Governance check failed',
        reason: governanceResult.reason,
        vtid,
        pr_number,
        repo,
      });
    }

    await emitOasisEvent({
      vtid,
      type: 'cicd.github.safe_merge.approved',
      source: 'gateway-cicd',
      status: 'success',
      message: `Safe merge approved for PR #${pr_number}`,
      payload: { repo, pr_number },
    });

    return res.status(200).json({
      ok: true,
      message: 'Safe merge approved',
      vtid,
      pr_number,
      repo,
      governance: governanceResult,
    });
  } catch (error: unknown) {
    console.error('[CICD] safe-merge error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/deploy/service - GitHub Actions auto-deploy trigger
 */
router.post('/api/v1/deploy/service', async (req: Request, res: Response) => {
  try {
    const validation = DeployServiceSchema.safeParse(req.body);

    if (!validation.success) {
      console.error('[CICD] deploy/service validation error:', validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: validation.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
      });
    }

    const { vtid, service, environment, trigger_source } = validation.data;

    await emitOasisEvent({
      vtid,
      type: 'cicd.deploy.service.requested',
      source: 'gateway-cicd',
      status: 'info',
      message: `Deploy requested for ${service} to ${environment}`,
      payload: { service, environment, trigger_source },
    });

    // Governance check for deployment
    const deploymentAllowed = await checkDeploymentGovernance(vtid, service, environment);

    if (!deploymentAllowed.allowed) {
      await emitOasisEvent({
        vtid,
        type: 'cicd.deploy.service.blocked',
        source: 'gateway-cicd',
        status: 'warning',
        message: `Deployment blocked: ${deploymentAllowed.reason}`,
        payload: { service, environment, reason: deploymentAllowed.reason },
      });

      return res.status(403).json({
        ok: false,
        error: 'Deployment not allowed',
        reason: deploymentAllowed.reason,
        vtid,
        service,
        environment,
      });
    }

    await emitOasisEvent({
      vtid,
      type: 'cicd.deploy.service.accepted',
      source: 'gateway-cicd',
      status: 'success',
      message: `Deployment accepted for ${service} to ${environment}`,
      payload: { service, environment, trigger_source },
    });

    return res.status(200).json({
      ok: true,
      message: 'Deployment request accepted',
      vtid,
      service,
      environment,
      trigger_source,
      status: 'queued',
    });
  } catch (error: unknown) {
    console.error('[CICD] deploy/service error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Helper function for governance check on PR merge
async function performGovernanceCheck(
  vtid: string,
  repo: string,
  prNumber: number,
  requireChecks: boolean
): Promise<{ passed: boolean; reason?: string }> {
  // Basic validation - in production this would call GitHub API
  if (!vtid.startsWith('VTID-')) {
    return { passed: false, reason: 'Invalid VTID format' };
  }

  if (!repo.includes('/')) {
    return { passed: false, reason: 'Invalid repo format (expected owner/repo)' };
  }

  // Simulate governance check
  // In production, this would:
  // 1. Verify PR exists in GitHub
  // 2. Check all required status checks passed
  // 3. Verify branch protection rules are met
  // 4. Check for required approvals

  console.log(`[CICD] Governance check for ${repo}#${prNumber} (vtid=${vtid}, requireChecks=${requireChecks})`);

  return { passed: true };
}

// Helper function for deployment governance
async function checkDeploymentGovernance(
  vtid: string,
  service: string,
  environment: string
): Promise<{ allowed: boolean; reason?: string }> {
  // Basic validation
  if (!vtid.startsWith('VTID-')) {
    return { allowed: false, reason: 'Invalid VTID format' };
  }

  // List of known services
  const knownServices = ['gateway', 'oasis-projector', 'mcp-gateway', 'deploy-watcher'];

  if (!knownServices.includes(service)) {
    return { allowed: false, reason: `Unknown service: ${service}. Known services: ${knownServices.join(', ')}` };
  }

  // Prod deployments require additional checks (placeholder)
  if (environment === 'prod') {
    console.log(`[CICD] Production deployment requested for ${service} - additional checks required`);
  }

  console.log(`[CICD] Deployment governance check passed for ${service} to ${environment}`);

  return { allowed: true };
}

export default router;
