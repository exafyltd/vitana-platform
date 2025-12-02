/**
 * Deploy Orchestrator Service - VTID-0525
 *
 * Shared deploy orchestrator that provides a single implementation for:
 * - Operator Chat deploy commands
 * - Publish modal deploy requests
 *
 * This service wraps the existing CICD infrastructure (VTID-0516) and provides
 * a unified interface for triggering deployments.
 */

import githubService from './github-service';
import cicdEvents from './oasis-event-service';
import { randomUUID } from 'crypto';

const DEFAULT_REPO = 'exafyltd/vitana-platform';

export interface DeployRequest {
  vtid: string;
  service: 'gateway' | 'oasis-operator' | 'oasis-projector';
  environment: 'dev';
  branch?: string;
  source: 'operator.console.chat' | 'publish.modal' | 'api';
}

export interface DeployResult {
  ok: boolean;
  vtid: string;
  service: string;
  environment: string;
  workflow_run_id?: number;
  workflow_url?: string;
  error?: string;
}

/**
 * Execute a deployment using the existing CICD infrastructure.
 * This is the single orchestrator that both Operator Chat and Publish modal use.
 */
export async function executeDeploy(request: DeployRequest): Promise<DeployResult> {
  const { vtid, service, environment, source } = request;

  console.log(`[Deploy Orchestrator] Starting deploy for ${service} to ${environment} (VTID: ${vtid}, source: ${source})`);

  try {
    // Step 1: Emit deploy requested event
    await cicdEvents.deployRequested(vtid, service, environment);

    // Step 2: Trigger the deploy workflow via GitHub Actions
    // This uses the same workflow as VTID-0516 (source deploy, no pre-built image)
    await githubService.triggerWorkflow(
      DEFAULT_REPO,
      'EXEC-DEPLOY.yml',
      'main',
      {
        vtid,
        service, // 'gateway', 'oasis-operator', or 'oasis-projector'
        health_path: '/alive',
        initiator: source === 'operator.console.chat' ? 'agent' : 'user',
      }
    );

    // Step 3: Get workflow run info
    const runs = await githubService.getWorkflowRuns(DEFAULT_REPO, 'EXEC-DEPLOY.yml');
    const latestRun = runs.workflow_runs[0];

    // Step 4: Emit deploy accepted event
    await cicdEvents.deployAccepted(vtid, service, environment, latestRun?.html_url);

    console.log(`[Deploy Orchestrator] Deploy workflow triggered for ${service} (${vtid})`);

    return {
      ok: true,
      vtid,
      service,
      environment,
      workflow_run_id: latestRun?.id,
      workflow_url: latestRun?.html_url,
    };

  } catch (error: any) {
    console.error(`[Deploy Orchestrator] Deploy failed for ${service}:`, error);

    // Emit deploy failed event
    await cicdEvents.deployFailed(vtid, service, error.message);

    return {
      ok: false,
      vtid,
      service,
      environment,
      error: error.message,
    };
  }
}

/**
 * Create a VTID using the existing VTID creation infrastructure.
 * Used when a command doesn't provide a VTID.
 *
 * VTID-0525-B: DISABLED - Direct vtid_ledger writes cause schema mismatch errors.
 * The real vtid_ledger table only has: vtid, layer, module, status, title, summary, created_at, updated_at
 * For MVP, we skip VTID auto-creation and use a placeholder.
 */
export async function createVtid(
  family: 'DEV' | 'ADM' | 'GOVRN' | 'OASIS',
  module: string,
  title: string
): Promise<{ ok: boolean; vtid?: string; error?: string }> {
  // VTID-0525-B: Skip VTID creation for MVP - use placeholder
  // Direct vtid_ledger writes were causing schema mismatch errors
  console.log(`[Deploy Orchestrator] VTID-0525-B: Skipping VTID creation, using placeholder`);

  // Generate a simple placeholder VTID for tracking purposes
  const timestamp = Date.now().toString(36).toUpperCase();
  const placeholder = `OASIS-CMD-${timestamp}`;

  console.log(`[Deploy Orchestrator] Using placeholder VTID: ${placeholder}`);
  return { ok: true, vtid: placeholder };
}

/**
 * Create a Command Hub task for non-deploy commands.
 *
 * VTID-0525-B: DISABLED - Direct vtid_ledger writes cause schema mismatch errors.
 * For MVP, we return a friendly message instead of creating tasks.
 */
export async function createTask(
  vtid: string,
  title: string,
  taskType: string,
  metadata: Record<string, unknown> = {}
): Promise<{ ok: boolean; task_id?: string; error?: string }> {
  // VTID-0525-B: Skip task creation for MVP
  // Direct vtid_ledger writes were causing schema mismatch errors
  console.log(`[Deploy Orchestrator] VTID-0525-B: Skipping task creation for MVP`);
  console.log(`[Deploy Orchestrator] Would create task: ${title} (type: ${taskType})`);

  // Return a placeholder task ID so the flow continues
  const timestamp = Date.now().toString(36).toUpperCase();
  const placeholderTaskId = `TASK-${timestamp}`;

  return {
    ok: true,
    task_id: placeholderTaskId,
  };
}

export default {
  executeDeploy,
  createVtid,
  createTask,
};
