/**
 * CICD Routes - VTID-0516 Autonomous Safe-Merge Layer
 *
 * Final API endpoints (after mounting in index.ts):
 * - POST /api/v1/github/create-pr    - Create a PR for a VTID
 * - POST /api/v1/github/safe-merge   - Safe merge with CI/governance gate
 * - POST /api/v1/deploy/service      - Trigger deployment workflow
 * - GET  /api/v1/cicd/health         - Health check for CICD subsystem
 *
 * Mounting (in index.ts):
 * - app.use('/api/v1/github', cicdRouter);  // GitHub operations
 * - app.use('/api/v1/deploy', cicdRouter);  // Deploy operations
 * - app.use('/api/v1/cicd', cicdRouter);    // CICD health
 */

import { Router, Request, Response } from 'express';
import {
  CreatePrRequestSchema,
  SafeMergeRequestSchema,
  DeployServiceRequestSchema,
  ALLOWED_DEPLOY_SERVICES,
  CreatePrResponse,
  SafeMergeResponse,
  DeployServiceResponse,
} from '../types/cicd';
import githubService from '../services/github-service';
import cicdEvents from '../services/oasis-event-service';
import { ZodError } from 'zod';

const router = Router();
const DEFAULT_REPO = 'exafyltd/vitana-platform';

// ==================== Helper Functions ====================

function handleZodError(error: ZodError, res: Response) {
  const details = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
  return res.status(400).json({
    ok: false,
    error: 'Invalid request payload',
    details,
  });
}

// ==================== POST /create-pr ====================
// Mounted at /api/v1/github -> final path: /api/v1/github/create-pr
router.post('/create-pr', async (req: Request, res: Response) => {
  try {
    const validation = CreatePrRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return handleZodError(validation.error, res);
    }

    const { vtid, title, body, head, base } = validation.data;

    // Validation: base must be main
    if (base !== 'main') {
      await cicdEvents.createPrFailed(vtid, 'PRs must target main branch');
      return res.status(400).json({
        ok: false,
        error: 'PRs must target main branch',
        vtid,
      } as CreatePrResponse);
    }

    // Validation: head cannot be main
    if (head === 'main' || head === 'master') {
      await cicdEvents.createPrFailed(vtid, 'Cannot create PR from main/master branch');
      return res.status(400).json({
        ok: false,
        error: 'Cannot create PR from main/master branch',
        vtid,
      } as CreatePrResponse);
    }

    // Emit requested event
    await cicdEvents.createPrRequested(vtid, head, base);

    // Create the PR
    const pr = await githubService.createPullRequest(DEFAULT_REPO, title, body, head, base);

    // Emit success event
    await cicdEvents.createPrSucceeded(vtid, pr.number, pr.html_url);

    console.log(`[CICD] PR #${pr.number} created for ${vtid}: ${pr.html_url}`);

    return res.status(201).json({
      ok: true,
      pr_number: pr.number,
      pr_url: pr.html_url,
      vtid,
    } as CreatePrResponse);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const vtid = req.body?.vtid || 'UNKNOWN';

    console.error(`[CICD] Create PR failed for ${vtid}: ${errorMessage}`);
    await cicdEvents.createPrFailed(vtid, errorMessage);

    return res.status(500).json({
      ok: false,
      error: errorMessage,
      vtid,
    } as CreatePrResponse);
  }
});

// ==================== POST /safe-merge ====================
// Mounted at /api/v1/github -> final path: /api/v1/github/safe-merge
router.post('/safe-merge', async (req: Request, res: Response) => {
  try {
    const validation = SafeMergeRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return handleZodError(validation.error, res);
    }

    const { vtid, repo, pr_number, require_checks, merge_strategy } = validation.data;

    // Validate repo is the allowed one
    if (repo !== DEFAULT_REPO) {
      await cicdEvents.safeMergeBlocked(vtid, pr_number, 'unauthorized_repo', { repo });
      return res.status(403).json({
        ok: false,
        reason: 'unauthorized_repo',
        vtid,
        details: { message: `Only ${DEFAULT_REPO} is allowed` },
      } as SafeMergeResponse);
    }

    // Emit requested event
    await cicdEvents.safeMergeRequested(vtid, repo, pr_number);

    // Get PR status
    let prStatus;
    try {
      prStatus = await githubService.getPrStatus(repo, pr_number);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await cicdEvents.safeMergeBlocked(vtid, pr_number, 'pr_not_found', { error: errorMessage });
      return res.status(404).json({
        ok: false,
        reason: 'pr_not_found',
        vtid,
        details: { error: errorMessage },
      } as SafeMergeResponse);
    }

    const { pr, checks, allPassed } = prStatus;

    // Validate PR is open
    if (pr.state !== 'open') {
      await cicdEvents.safeMergeBlocked(vtid, pr_number, 'pr_not_open', { state: pr.state });
      return res.status(400).json({
        ok: false,
        reason: 'pr_not_open',
        vtid,
        details: { pr_state: pr.state },
      } as SafeMergeResponse);
    }

    // Validate base is main
    if (pr.base.ref !== 'main') {
      await cicdEvents.safeMergeBlocked(vtid, pr_number, 'invalid_base', { base: pr.base.ref });
      return res.status(400).json({
        ok: false,
        reason: 'invalid_base',
        vtid,
        details: { base: pr.base.ref, message: 'PRs must target main branch' },
      } as SafeMergeResponse);
    }

    // Check CI status if required
    if (require_checks && !allPassed) {
      const failedChecks = checks.filter((c) => c.status === 'failure' || c.status === 'pending');
      await cicdEvents.safeMergeBlocked(vtid, pr_number, 'checks_failed', {
        checks: failedChecks,
      });
      return res.status(400).json({
        ok: false,
        reason: 'checks_failed',
        vtid,
        details: {
          pr_state: pr.state,
          base: pr.base.ref,
          head: pr.head.ref,
          checks: failedChecks,
        },
      } as SafeMergeResponse);
    }

    // Run governance evaluation
    const governance = await githubService.evaluateGovernance(repo, pr_number, vtid);
    await cicdEvents.safeMergeEvaluated(
      vtid,
      pr_number,
      governance.decision,
      governance.files_touched,
      governance.services_impacted,
      governance.blocked_reasons
    );

    if (governance.decision === 'blocked') {
      await cicdEvents.safeMergeBlocked(vtid, pr_number, 'governance_blocked', {
        blocked_reasons: governance.blocked_reasons,
      });
      return res.status(403).json({
        ok: false,
        reason: 'governance_blocked',
        vtid,
        details: {
          pr_state: pr.state,
          base: pr.base.ref,
          head: pr.head.ref,
          checks,
          files_touched: governance.files_touched,
          services_impacted: governance.services_impacted,
          governance_decision: governance.decision,
          blocked_reasons: governance.blocked_reasons,
        },
      } as SafeMergeResponse);
    }

    // All checks passed and governance approved - proceed with merge
    await cicdEvents.safeMergeApproved(vtid, pr_number);

    const mergeResult = await githubService.mergePullRequest(
      repo,
      pr_number,
      `${pr.title} (#${pr_number})`,
      merge_strategy
    );

    await cicdEvents.safeMergeExecuted(vtid, pr_number, mergeResult.sha);

    console.log(`[CICD] PR #${pr_number} merged for ${vtid}: ${mergeResult.sha}`);

    // Detect service for auto-deploy hint
    const primaryService = githubService.detectServiceFromFiles(governance.files_touched);

    return res.status(200).json({
      ok: true,
      merged: true,
      branch: 'main',
      repo,
      vtid,
      details: {
        pr_state: 'merged',
        base: pr.base.ref,
        head: pr.head.ref,
        checks,
        files_touched: governance.files_touched,
        services_impacted: governance.services_impacted,
        governance_decision: 'approved',
      },
      next: primaryService
        ? {
            can_auto_deploy: true,
            service: primaryService,
            environment: 'dev',
          }
        : undefined,
    } as SafeMergeResponse);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const vtid = req.body?.vtid || 'UNKNOWN';
    const prNumber = req.body?.pr_number || 0;

    console.error(`[CICD] Safe merge failed for ${vtid} PR #${prNumber}: ${errorMessage}`);
    await cicdEvents.safeMergeBlocked(vtid, prNumber, 'internal_error', { error: errorMessage });

    return res.status(500).json({
      ok: false,
      reason: 'internal_error',
      vtid,
      details: { error: errorMessage },
    } as SafeMergeResponse);
  }
});

// ==================== POST /service ====================
// Mounted at /api/v1/deploy -> final path: /api/v1/deploy/service
router.post('/service', async (req: Request, res: Response) => {
  try {
    const validation = DeployServiceRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return handleZodError(validation.error, res);
    }

    const { vtid, service, environment, trigger_workflow } = validation.data;

    // Validate service is allowed
    if (!ALLOWED_DEPLOY_SERVICES.includes(service as any)) {
      await cicdEvents.deployBlocked(vtid, service, 'service_not_allowed');
      return res.status(403).json({
        ok: false,
        status: 'blocked',
        vtid,
        error: `Service '${service}' is not in the allowed list: ${ALLOWED_DEPLOY_SERVICES.join(', ')}`,
      } as DeployServiceResponse);
    }

    // Emit requested event
    await cicdEvents.deployRequested(vtid, service, environment);

    if (!trigger_workflow) {
      // Dry run - just validate
      await cicdEvents.deployAccepted(vtid, service, environment);
      return res.status(200).json({
        ok: true,
        status: 'queued',
        vtid,
        service,
        environment,
        details: { message: 'Dry run - workflow not triggered' },
      } as DeployServiceResponse);
    }

    // Trigger the deploy workflow
    try {
      await githubService.triggerWorkflow(
        DEFAULT_REPO,
        'EXEC-DEPLOY.yml',
        'main',
        {
          vtid,
          service: service === 'gateway' ? 'vitana-gateway' : service,
          image: `gcr.io/lovable-vitana-vers1/${service}:latest`,
          health_path: '/alive',
        }
      );

      // Get recent workflow runs to find the URL
      const runs = await githubService.getWorkflowRuns(DEFAULT_REPO, 'EXEC-DEPLOY.yml');
      const latestRun = runs.workflow_runs[0];

      await cicdEvents.deployAccepted(vtid, service, environment, latestRun?.html_url);

      console.log(`[CICD] Deploy workflow triggered for ${service} (${vtid})`);

      return res.status(200).json({
        ok: true,
        status: 'queued',
        vtid,
        service,
        environment,
        workflow_run_id: latestRun?.id,
        workflow_url: latestRun?.html_url,
      } as DeployServiceResponse);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await cicdEvents.deployFailed(vtid, service, errorMessage);
      return res.status(500).json({
        ok: false,
        status: 'failed',
        vtid,
        service,
        environment,
        error: errorMessage,
      } as DeployServiceResponse);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const vtid = req.body?.vtid || 'UNKNOWN';
    const service = req.body?.service || 'UNKNOWN';

    console.error(`[CICD] Deploy service failed for ${vtid}: ${errorMessage}`);
    await cicdEvents.deployFailed(vtid, service, errorMessage);

    return res.status(500).json({
      ok: false,
      status: 'failed',
      vtid,
      error: errorMessage,
    } as DeployServiceResponse);
  }
});

// ==================== GET /health ====================
// Mounted at /api/v1/cicd -> final path: /api/v1/cicd/health
router.get('/health', (_req: Request, res: Response) => {
  const hasGitHubToken = !!process.env.GITHUB_SAFE_MERGE_TOKEN;
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_SERVICE_ROLE;

  const status = hasGitHubToken && hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'cicd-layer',
    version: '1.0.0',
    vtid: 'VTID-0516',
    timestamp: new Date().toISOString(),
    capabilities: {
      github_integration: hasGitHubToken,
      oasis_events: hasSupabaseUrl && hasSupabaseKey,
      create_pr: hasGitHubToken,
      safe_merge: hasGitHubToken,
      deploy_service: hasGitHubToken,
    },
    allowed_services: ALLOWED_DEPLOY_SERVICES,
    allowed_environments: ['dev'],
  });
});

export default router;
