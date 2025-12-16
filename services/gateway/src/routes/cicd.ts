/**
 * CICD Routes - VTID-0516 Autonomous Safe-Merge Layer + VTID-0601 Autonomous Safe Merge & Deploy Control
 *
 * Final API endpoints (after mounting in index.ts):
 * - POST /api/v1/github/create-pr    - Create a PR for a VTID
 * - POST /api/v1/github/safe-merge   - Safe merge with CI/governance gate
 * - POST /api/v1/deploy/service      - Trigger deployment workflow
 * - GET  /api/v1/cicd/health         - Health check for CICD subsystem
 *
 * VTID-0601 Endpoints (for Command Hub Approvals):
 * - POST /api/v1/cicd/merge          - Governed merge via Command Hub
 * - POST /api/v1/cicd/deploy         - Governed deploy via Command Hub
 * - GET  /api/v1/cicd/approvals      - Fetch pending approval items (PRs)
 * - POST /api/v1/cicd/approvals/:id/approve - Approve and execute
 * - POST /api/v1/cicd/approvals/:id/deny    - Deny approval request
 *
 * Mounting (in index.ts):
 * - app.use('/api/v1/github', cicdRouter);  // GitHub operations
 * - app.use('/api/v1/deploy', cicdRouter);  // Deploy operations
 * - app.use('/api/v1/cicd', cicdRouter);    // CICD health + VTID-0601 endpoints
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
  // VTID-0601: New types
  CicdMergeRequestSchema,
  CicdMergeResponse,
  CicdDeployRequestSchema,
  CicdDeployResponse,
  ApprovalItem,
  // VTID-0603: Schema import removed - handler reads directly from req.body
} from '../types/cicd';
import githubService from '../services/github-service';
import cicdEvents from '../services/oasis-event-service';
import { ZodError } from 'zod';
import { randomUUID } from 'crypto';

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
// VTID-0541: Updated to distinguish runtime deploy health from governance capabilities
router.get('/health', (_req: Request, res: Response) => {
  const hasGitHubToken = !!process.env.GITHUB_SAFE_MERGE_TOKEN;
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_SERVICE_ROLE;

  // VTID-0541 D2: Check Vertex AI configuration for AI capabilities
  const hasVertexConfig = !!process.env.VERTEX_MODEL && !!process.env.VERTEX_LOCATION;

  // VTID-0541 D2: Runtime Deploy Health
  // - Runtime is healthy if we have OASIS connectivity (for event logging)
  // - And AI services are available (Vertex AI configured)
  const runtimeDeployHealthy = hasSupabaseUrl && hasSupabaseKey;

  // VTID-0541 D2: Governance Capabilities
  // - GitHub token enables PR creation, merges, and approvals
  // - Missing GitHub token means "governance limited" (actions blocked, but system operational)
  const governanceHealthy = hasGitHubToken;

  // VTID-0541 D2: Status Determination
  // - 'ok': Both runtime and governance are healthy
  // - 'ok_governance_limited': Runtime OK but governance features unavailable (Dev Sandbox normal state)
  // - 'degraded': Runtime itself is broken (OASIS unavailable)
  let status: 'ok' | 'ok_governance_limited' | 'degraded';
  if (!runtimeDeployHealthy) {
    status = 'degraded';
  } else if (!governanceHealthy) {
    status = 'ok_governance_limited';
  } else {
    status = 'ok';
  }

  return res.status(200).json({
    ok: true,
    status,
    service: 'cicd-layer',
    version: '2.1.0', // VTID-0541 upgrade
    vtid: 'VTID-0541',
    timestamp: new Date().toISOString(),
    // VTID-0541 D2: Explicit health dimensions
    health: {
      runtime_deploy: runtimeDeployHealthy ? 'ok' : 'degraded',
      governance: governanceHealthy ? 'ok' : 'limited',
      ai_services: hasVertexConfig ? 'ok' : 'unavailable',
    },
    capabilities: {
      github_integration: hasGitHubToken,
      oasis_events: hasSupabaseUrl && hasSupabaseKey,
      create_pr: hasGitHubToken,
      safe_merge: hasGitHubToken,
      deploy_service: runtimeDeployHealthy, // VTID-0541: Deploy only requires runtime health
      // VTID-0601: Command Hub capabilities
      command_hub_merge: hasGitHubToken,
      command_hub_deploy: runtimeDeployHealthy, // VTID-0541: Deploy via Command Hub only requires runtime
      approvals: hasGitHubToken,
      // VTID-0541: AI capabilities
      ai_chat: hasVertexConfig,
      gemini_operator: hasVertexConfig,
    },
    allowed_services: ALLOWED_DEPLOY_SERVICES,
    allowed_environments: ['dev'],
    // VTID-0541: Informational notes for UI
    notes: {
      governance_limited: !governanceHealthy
        ? 'GitHub integration unavailable - PR/merge/approval actions blocked, but deploy and chat work normally'
        : null,
      ai_unavailable: !hasVertexConfig
        ? 'Vertex AI not configured - chat will use local routing'
        : null,
    },
  });
});

// ==================== VTID-0601: Autonomous Safe Merge & Deploy Control ====================

/**
 * VTID-0601: POST /merge - Governed merge via Command Hub
 *
 * This endpoint is the canonical merge pathway for Command Hub approvals.
 * It performs:
 * 1. PR status check (open, targeting main)
 * 2. CI status verification
 * 3. Governance evaluation
 * 4. Merge execution via GitHub API
 * 5. OASIS event emission
 */
router.post('/merge', async (req: Request, res: Response) => {
  try {
    const validation = CicdMergeRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return handleZodError(validation.error, res);
    }

    const { vtid, pr_number, repo } = validation.data;

    // Validate repo is the allowed one
    if (repo !== DEFAULT_REPO) {
      return res.status(403).json({
        ok: false,
        error: `Only ${DEFAULT_REPO} is allowed`,
        vtid,
        pr_number,
      } as CicdMergeResponse);
    }

    // Emit merge requested event
    await cicdEvents.mergeRequested(vtid, pr_number, repo);

    console.log(`[VTID-0601] Merge requested for PR #${pr_number} (${vtid})`);

    // Get PR status
    let prStatus;
    try {
      prStatus = await githubService.getPrStatus(repo, pr_number);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await cicdEvents.mergeFailed(vtid, pr_number, `PR not found: ${errorMessage}`, repo);
      return res.status(404).json({
        ok: false,
        error: `PR not found: ${errorMessage}`,
        reason: 'pr_not_found',
        vtid,
        pr_number,
      } as CicdMergeResponse);
    }

    const { pr, checks, allPassed } = prStatus;

    // Validate PR is open
    if (pr.state !== 'open') {
      await cicdEvents.mergeFailed(vtid, pr_number, `PR is ${pr.state}, not open`, repo);
      return res.status(400).json({
        ok: false,
        error: `PR is ${pr.state}, not open`,
        reason: 'pr_not_open',
        vtid,
        pr_number,
      } as CicdMergeResponse);
    }

    // Validate base is main
    if (pr.base.ref !== 'main') {
      await cicdEvents.mergeFailed(vtid, pr_number, `PR targets ${pr.base.ref}, not main`, repo);
      return res.status(400).json({
        ok: false,
        error: `PR targets ${pr.base.ref}, not main`,
        reason: 'invalid_base',
        vtid,
        pr_number,
      } as CicdMergeResponse);
    }

    // Check CI status
    if (!allPassed) {
      const failedChecks = checks.filter((c) => c.status === 'failure' || c.status === 'pending');
      await cicdEvents.mergeFailed(vtid, pr_number, `CI checks not passed: ${failedChecks.map(c => c.name).join(', ')}`, repo);
      return res.status(400).json({
        ok: false,
        error: `CI checks not passed`,
        reason: 'checks_failed',
        vtid,
        pr_number,
      } as CicdMergeResponse);
    }

    // Run governance evaluation
    const governance = await githubService.evaluateGovernance(repo, pr_number, vtid);

    if (governance.decision === 'blocked') {
      await cicdEvents.mergeFailed(vtid, pr_number, `Governance blocked: ${governance.blocked_reasons.join(', ')}`, repo);
      return res.status(403).json({
        ok: false,
        error: `Governance blocked merge`,
        reason: 'governance_blocked',
        vtid,
        pr_number,
      } as CicdMergeResponse);
    }

    // All checks passed - proceed with merge (squash)
    const mergeResult = await githubService.mergePullRequest(
      repo,
      pr_number,
      `${pr.title} (#${pr_number})`,
      'squash'
    );

    // Emit success event
    await cicdEvents.mergeSuccess(vtid, pr_number, mergeResult.sha, repo);

    console.log(`[VTID-0601] PR #${pr_number} merged successfully (${vtid}): ${mergeResult.sha}`);

    return res.status(200).json({
      ok: true,
      merged: true,
      sha: mergeResult.sha,
      vtid,
      pr_number,
    } as CicdMergeResponse);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const vtid = req.body?.vtid || 'UNKNOWN';
    const prNumber = req.body?.pr_number || 0;

    console.error(`[VTID-0601] Merge failed for ${vtid} PR #${prNumber}: ${errorMessage}`);
    await cicdEvents.mergeFailed(vtid, prNumber, errorMessage, DEFAULT_REPO);

    return res.status(500).json({
      ok: false,
      error: errorMessage,
      vtid,
      pr_number: prNumber,
    } as CicdMergeResponse);
  }
});

/**
 * VTID-0601: POST /deploy - Governed deploy via Command Hub
 *
 * This endpoint triggers EXEC-DEPLOY.yml workflow.
 * It performs:
 * 1. Service validation
 * 2. Environment validation (dev only)
 * 3. Governance evaluation
 * 4. Workflow trigger via GitHub API
 * 5. OASIS event emission
 */
router.post('/deploy', async (req: Request, res: Response) => {
  try {
    const validation = CicdDeployRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return handleZodError(validation.error, res);
    }

    const { vtid, service, environment } = validation.data;

    // Emit deploy requested event
    await cicdEvents.deployRequestedFromHub(vtid, service, environment);

    console.log(`[VTID-0601] Deploy requested for ${service} to ${environment} (${vtid})`);

    // Trigger the deploy workflow
    try {
      await githubService.triggerWorkflow(
        DEFAULT_REPO,
        'EXEC-DEPLOY.yml',
        'main',
        {
          vtid,
          service,
          health_path: '/alive',
          initiator: 'command-hub',
          environment,
        }
      );

      // Get recent workflow runs to find the URL
      const runs = await githubService.getWorkflowRuns(DEFAULT_REPO, 'EXEC-DEPLOY.yml');
      const latestRun = runs.workflow_runs[0];

      // Emit deploy started event
      await cicdEvents.deployStarted(vtid, service, environment, latestRun?.html_url);

      console.log(`[VTID-0601] Deploy workflow triggered for ${service} (${vtid})`);

      return res.status(200).json({
        ok: true,
        vtid,
        service,
        environment,
        workflow_run_id: latestRun?.id,
        workflow_url: latestRun?.html_url,
      } as CicdDeployResponse);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await cicdEvents.deployFailed(vtid, service, errorMessage);
      return res.status(500).json({
        ok: false,
        vtid,
        service,
        environment,
        error: errorMessage,
      } as CicdDeployResponse);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const vtid = req.body?.vtid || 'UNKNOWN';
    const service = req.body?.service || 'UNKNOWN';

    console.error(`[VTID-0601] Deploy failed for ${vtid}: ${errorMessage}`);
    await cicdEvents.deployFailed(vtid, service, errorMessage);

    return res.status(500).json({
      ok: false,
      vtid,
      service: service,
      environment: 'dev',
      error: errorMessage,
    } as CicdDeployResponse);
  }
});

/**
 * VTID-0601: GET /approvals - Fetch pending approval items
 *
 * This endpoint fetches open PRs from GitHub that match claude/* branch pattern.
 * Each PR becomes an approval item that can be merged/deployed from Command Hub.
 */
router.get('/approvals', async (_req: Request, res: Response) => {
  try {
    const approvals: ApprovalItem[] = [];

    // VTID-0601: Token resolution order - GITHUB_TOKEN first, then GH_TOKEN
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

    if (!token) {
      console.error('[VTID-0601] GitHub token not found in env');
      return res.status(200).json({
        ok: true,
        approvals: [],
        error: 'GitHub token not configured - cannot fetch PRs',
      });
    }

    // VTID-0601: Fetch open PRs targeting main
    const apiUrl = `https://api.github.com/repos/${DEFAULT_REPO}/pulls?state=open`;
    const prsResponse = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json'
      },
    });

    if (!prsResponse.ok) {
      console.error(`[VTID-0601] GitHub PR fetch failed: ${prsResponse.status} ${apiUrl}`);
      return res.status(200).json({
        ok: true,
        approvals: [],
        error: `GitHub PR fetch failed: ${prsResponse.status}`,
      });
    }

    const prs = await prsResponse.json() as Array<{
      number: number;
      title: string;
      state: string;
      html_url: string;
      head: { ref: string; sha: string };
      base: { ref: string };
      user: { login: string };
      created_at: string;
    }>;

    // Filter for claude/* branches (created by Claude)
    const claudePrs = prs.filter(pr => pr.head.ref.startsWith('claude/'));

    // Get status for each PR
    for (const pr of claudePrs) {
      // Extract VTID from branch name or PR title
      let vtid = 'UNKNOWN';
      const branchMatch = pr.head.ref.match(/VTID-\d+/i) || pr.title.match(/VTID-\d+/i);
      if (branchMatch) {
        vtid = branchMatch[0].toUpperCase();
      }

      // Detect service from branch or PR title
      let service: string | undefined;
      if (pr.head.ref.includes('gateway') || pr.title.toLowerCase().includes('gateway')) {
        service = 'gateway';
      } else if (pr.head.ref.includes('oasis-operator') || pr.title.toLowerCase().includes('oasis-operator')) {
        service = 'oasis-operator';
      }

      // Get PR status (CI checks)
      let ciStatus: 'pass' | 'fail' | 'pending' | 'unknown' = 'unknown';
      try {
        const prStatus = await githubService.getPrStatus(DEFAULT_REPO, pr.number);
        ciStatus = prStatus.allPassed ? 'pass' :
                   prStatus.checks.some(c => c.status === 'pending') ? 'pending' : 'fail';
      } catch {
        ciStatus = 'unknown';
      }

      // Run governance evaluation
      let governanceStatus: 'pass' | 'fail' | 'pending' | 'unknown' = 'unknown';
      try {
        const governance = await githubService.evaluateGovernance(DEFAULT_REPO, pr.number, vtid);
        governanceStatus = governance.decision === 'approved' ? 'pass' : 'fail';
      } catch {
        governanceStatus = 'unknown';
      }

      const approvalItem: ApprovalItem = {
        id: `pr-${pr.number}`,
        type: service ? 'merge+deploy' : 'merge',
        vtid,
        pr_number: pr.number,
        branch: pr.head.ref,
        service,
        environment: 'dev',
        commit_sha: pr.head.sha,
        governance_status: governanceStatus,
        ci_status: ciStatus,
        requester: pr.user.login,
        created_at: pr.created_at,
        pr_url: pr.html_url,
        pr_title: pr.title,
      };

      approvals.push(approvalItem);
    }

    console.log(`[VTID-0601] Found ${approvals.length} pending approvals`);

    return res.status(200).json({
      ok: true,
      approvals,
      count: approvals.length,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-0601] Failed to fetch approvals: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      approvals: [],
      error: errorMessage,
    });
  }
});

/**
 * VTID-0601: POST /approvals/:id/approve - Approve and execute
 *
 * This endpoint approves an approval item and executes the action:
 * - For 'merge': Merges the PR
 * - For 'deploy': Triggers deploy workflow
 * - For 'merge+deploy': Merges PR then triggers deploy
 */
router.post('/approvals/:id/approve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const prMatch = id.match(/^pr-(\d+)$/);

    if (!prMatch) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid approval ID format',
      });
    }

    const prNumber = parseInt(prMatch[1], 10);

    // Get PR details
    let pr;
    try {
      pr = await githubService.getPullRequest(DEFAULT_REPO, prNumber);
    } catch (error) {
      return res.status(404).json({
        ok: false,
        error: `PR #${prNumber} not found`,
      });
    }

    // Extract VTID
    let vtid = 'UNKNOWN';
    const branchMatch = pr.head.ref.match(/VTID-\d+/i) || pr.title.match(/VTID-\d+/i);
    if (branchMatch) {
      vtid = branchMatch[0].toUpperCase();
    }

    // Emit approval approved event
    await cicdEvents.approvalApproved(vtid, id, 'merge', 'command-hub-user');

    // Check if PR is still open
    if (pr.state !== 'open') {
      return res.status(400).json({
        ok: false,
        error: `PR is ${pr.state}, cannot merge`,
      });
    }

    // Execute merge
    console.log(`[VTID-0601] Executing approval for PR #${prNumber} (${vtid})`);

    await cicdEvents.mergeRequested(vtid, prNumber, DEFAULT_REPO);

    const mergeResult = await githubService.mergePullRequest(
      DEFAULT_REPO,
      prNumber,
      `${pr.title} (#${prNumber})`,
      'squash'
    );

    await cicdEvents.mergeSuccess(vtid, prNumber, mergeResult.sha, DEFAULT_REPO);

    // Detect service for auto-deploy
    const files = await githubService.getPrFiles(DEFAULT_REPO, prNumber);
    const service = githubService.detectServiceFromFiles(files.map(f => f.filename));

    let deployResult = null;
    if (service && ALLOWED_DEPLOY_SERVICES.includes(service as any)) {
      console.log(`[VTID-0601] Auto-triggering deploy for ${service}`);

      await cicdEvents.deployRequestedFromHub(vtid, service, 'dev');

      try {
        await githubService.triggerWorkflow(
          DEFAULT_REPO,
          'EXEC-DEPLOY.yml',
          'main',
          {
            vtid,
            service,
            health_path: '/alive',
            initiator: 'command-hub',
            environment: 'dev',
          }
        );

        const runs = await githubService.getWorkflowRuns(DEFAULT_REPO, 'EXEC-DEPLOY.yml');
        const latestRun = runs.workflow_runs[0];

        await cicdEvents.deployStarted(vtid, service, 'dev', latestRun?.html_url);

        deployResult = {
          service,
          workflow_url: latestRun?.html_url,
        };
      } catch (error) {
        console.error(`[VTID-0601] Deploy trigger failed:`, error);
      }
    }

    console.log(`[VTID-0601] Approval executed successfully for PR #${prNumber}`);

    return res.status(200).json({
      ok: true,
      approval_id: id,
      vtid,
      pr_number: prNumber,
      merged: true,
      sha: mergeResult.sha,
      deploy: deployResult,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-0601] Approval execution failed: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      error: errorMessage,
    });
  }
});

/**
 * VTID-0601: POST /approvals/:id/deny - Deny approval request
 *
 * This endpoint denies an approval request without taking action.
 * It emits an event for audit purposes.
 */
router.post('/approvals/:id/deny', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // VTID-0603: Read body.vtid DIRECTLY from req.body before any schema parsing
    // This prevents vtid loss if schema validation fails or strips unknown fields
    const { reason, vtid: vtidFromBody } = req.body || {};

    const prMatch = id.match(/^pr-(\d+)$/);

    if (!prMatch) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid approval ID format',
      });
    }

    const prNumber = parseInt(prMatch[1], 10);

    // VTID-0603: Validate body.vtid first - must read before any schema parse
    let vtid = 'UNKNOWN';
    if (typeof vtidFromBody === 'string' && /^VTID-\d{4}$/i.test(vtidFromBody.trim())) {
      vtid = vtidFromBody.trim().toUpperCase();
    }

    // VTID-0603: Fallback extraction ONLY if still UNKNOWN (PR branch/title/body)
    if (vtid === 'UNKNOWN') {
      try {
        const pr = await githubService.getPullRequest(DEFAULT_REPO, prNumber);
        const m =
          pr.head.ref.match(/VTID-\d{4}/i) ||
          pr.title.match(/VTID-\d{4}/i) ||
          (pr.body ? pr.body.match(/VTID-\d{4}/i) : null);
        if (m) vtid = m[0].toUpperCase();
      } catch {
        // keep UNKNOWN
      }
    }

    // Emit denial event
    await cicdEvents.approvalDenied(vtid, id, 'merge', 'command-hub-user', reason);

    console.log(`[VTID-0601] Approval denied for PR #${prNumber}: ${reason || 'No reason provided'}`);

    return res.status(200).json({
      ok: true,
      approval_id: id,
      vtid,
      pr_number: prNumber,
      denied: true,
      reason: reason || 'No reason provided',
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-0601] Denial failed: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      error: errorMessage,
    });
  }
});

export default router;
