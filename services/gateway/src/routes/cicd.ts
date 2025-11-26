/**
 * CI/CD Routes - Safe Merge + Auto-Deploy Bridge
 * VTID: VTID-0512
 * Layer: DEV | System: DevConsole | Module: CICDL
 *
 * This module provides the API endpoints for:
 * - POST /api/v1/github/safe-merge - Merge a PR after governance checks
 * - POST /api/v1/deploy/service - Trigger CI/CD deployment of a service
 *
 * All operations are:
 * - Logged to OASIS
 * - Bound to a VTID
 * - Safe-guarded by CI checks
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { githubService } from '../services/github-service';
import { oasisEventService } from '../services/oasis-event-service';

const router = Router();

// Allowed services for deployment
const ALLOWED_SERVICES = [
  'gateway',
  'oasis',
  'mcp-gateway',
  'oasis-projector',
  'oasis-operator',
  'deploy-watcher',
  'validators',
] as const;

// Allowed environments
const ALLOWED_ENVIRONMENTS = ['dev'] as const; // prod will be added later with stricter rules

// Validation schemas
const SafeMergeRequestSchema = z.object({
  vtid: z.string().min(1, 'vtid is required'),
  repo: z.literal('exafyltd/vitana-platform', {
    errorMap: () => ({ message: 'repo must be exafyltd/vitana-platform' }),
  }),
  pr_number: z.number().int().positive('pr_number must be a positive integer'),
  require_checks: z.boolean().default(true),
});

const DeployServiceRequestSchema = z.object({
  vtid: z.string().min(1, 'vtid is required'),
  service: z.enum(ALLOWED_SERVICES, {
    errorMap: () => ({
      message: `service must be one of: ${ALLOWED_SERVICES.join(', ')}`,
    }),
  }),
  environment: z.enum(ALLOWED_ENVIRONMENTS, {
    errorMap: () => ({
      message: `environment must be one of: ${ALLOWED_ENVIRONMENTS.join(', ')}`,
    }),
  }),
});

/**
 * POST /api/v1/github/safe-merge
 *
 * Merge a specific PR to `main` after governance checks.
 *
 * Request body:
 * {
 *   "vtid": "VTID-0512",
 *   "repo": "exafyltd/vitana-platform",
 *   "pr_number": 123,
 *   "require_checks": true
 * }
 *
 * Response:
 * {
 *   "ok": true,
 *   "merged": true,
 *   "pr_number": 123,
 *   "commit_sha": "abc123...",
 *   "message": "Safe merge executed"
 * }
 */
router.post('/github/safe-merge', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    // Validate request body
    const validation = SafeMergeRequestSchema.safeParse(req.body);
    if (!validation.success) {
      const errors = validation.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
      console.error('[SafeMerge] Validation error:', errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: errors,
      });
    }

    const { vtid, repo, pr_number, require_checks } = validation.data;

    console.log(`[SafeMerge] Request: PR #${pr_number} (vtid=${vtid}, require_checks=${require_checks})`);

    // Emit OASIS event for request
    await oasisEventService.emitSafeMergeRequest(vtid, pr_number, repo);

    // Validate repository
    const repoValidation = githubService.validateRepo(repo);
    if (!repoValidation.valid) {
      await oasisEventService.emitSafeMergeDenied(vtid, pr_number, repo, repoValidation.error!);
      return res.status(400).json({
        ok: false,
        error: repoValidation.error,
      });
    }

    // Fetch PR information
    let pr;
    try {
      pr = await githubService.getPullRequest(repo, pr_number);
    } catch (error: any) {
      const reason = `Failed to fetch PR: ${error.message}`;
      await oasisEventService.emitSafeMergeDenied(vtid, pr_number, repo, reason);
      return res.status(404).json({
        ok: false,
        error: reason,
      });
    }

    // Verify PR is targeting main branch
    if (pr.base.ref !== 'main') {
      const reason = `PR base branch is '${pr.base.ref}', not 'main'`;
      await oasisEventService.emitSafeMergeDenied(vtid, pr_number, repo, reason);
      return res.status(400).json({
        ok: false,
        error: reason,
      });
    }

    // Verify PR is open and not already merged
    if (pr.state !== 'open') {
      const reason = pr.merged ? 'PR is already merged' : 'PR is closed';
      await oasisEventService.emitSafeMergeDenied(vtid, pr_number, repo, reason);
      return res.status(409).json({
        ok: false,
        error: reason,
        pr_state: pr.state,
        pr_merged: pr.merged,
      });
    }

    // Verify mergeable state
    if (pr.mergeable === false) {
      const reason = `PR is not mergeable (state: ${pr.mergeable_state})`;
      await oasisEventService.emitSafeMergeDenied(vtid, pr_number, repo, reason);
      return res.status(409).json({
        ok: false,
        error: reason,
        mergeable_state: pr.mergeable_state,
      });
    }

    // Verify CI checks if required
    if (require_checks) {
      const checkResult = await githubService.verifyChecks(repo, pr.head.sha);
      if (!checkResult.passed) {
        await oasisEventService.emitSafeMergeDenied(vtid, pr_number, repo, checkResult.details);
        return res.status(409).json({
          ok: false,
          error: 'CI checks not passed',
          details: checkResult.details,
        });
      }
    }

    // Perform the merge
    const mergeResult = await githubService.mergePullRequest(repo, pr_number, 'squash');

    if (!mergeResult.merged) {
      await oasisEventService.emitSafeMergeDenied(vtid, pr_number, repo, mergeResult.message);
      return res.status(500).json({
        ok: false,
        error: mergeResult.message,
      });
    }

    // Emit success event
    await oasisEventService.emitSafeMergeExecuted(vtid, pr_number, repo, mergeResult.sha!);

    const elapsed = Date.now() - startTime;
    console.log(`[SafeMerge] Success: PR #${pr_number} merged (sha=${mergeResult.sha}, ${elapsed}ms)`);

    return res.status(200).json({
      ok: true,
      merged: true,
      pr_number,
      commit_sha: mergeResult.sha,
      message: 'Safe merge executed',
      elapsed_ms: elapsed,
    });
  } catch (error: any) {
    console.error('[SafeMerge] Error:', error);

    // Try to emit error event
    try {
      const body = req.body || {};
      await oasisEventService.emit({
        vtid: body.vtid || 'UNKNOWN',
        topic: 'SAFE_MERGE_ERROR',
        service: 'cicd',
        status: 'error',
        message: `Safe merge error: ${error.message}`,
        metadata: { error: error.message, pr_number: body.pr_number },
      });
    } catch {}

    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      details: error.message,
    });
  }
});

/**
 * POST /api/v1/deploy/service
 *
 * Trigger CI/CD deployment of a specific service using the existing deploy workflow.
 *
 * Request body:
 * {
 *   "vtid": "VTID-0512",
 *   "service": "gateway",
 *   "environment": "dev"
 * }
 *
 * Response:
 * {
 *   "ok": true,
 *   "service": "gateway",
 *   "environment": "dev",
 *   "message": "Deploy workflow triggered"
 * }
 */
router.post('/deploy/service', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    // Validate request body
    const validation = DeployServiceRequestSchema.safeParse(req.body);
    if (!validation.success) {
      const errors = validation.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
      console.error('[DeployService] Validation error:', errors);
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: errors,
      });
    }

    const { vtid, service, environment } = validation.data;

    console.log(`[DeployService] Request: ${service} to ${environment} (vtid=${vtid})`);

    // Emit OASIS event for request
    await oasisEventService.emitDeployRequest(vtid, service, environment);

    // Trigger the deployment workflow
    const workflowId = 'deploy-service.yml';
    const workflowResult = await githubService.triggerWorkflowDispatch(
      'exafyltd/vitana-platform',
      workflowId,
      'main',
      {
        vtid,
        service,
        environment,
      }
    );

    if (!workflowResult.ok) {
      await oasisEventService.emitDeployFailed(vtid, service, environment, workflowResult.message);
      return res.status(500).json({
        ok: false,
        service,
        environment,
        error: workflowResult.message,
      });
    }

    const elapsed = Date.now() - startTime;
    console.log(`[DeployService] Workflow triggered: ${service} to ${environment} (${elapsed}ms)`);

    // Note: DEPLOY_SUCCEEDED will be emitted via webhook when workflow completes

    return res.status(200).json({
      ok: true,
      service,
      environment,
      message: 'Deploy workflow triggered',
      workflow: workflowId,
      elapsed_ms: elapsed,
    });
  } catch (error: any) {
    console.error('[DeployService] Error:', error);

    // Try to emit error event
    try {
      const body = req.body || {};
      await oasisEventService.emitDeployFailed(
        body.vtid || 'UNKNOWN',
        body.service || 'unknown',
        body.environment || 'unknown',
        error.message
      );
    } catch {}

    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      details: error.message,
    });
  }
});

/**
 * GET /api/v1/cicd/health
 *
 * Health check endpoint for CI/CD routes
 */
router.get('/cicd/health', (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: 'cicd-bridge',
    version: '1.0.0',
    vtid: 'VTID-0512',
    timestamp: new Date().toISOString(),
    endpoints: [
      { method: 'POST', path: '/api/v1/github/safe-merge' },
      { method: 'POST', path: '/api/v1/deploy/service' },
    ],
    allowed_services: ALLOWED_SERVICES,
    allowed_environments: ALLOWED_ENVIRONMENTS,
  });
});

export default router;
