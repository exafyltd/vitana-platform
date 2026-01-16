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
 * VTID-01168 Approval Auto-Deploy:
 * - POST /api/v1/cicd/autonomous-pr-merge - Approve → Safe Merge → Auto-Deploy
 *   Payload: { vtid, pr_number, merge_method, automerge }
 *   - VTID is REQUIRED (blocks approval if missing)
 *   - Merge commit format: VTID-####: <PR title>
 *   - State transitions: MERGED → DEPLOYING tracked via OASIS
 *
 * Autonomous PR+Merge (Claude Worker):
 * - POST /api/v1/github/autonomous-pr-merge - Create PR + Wait for CI + Merge (with VTID-01033 concurrency control)
 *   Payload: { vtid, repo, head_branch, base_branch, title, body, merge_method, automerge, ... }
 *
 * VTID-01033 Concurrency Control Endpoints:
 * - GET  /api/v1/cicd/lock-status    - Get current lock status and configuration
 * - POST /api/v1/cicd/lock-release   - Force release locks for a VTID (admin)
 *
 * Mounting (in index.ts):
 * - app.use('/api/v1/github', cicdRouter);  // GitHub operations
 * - app.use('/api/v1/deploy', cicdRouter);  // Deploy operations
 * - app.use('/api/v1/cicd', cicdRouter);    // CICD health + VTID-0601 endpoints + VTID-01033 lock endpoints + VTID-01168 approval auto-deploy
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
  // Autonomous PR+Merge for Claude Worker integration
  AutonomousPrMergeRequestSchema,
  AutonomousPrMergeResponse,
  // VTID-01032: Multi-service deploy targeting
  DeploySelectionResult,
  DeployTargetReason,
  // VTID-01033: Concurrency control types
  ConcurrencyBlockedResponse,
  // VTID-01168: Approval Auto-Deploy
  ApprovalAutoPrMergeRequestSchema,
  ApprovalAutoPrMergeResponse,
} from '../types/cicd';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import githubService from '../services/github-service';
import cicdEvents from '../services/oasis-event-service';
import cicdLockManager from '../services/cicd-lock-manager';
import { ZodError } from 'zod';
import { randomUUID } from 'crypto';
import { validateForMerge, hasValidatorPass } from '../services/autopilot-validator';

const router = Router();
const DEFAULT_REPO = 'exafyltd/vitana-platform';

// ==================== VTID-01032: Service Path Mapping ====================

interface ServicePathMapping {
  paths: string[];
  cloud_run_service: string | null;
  deployable: boolean;
}

interface ServicePathMap {
  version: string;
  mappings: Record<string, ServicePathMapping>;
  shared: { paths: string[]; description: string };
  infrastructure: { paths: string[]; description: string };
}

/**
 * Load service path map from config file
 * Falls back to inline defaults if file doesn't exist
 */
function loadServicePathMap(): ServicePathMap {
  const configPath = join(__dirname, '../../../../config/service-path-map.json');

  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8');
      return JSON.parse(content) as ServicePathMap;
    }
  } catch (error) {
    console.warn('[VTID-01032] Failed to load service-path-map.json, using defaults:', error);
  }

  // Inline fallback if config file is unavailable
  return {
    version: '1.0.0',
    mappings: {
      'gateway': { paths: ['services/gateway/'], cloud_run_service: 'gateway', deployable: true },
      'oasis-operator': { paths: ['services/oasis-operator/'], cloud_run_service: 'oasis-operator', deployable: true },
      'oasis-projector': { paths: ['services/oasis-projector/'], cloud_run_service: 'oasis-projector', deployable: true },
    },
    shared: { paths: ['packages/', 'libs/', 'config/'], description: 'Shared paths' },
    infrastructure: { paths: ['.github/workflows/', 'scripts/'], description: 'Infrastructure paths' },
  };
}

/**
 * VTID-01032: Detect services from changed files using path mapping
 * Returns the detection result with reason code
 */
function detectServicesFromFiles(
  files: string[],
  explicitServices?: string[]
): { services: string[]; reason: DeployTargetReason } {
  // If explicit services provided, use them
  if (explicitServices && explicitServices.length > 0) {
    return {
      services: [...explicitServices].sort(),
      reason: 'deploy_target_explicit',
    };
  }

  const pathMap = loadServicePathMap();
  const detectedServices = new Set<string>();
  let hasSharedOnly = false;
  let hasServiceChanges = false;

  for (const file of files) {
    let matchedService = false;

    // Check service mappings
    for (const [serviceName, mapping] of Object.entries(pathMap.mappings)) {
      if (mapping.deployable) {
        for (const pathPrefix of mapping.paths) {
          if (file.startsWith(pathPrefix)) {
            detectedServices.add(serviceName);
            matchedService = true;
            hasServiceChanges = true;
            break;
          }
        }
      }
      if (matchedService) break;
    }

    // Check shared paths
    if (!matchedService) {
      for (const sharedPath of pathMap.shared.paths) {
        if (file.startsWith(sharedPath)) {
          hasSharedOnly = true;
          break;
        }
      }
    }
  }

  const services = Array.from(detectedServices).sort();

  // Determine reason based on detection results
  if (services.length === 0) {
    if (hasSharedOnly && !hasServiceChanges) {
      return { services: [], reason: 'deploy_target_ambiguous_shared_only' };
    }
    return { services: [], reason: 'no_deploy_target' };
  }

  if (services.length === 1) {
    return { services, reason: 'deploy_target_detected_single' };
  }

  return { services, reason: 'deploy_target_detected_multi' };
}

/**
 * VTID-01032: Validate explicit services against known deployable services
 */
function validateExplicitServices(services: string[]): { valid: boolean; invalid: string[] } {
  const pathMap = loadServicePathMap();
  const invalid: string[] = [];

  for (const service of services) {
    const mapping = pathMap.mappings[service];
    if (!mapping || !mapping.deployable) {
      invalid.push(service);
    }
  }

  return { valid: invalid.length === 0, invalid };
}

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

    // VTID-01180: Validator Hard Gate - MUST pass before merge
    // Run full validation (code review + governance + security scan)
    console.log(`[VTID-01180] Running validator hard gate for ${vtid} PR #${pr_number}`);
    const validationResult = await validateForMerge({
      vtid,
      pr_number,
      repo,
      files_changed: governance.files_touched,
    });

    if (!validationResult.passed) {
      const issues = validationResult.result?.issues || [];
      const errorIssues = issues.filter(i => i.severity === 'error');
      const errorMessage = errorIssues.length > 0
        ? `Validator blocked: ${errorIssues.map(i => i.message).join('; ')}`
        : validationResult.error || 'Validator blocked merge';

      await cicdEvents.mergeFailed(vtid, pr_number, errorMessage, repo);
      console.log(`[VTID-01180] Validator BLOCKED merge for ${vtid}: ${errorMessage}`);

      return res.status(403).json({
        ok: false,
        error: errorMessage,
        reason: 'validator_blocked',
        vtid,
        pr_number,
        validation_issues: issues,
      } as CicdMergeResponse);
    }

    console.log(`[VTID-01180] Validator PASSED for ${vtid} - proceeding with merge`);

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
 * VTID-0604: POST /approvals/:id/deny - Deny approval request
 *
 * This endpoint denies an approval request without taking action.
 * It emits an event for audit purposes.
 *
 * VTID-0604: body.vtid is the ONLY authoritative VTID source.
 * NO fallback extraction from PR branch/title/body.
 * If body.vtid is missing or invalid, use UNKNOWN.
 */
router.post('/approvals/:id/deny', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // VTID-0604: Read vtid and reason DIRECTLY from req.body
    const { vtid: rawVtid, reason } = req.body || {};

    const prMatch = id.match(/^pr-(\d+)$/);

    if (!prMatch) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid approval ID format',
      });
    }

    const prNumber = parseInt(prMatch[1], 10);

    // VTID-0604 + VTID-01007: Validate body.vtid strictly - NO fallback extraction
    // Updated to accept 4-5 digit VTIDs (canonical format is VTID-##### from VTID-01000+)
    let vtid = 'UNKNOWN';
    if (typeof rawVtid === 'string' && /^VTID-\d{4,5}$/.test(rawVtid.trim())) {
      vtid = rawVtid.trim().toUpperCase();
    }

    // NO OTHER VTID LOGIC ALLOWED - body.vtid is the only source

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

// ==================== Autonomous PR+Merge (Claude Worker + VTID-01168 Approval) ====================

/**
 * POST /autonomous-pr-merge - Unified PR Merge Handler
 *
 * This endpoint handles TWO use cases:
 *
 * 1. VTID-01168: Approval Auto-Deploy (Command Hub)
 *    - Payload: { vtid, pr_number, merge_method, automerge }
 *    - Called by Command Hub Approve button
 *    - VTID is REQUIRED - blocks approval if missing
 *    - Merge commit format: VTID-####: <PR title>
 *    - State transitions: MERGED → DEPLOYING tracked via OASIS
 *
 * 2. VTID-01031: Claude Worker PR Creation + Merge
 *    - Payload: { vtid, repo, head_branch, base_branch, title, body, merge_method, automerge, ... }
 *    - Called by Claude workers that cannot access GitHub API directly
 *    - Creates PR from branch, waits for CI, merges
 *
 * Route differentiation:
 * - If payload has 'pr_number' (no 'head_branch'): VTID-01168 approval path
 * - If payload has 'head_branch': Legacy Claude Worker path
 */
router.post('/autonomous-pr-merge', async (req: Request, res: Response) => {
  const requestId = randomUUID();

  // ==================== VTID-01168: Approval Auto-Deploy Path ====================
  // If request has 'pr_number' and no 'head_branch', use approval path
  if (req.body?.pr_number && !req.body?.head_branch) {
    console.log(`[VTID-01168] Approval auto-deploy request ${requestId} started`);

    try {
      // Step 1: Validate request payload (VTID is REQUIRED)
      const validation = ApprovalAutoPrMergeRequestSchema.safeParse(req.body);
      if (!validation.success) {
        const details = validation.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
        console.error(`[VTID-01168] Validation failed: ${details}`);

        // Check if VTID is the issue
        const vtidError = validation.error.errors.find(e => e.path.includes('vtid'));
        if (vtidError) {
          return res.status(400).json({
            ok: false,
            vtid: req.body?.vtid || 'UNKNOWN',
            pr_number: req.body?.pr_number || 0,
            state: 'FAILED',
            merged: false,
            error: `VTID validation failed: ${vtidError.message}`,
            reason: 'vtid_missing',
          } as ApprovalAutoPrMergeResponse);
        }

        return res.status(400).json({
          ok: false,
          vtid: req.body?.vtid || 'UNKNOWN',
          pr_number: req.body?.pr_number || 0,
          state: 'FAILED',
          merged: false,
          error: `Invalid request payload: ${details}`,
          reason: 'vtid_missing',
        } as ApprovalAutoPrMergeResponse);
      }

      const { vtid, pr_number, merge_method, automerge } = validation.data;

      console.log(`[VTID-01168] ${vtid}: Processing approval for PR #${pr_number} (merge_method: ${merge_method}, automerge: ${automerge})`);

      // Step 2: Get PR details from GitHub
      let pr;
      try {
        pr = await githubService.getPullRequest(DEFAULT_REPO, pr_number);
      } catch (error) {
        console.error(`[VTID-01168] ${vtid}: PR #${pr_number} not found`);
        return res.status(404).json({
          ok: false,
          vtid,
          pr_number,
          state: 'FAILED',
          merged: false,
          error: `PR #${pr_number} not found`,
          reason: 'pr_not_found',
        } as ApprovalAutoPrMergeResponse);
      }

      // Step 3: Verify PR is still open
      if (pr.state !== 'open') {
        console.error(`[VTID-01168] ${vtid}: PR #${pr_number} is ${pr.state}, cannot merge`);
        return res.status(400).json({
          ok: false,
          vtid,
          pr_number,
          pr_url: pr.html_url,
          state: 'FAILED',
          merged: false,
          error: `PR is ${pr.state}, cannot merge`,
          reason: 'pr_not_open',
        } as ApprovalAutoPrMergeResponse);
      }

      // Step 4: Check CI status
      try {
        const prStatus = await githubService.getPrStatus(DEFAULT_REPO, pr_number);
        if (!prStatus.allPassed) {
          const pendingOrFailed = prStatus.checks.filter(c => c.status !== 'success');
          console.error(`[VTID-01168] ${vtid}: CI not passed for PR #${pr_number}`);
          return res.status(400).json({
            ok: false,
            vtid,
            pr_number,
            pr_url: pr.html_url,
            state: 'FAILED',
            merged: false,
            error: `CI checks not passed: ${pendingOrFailed.map(c => `${c.name}(${c.status})`).join(', ')}`,
            reason: 'ci_not_passed',
          } as ApprovalAutoPrMergeResponse);
        }
      } catch (error) {
        // If we can't check CI status, continue (CI might be optional)
        console.warn(`[VTID-01168] ${vtid}: Could not check CI status, continuing...`);
      }

      // Step 5: Emit approval approved event
      await cicdEvents.approvalApproved(vtid, `pr-${pr_number}`, 'merge', 'command-hub-user');

      // Step 6: Emit merge requested event
      await cicdEvents.mergeRequested(vtid, pr_number, DEFAULT_REPO);

      // Step 7: Execute merge with proper commit message format: VTID-####: <PR title>
      // Strip any existing VTID prefix from title to avoid duplication
      const vtidPattern = /^VTID-\d{4,5}:\s*/i;
      const prTitleClean = pr.title.replace(vtidPattern, '').trim();
      const mergeCommitMessage = `${vtid}: ${prTitleClean}`;

      console.log(`[VTID-01168] ${vtid}: Merging PR #${pr_number} with message: "${mergeCommitMessage}"`);

      let mergeResult;
      try {
        mergeResult = await githubService.mergePullRequest(
          DEFAULT_REPO,
          pr_number,
          mergeCommitMessage,
          merge_method
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[VTID-01168] ${vtid}: Merge failed - ${errorMessage}`);
        await cicdEvents.mergeFailed(vtid, pr_number, errorMessage, DEFAULT_REPO);
        return res.status(500).json({
          ok: false,
          vtid,
          pr_number,
          pr_url: pr.html_url,
          state: 'FAILED',
          merged: false,
          error: `Merge failed: ${errorMessage}`,
          reason: 'merge_failed',
        } as ApprovalAutoPrMergeResponse);
      }

      // Step 8: Emit MERGED state event
      console.log(`[VTID-01168] ${vtid}: PR #${pr_number} merged successfully (sha: ${mergeResult.sha})`);
      await cicdEvents.mergeSuccess(vtid, pr_number, mergeResult.sha, DEFAULT_REPO);

      // Step 9: Detect service and trigger auto-deploy (if automerge=true)
      let deployResult = null;
      let finalState: 'MERGED' | 'DEPLOYING' = 'MERGED';

      if (automerge) {
        const files = await githubService.getPrFiles(DEFAULT_REPO, pr_number);
        const service = githubService.detectServiceFromFiles(files.map(f => f.filename));

        if (service && ALLOWED_DEPLOY_SERVICES.includes(service as any)) {
          console.log(`[VTID-01168] ${vtid}: Auto-deploying service ${service}`);

          // Emit DEPLOYING state event
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
              environment: 'dev',
              workflow_url: latestRun?.html_url,
            };

            finalState = 'DEPLOYING';
            console.log(`[VTID-01168] ${vtid}: Deploy triggered for ${service} - ${latestRun?.html_url}`);
          } catch (error) {
            console.error(`[VTID-01168] ${vtid}: Deploy trigger failed:`, error);
            // Don't fail the response - merge succeeded, deploy failed
          }
        } else {
          console.log(`[VTID-01168] ${vtid}: No deployable service detected, skipping deploy`);
        }
      }

      // Step 10: Return success response
      console.log(`[VTID-01168] ${vtid}: Approval completed - state: ${finalState}`);

      return res.status(200).json({
        ok: true,
        vtid,
        pr_number,
        pr_url: pr.html_url,
        state: finalState,
        merged: true,
        merge_sha: mergeResult.sha,
        merge_commit_message: mergeCommitMessage,
        deploy: deployResult,
        reason: deployResult ? 'deploy_triggered' : 'merge_only',
      } as ApprovalAutoPrMergeResponse);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[VTID-01168] Request ${requestId} failed: ${errorMessage}`);
      return res.status(500).json({
        ok: false,
        vtid: req.body?.vtid || 'UNKNOWN',
        pr_number: req.body?.pr_number || 0,
        state: 'FAILED',
        merged: false,
        error: errorMessage,
      } as ApprovalAutoPrMergeResponse);
    }
  }

  // ==================== VTID-01031: Claude Worker PR Creation Path ====================
  console.log(`[AUTONOMOUS-PR-MERGE] Request ${requestId} started`);

  try {
    const validation = AutonomousPrMergeRequestSchema.safeParse(req.body);
    if (!validation.success) {
      const details = validation.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      return res.status(400).json({
        ok: false,
        vtid: req.body?.vtid || 'UNKNOWN',
        error: `Invalid request payload: ${details}`,
        reason: 'validation_failed',
        details: { validation_errors: validation.error.errors },
      } as AutonomousPrMergeResponse);
    }

    const {
      vtid,
      repo,
      head_branch,
      base_branch,
      title,
      body,
      merge_method,
      automerge,
      max_ci_wait_seconds,
      deploy: deployConfig,  // VTID-01032: Deploy targeting configuration
    } = validation.data;

    // Validate repo is the allowed one
    if (repo !== DEFAULT_REPO) {
      console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: Rejected - unauthorized repo ${repo}`);
      return res.status(403).json({
        ok: false,
        vtid,
        error: `Only ${DEFAULT_REPO} is allowed`,
        reason: 'validation_failed',
        details: { repo, allowed_repo: DEFAULT_REPO },
      } as AutonomousPrMergeResponse);
    }

    // Validate base branch
    if (base_branch !== 'main') {
      console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: Rejected - base must be main, got ${base_branch}`);
      return res.status(400).json({
        ok: false,
        vtid,
        error: 'PRs must target main branch',
        reason: 'validation_failed',
        details: { base_branch, required_base: 'main' },
      } as AutonomousPrMergeResponse);
    }

    // Validate head branch is not main
    if (head_branch === 'main' || head_branch === 'master') {
      console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: Rejected - cannot create PR from main/master`);
      return res.status(400).json({
        ok: false,
        vtid,
        error: 'Cannot create PR from main/master branch',
        reason: 'validation_failed',
        details: { head_branch },
      } as AutonomousPrMergeResponse);
    }

    // Normalize title to always include VTID prefix (required for auto-deploy)
    // Strip any existing VTID prefix to avoid duplication, then prepend
    const vtidPattern = /^VTID-\d{4,5}:\s*/i;
    const titleWithoutVtid = title.replace(vtidPattern, '').trim();
    const normalizedTitle = `${vtid}: ${titleWithoutVtid}`;

    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Processing PR request for ${head_branch} -> ${base_branch}`);

    // VTID-01031 Step 1: Validate branch exists on remote
    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Checking if branch ${head_branch} exists...`);
    try {
      const branchFound = await githubService.branchExists(repo, head_branch);
      if (!branchFound) {
        console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: Branch ${head_branch} not found on remote`);
        return res.status(400).json({
          ok: false,
          vtid,
          error: `Branch '${head_branch}' does not exist on remote`,
          reason: 'branch_not_found',
          details: { head_branch, repo },
        } as AutonomousPrMergeResponse);
      }
      console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Branch ${head_branch} exists`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: GitHub API error checking branch - ${errorMessage}`);
      return res.status(500).json({
        ok: false,
        vtid,
        error: `GitHub API error: ${errorMessage}`,
        reason: 'github_api_error',
        details: { operation: 'branch_check', error: errorMessage },
      } as AutonomousPrMergeResponse);
    }

    // VTID-01031 Step 2: Find existing PR for head_branch (idempotency)
    let pr: { number: number; html_url: string };
    let prReused = false;

    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Searching for existing PR...`);
    await cicdEvents.findPrRequested(vtid, head_branch, base_branch);

    try {
      const existingPr = await githubService.findPrForBranch(repo, head_branch, base_branch);

      if (existingPr) {
        // VTID-01031: Reuse existing PR (idempotent path)
        pr = { number: existingPr.number, html_url: existingPr.html_url };
        prReused = true;
        console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Found existing PR #${pr.number} - reusing`);
        await cicdEvents.findPrSucceeded(vtid, pr.number, pr.html_url, head_branch);
        await cicdEvents.createPrSkippedExisting(vtid, pr.number, pr.html_url, head_branch);
      } else {
        // VTID-01031 Step 3: Create PR (no existing PR found)
        console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: No existing PR found, creating new one...`);
        console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Normalized title: "${normalizedTitle}"`);
        await cicdEvents.createPrRequested(vtid, head_branch, base_branch);
        pr = await githubService.createPullRequest(repo, normalizedTitle, body, head_branch, base_branch);
        await cicdEvents.createPrSucceeded(vtid, pr.number, pr.html_url);
        console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: PR #${pr.number} created - ${pr.html_url}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: GitHub API error - ${errorMessage}`);
      await cicdEvents.createPrFailed(vtid, errorMessage);
      return res.status(500).json({
        ok: false,
        vtid,
        error: `GitHub API error: ${errorMessage}`,
        reason: 'github_api_error',
        details: { operation: 'find_or_create_pr', error: errorMessage },
      } as AutonomousPrMergeResponse);
    }

    // VTID-01031 Step 4: If automerge is false, return now with PR info
    if (!automerge) {
      console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: automerge=false, returning PR info only`);
      return res.status(prReused ? 200 : 201).json({
        ok: true,
        vtid,
        pr_number: pr.number,
        pr_url: pr.html_url,
        merged: false,
        merge_sha: null,
        ci_status: 'pending',
        reason: prReused ? 'pr_reused_existing' : 'pr_created',
      } as AutonomousPrMergeResponse);
    }

    // VTID-01031 Step 5: Poll CI status (if automerge=true)
    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Waiting for CI (max ${max_ci_wait_seconds}s)`);
    const pollIntervalMs = 10000; // 10 seconds
    const maxPolls = Math.ceil(max_ci_wait_seconds / 10);
    let ciPassed = false;
    let lastChecks: any[] = [];

    for (let poll = 0; poll < maxPolls; poll++) {
      try {
        const prStatus = await githubService.getPrStatus(repo, pr.number);
        lastChecks = prStatus.checks;

        if (prStatus.allPassed) {
          ciPassed = true;
          console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: CI passed after ${poll * 10}s`);
          break;
        }

        // Check if any check failed (not just pending)
        const hasFailure = prStatus.checks.some(c => c.status === 'failure');
        if (hasFailure) {
          const failedChecks = prStatus.checks.filter(c => c.status === 'failure');
          console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: CI failed - ${failedChecks.map(c => c.name).join(', ')}`);
          return res.status(400).json({
            ok: false,
            vtid,
            pr_number: pr.number,
            pr_url: pr.html_url,
            merged: false,
            merge_sha: null,
            ci_status: 'failure',
            error: `CI checks failed: ${failedChecks.map(c => c.name).join(', ')}`,
            reason: 'ci_failed',
            details: { failed_checks: failedChecks },
          } as AutonomousPrMergeResponse);
        }

        // Wait before next poll
        if (poll < maxPolls - 1) {
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
      } catch (error) {
        console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: CI poll error - ${error}`);
        // Continue polling on transient errors
      }
    }

    if (!ciPassed) {
      console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: CI timeout after ${max_ci_wait_seconds}s`);
      return res.status(408).json({
        ok: false,
        vtid,
        pr_number: pr.number,
        pr_url: pr.html_url,
        merged: false,
        merge_sha: null,
        ci_status: 'timeout',
        error: `CI did not complete within ${max_ci_wait_seconds} seconds`,
        reason: 'ci_timeout',
        details: { pending_checks: lastChecks.filter(c => c.status === 'pending') },
      } as AutonomousPrMergeResponse);
    }

    // VTID-01033 Step 5.5: Acquire concurrency locks before merge
    // Get PR files for service and critical path detection
    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Acquiring concurrency locks`);
    let prFiles: Array<{ filename: string }>;
    try {
      prFiles = await githubService.getPrFiles(repo, pr.number);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: Failed to get PR files - ${errorMessage}`);
      return res.status(500).json({
        ok: false,
        vtid,
        pr_number: pr.number,
        pr_url: pr.html_url,
        merged: false,
        merge_sha: null,
        ci_status: 'success',
        error: `Failed to get PR files: ${errorMessage}`,
        reason: 'github_api_error',
        details: { operation: 'get_pr_files', error: errorMessage },
      } as AutonomousPrMergeResponse);
    }

    const changedPaths = prFiles.map(f => f.filename);
    const services = [...new Set(
      changedPaths
        .map(p => p.match(/^services\/([^/]+)/)?.[1])
        .filter((s): s is string => !!s)
    )];

    const lockResult = await cicdLockManager.acquireLocks({
      vtid,
      pr_number: pr.number,
      services,
      changed_paths: changedPaths,
    });

    if (!lockResult.ok) {
      console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Concurrency blocked by ${lockResult.blocked_by_vtid} on ${lockResult.blocked_by_key}`);
      return res.status(409).json({
        ok: false,
        vtid,
        reason: 'concurrency_blocked',
        error: lockResult.error || `Lock held for ${lockResult.blocked_by_key} by ${lockResult.blocked_by_vtid}`,
        details: {
          lock_key: lockResult.blocked_by_key || '',
          held_by: lockResult.blocked_by_vtid || '',
        },
      } as ConcurrencyBlockedResponse);
    }

    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Locks acquired: ${lockResult.acquired_keys?.join(', ') || 'none'}`);

    // Step 6: Governance evaluation
    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Running governance evaluation`);
    const governance = await githubService.evaluateGovernance(repo, pr.number, vtid);
    await cicdEvents.safeMergeEvaluated(
      vtid,
      pr.number,
      governance.decision,
      governance.files_touched,
      governance.services_impacted,
      governance.blocked_reasons
    );

    if (governance.decision === 'blocked') {
      console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: Governance blocked - ${governance.blocked_reasons.join(', ')}`);
      await cicdEvents.safeMergeBlocked(vtid, pr.number, 'governance_blocked', {
        blocked_reasons: governance.blocked_reasons,
      });
      // VTID-01033: Release locks on governance failure
      await cicdLockManager.releaseLocks(vtid, 'failure');
      return res.status(403).json({
        ok: false,
        vtid,
        pr_number: pr.number,
        pr_url: pr.html_url,
        merged: false,
        merge_sha: null,
        ci_status: 'success',
        error: `Governance blocked: ${governance.blocked_reasons.join(', ')}`,
        reason: 'governance_rejected',
        details: {
          files_touched: governance.files_touched,
          blocked_reasons: governance.blocked_reasons,
        },
      } as AutonomousPrMergeResponse);
    }

    // Step 7: Merge PR
    // CRITICAL: Merge commit title MUST contain VTID for auto-deploy to trigger
    const mergeCommitTitle = `${normalizedTitle} (#${pr.number})`;
    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Merging PR #${pr.number} (${merge_method})`);
    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Merge commit title: "${mergeCommitTitle}"`);

    let mergeResult: { sha: string };
    try {
      await cicdEvents.safeMergeApproved(vtid, pr.number);

      mergeResult = await githubService.mergePullRequest(
        repo,
        pr.number,
        mergeCommitTitle,
        merge_method
      );

      await cicdEvents.safeMergeExecuted(vtid, pr.number, mergeResult.sha);

      // VTID-01033: Release locks on successful merge
      await cicdLockManager.releaseLocks(vtid, 'success');

      console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: PR #${pr.number} merged successfully - SHA: ${mergeResult.sha}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: Merge failed - ${errorMessage}`);
      await cicdEvents.safeMergeBlocked(vtid, pr.number, 'merge_failed', { error: errorMessage });
      // VTID-01033: Release locks on merge failure
      await cicdLockManager.releaseLocks(vtid, 'failure');
      return res.status(500).json({
        ok: false,
        vtid,
        pr_number: pr.number,
        pr_url: pr.html_url,
        merged: false,
        merge_sha: null,
        ci_status: 'success',
        error: `Merge failed: ${errorMessage}`,
        reason: 'merge_failed',
        details: { error: errorMessage },
      } as AutonomousPrMergeResponse);
    }

    // ==================== VTID-01032: Deploy Targeting ====================
    // Step 5: Determine deploy targets (explicit or auto-detected)

    const changedFiles = governance.files_touched;
    const environment = deployConfig?.environment || 'dev';

    // Validate explicit services if provided
    if (deployConfig?.services && deployConfig.services.length > 0) {
      const validation = validateExplicitServices(deployConfig.services);
      if (!validation.valid) {
        console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: Invalid explicit services: ${validation.invalid.join(', ')}`);
        // Still return success for merge, but note the invalid services
        const deployResult: DeploySelectionResult = {
          services: [],
          environment,
          reason: 'no_deploy_target',
          changed_files_count: changedFiles.length,
          workflow_triggered: false,
        };

        await cicdEvents.deploySelection(
          vtid,
          [],
          environment,
          'no_deploy_target',
          changedFiles.length,
          pr.number,
          mergeResult.sha
        );

        return res.status(200).json({
          ok: true,
          vtid,
          pr_number: pr.number,
          pr_url: pr.html_url,
          merged: true,
          merge_sha: mergeResult.sha,
          ci_status: 'success',
          deploy: deployResult,
          details: { invalid_services: validation.invalid },
        } as AutonomousPrMergeResponse);
      }
    }

    // Detect services from changed files or use explicit services
    const detection = detectServicesFromFiles(changedFiles, deployConfig?.services);
    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Deploy detection - services: [${detection.services.join(', ')}], reason: ${detection.reason}`);

    // Handle shared-only case (ambiguous, requires explicit services)
    if (detection.reason === 'deploy_target_ambiguous_shared_only') {
      console.warn(`[AUTONOMOUS-PR-MERGE] ${vtid}: Shared-only changes require explicit deploy.services`);

      await cicdEvents.deploySelection(
        vtid,
        [],
        environment,
        detection.reason,
        changedFiles.length,
        pr.number,
        mergeResult.sha
      );

      return res.status(200).json({
        ok: false,
        vtid,
        pr_number: pr.number,
        pr_url: pr.html_url,
        merged: true,
        merge_sha: mergeResult.sha,
        ci_status: 'success',
        error: 'Changes only affect shared paths (packages/, libs/, config/). Please specify deploy.services explicitly.',
        reason: 'deploy_target_ambiguous',
        deploy: {
          services: [],
          environment,
          reason: detection.reason,
          changed_files_count: changedFiles.length,
          workflow_triggered: false,
        },
      } as AutonomousPrMergeResponse);
    }

    // Step 6: Trigger deploy workflows for selected services
    let workflowUrl: string | undefined;
    let workflowTriggered = false;

    if (detection.services.length > 0) {
      console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Triggering deploy for services: [${detection.services.join(', ')}]`);

      // Trigger workflow for each service (workflows handle multi-service via inputs)
      for (const service of detection.services) {
        try {
          await githubService.triggerWorkflow(
            DEFAULT_REPO,
            'EXEC-DEPLOY.yml',
            'main',
            {
              vtid,
              service,
              health_path: '/alive',
              initiator: 'autonomous-pr-merge',
              environment,
            }
          );

          // Get workflow URL for the first service
          if (!workflowUrl) {
            const runs = await githubService.getWorkflowRuns(DEFAULT_REPO, 'EXEC-DEPLOY.yml');
            workflowUrl = runs.workflow_runs[0]?.html_url;
          }

          workflowTriggered = true;
          console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Deploy workflow triggered for ${service}`);
        } catch (error) {
          console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: Failed to trigger deploy for ${service}:`, error);
          // Continue with other services
        }
      }
    }

    // Step 7: Emit deploy selection event
    await cicdEvents.deploySelection(
      vtid,
      detection.services,
      environment,
      detection.reason,
      changedFiles.length,
      pr.number,
      mergeResult.sha
    );

    // Step 8: Return success response with deploy info
    const deployResult: DeploySelectionResult = {
      services: detection.services,
      environment,
      reason: detection.reason,
      changed_files_count: changedFiles.length,
      workflow_triggered: workflowTriggered,
      workflow_url: workflowUrl,
    };

    console.log(`[AUTONOMOUS-PR-MERGE] ${vtid}: Complete - merged=${true}, deploy_services=[${detection.services.join(', ')}]`);

    return res.status(200).json({
      ok: true,
      vtid,
      pr_number: pr.number,
      pr_url: pr.html_url,
      merged: true,
      merge_sha: mergeResult.sha,
      ci_status: 'success',
      deploy: deployResult,
    } as AutonomousPrMergeResponse);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const vtid = req.body?.vtid || 'UNKNOWN';
    console.error(`[AUTONOMOUS-PR-MERGE] ${vtid}: Internal error - ${errorMessage}`);
    // VTID-01033: Ensure locks are released on unexpected errors
    if (vtid !== 'UNKNOWN') {
      await cicdLockManager.releaseLocks(vtid, 'failure');
    }
    return res.status(500).json({
      ok: false,
      vtid,
      error: `Internal error: ${errorMessage}`,
      reason: 'github_api_error',
      merge_sha: null,
      details: { error: errorMessage },
    } as AutonomousPrMergeResponse);
  }
});

// ==================== VTID-01033: Lock Status Diagnostic Endpoint ====================

/**
 * GET /lock-status - Get current lock status for debugging/monitoring
 *
 * This endpoint returns:
 * - Active merges count and VTIDs
 * - Current locks held
 * - Concurrency configuration
 */
router.get('/lock-status', (_req: Request, res: Response) => {
  try {
    const status = cicdLockManager.getLockStatus();
    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      vtid: 'VTID-01033',
      ...status,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01033] Lock status error: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      error: errorMessage,
    });
  }
});

/**
 * POST /lock-release - Force release locks for a VTID (admin use)
 *
 * Body: { vtid: string, reason?: string }
 */
router.post('/lock-release', async (req: Request, res: Response) => {
  try {
    const { vtid, reason } = req.body;

    if (!vtid || typeof vtid !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'vtid is required',
      });
    }

    const releasedKeys = await cicdLockManager.releaseLocks(vtid, 'explicit');
    console.log(`[VTID-01033] Admin force release for ${vtid}: ${releasedKeys.length} locks`);

    return res.status(200).json({
      ok: true,
      vtid,
      released_keys: releasedKeys,
      reason: reason || 'admin_release',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01033] Lock release error: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      error: errorMessage,
    });
  }
});

export default router;
