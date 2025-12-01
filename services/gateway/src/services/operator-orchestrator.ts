/**
 * Operator Deploy Orchestrator - VTID-0523
 *
 * Orchestrates the full deployment pipeline:
 * 1. Create PR (optional, if branch specified)
 * 2. Safe merge PR to main
 * 3. Deploy service to environment
 *
 * Emits OASIS events for each step for Live Ticker visibility.
 */

import { ingestOperatorEvent } from './operator-service';
import githubService from './github-service';
import { ALLOWED_DEPLOY_SERVICES } from '../types/cicd';

const DEFAULT_REPO = 'exafyltd/vitana-platform';

// ==================== Types ====================

export interface OperatorDeployInput {
  vtid: string;               // VTID for tracking
  service: string;            // e.g. "gateway"
  environment: string;        // e.g. "dev"
  branch?: string;            // Source branch (if creating PR)
  pr_number?: number;         // Existing PR number (if skipping create-pr)
  skip_pr?: boolean;          // Skip PR creation (deploy from main)
  skip_merge?: boolean;       // Skip merge (PR already merged)
  trigger_workflow?: boolean; // Whether to actually trigger GitHub workflow
}

export interface PipelineStep {
  name: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  detail?: string;
  data?: Record<string, unknown>;
}

export interface OperatorDeployResult {
  ok: boolean;
  vtid: string;
  service: string;
  environment: string;
  steps: PipelineStep[];
  error?: string;
  pr_number?: number;
  pr_url?: string;
  merge_sha?: string;
  workflow_url?: string;
}

// ==================== Helper Functions ====================

async function emitDeployEvent(
  vtid: string,
  type: string,
  status: 'info' | 'success' | 'error' | 'warning',
  message: string,
  payload?: Record<string, unknown>
) {
  try {
    await ingestOperatorEvent({
      vtid,
      type: `operator.deploy.${type}`,
      status,
      message,
      payload,
    });
  } catch (e) {
    // Don't fail pipeline if event logging fails
    console.error(`[Orchestrator] Failed to emit event: ${e}`);
  }
}

// ==================== Main Orchestrator ====================

/**
 * Run the full operator deployment pipeline
 */
export async function runOperatorDeployPipeline(
  input: OperatorDeployInput
): Promise<OperatorDeployResult> {
  const { vtid, service, environment, branch, pr_number: existingPrNumber, skip_pr, skip_merge, trigger_workflow = false } = input;

  const steps: PipelineStep[] = [
    { name: 'create-pr', status: 'pending' },
    { name: 'safe-merge', status: 'pending' },
    { name: 'deploy-service', status: 'pending' },
  ];

  const result: OperatorDeployResult = {
    ok: false,
    vtid,
    service,
    environment,
    steps,
  };

  console.log(`[Orchestrator] Starting deployment pipeline for ${vtid}: ${service} -> ${environment}`);

  // Emit pipeline started event
  await emitDeployEvent(vtid, 'started', 'info', `Deployment pipeline started for ${service}`, {
    service,
    environment,
    branch,
    skip_pr,
    skip_merge,
  });

  // Validate service is allowed
  if (!ALLOWED_DEPLOY_SERVICES.includes(service as any)) {
    const errorMsg = `Service '${service}' is not in the allowed list`;
    steps.forEach(s => s.status = 'error');
    steps[0].detail = errorMsg;
    result.error = errorMsg;
    await emitDeployEvent(vtid, 'failed', 'error', errorMsg, { service });
    return result;
  }

  let prNumber = existingPrNumber;
  let prUrl: string | undefined;
  let mergeSha: string | undefined;

  // ==================== Step 1: Create PR (optional) ====================
  if (skip_pr || !branch) {
    steps[0].status = 'skipped';
    steps[0].detail = skip_pr ? 'PR creation skipped by request' : 'No branch specified';
    console.log(`[Orchestrator] Step 1 (create-pr): Skipped`);
  } else {
    steps[0].status = 'running';
    await emitDeployEvent(vtid, 'step.create-pr.started', 'info', `Creating PR from ${branch} to main`);

    try {
      const prTitle = `[${vtid}] Deploy ${service} to ${environment}`;
      const prBody = `Automated deployment PR created by Operator Console.\n\nVTID: ${vtid}\nService: ${service}\nEnvironment: ${environment}`;

      const pr = await githubService.createPullRequest(DEFAULT_REPO, prTitle, prBody, branch, 'main');

      prNumber = pr.number;
      prUrl = pr.html_url;

      steps[0].status = 'success';
      steps[0].detail = `PR #${pr.number} created`;
      steps[0].data = { pr_number: pr.number, pr_url: pr.html_url };
      result.pr_number = pr.number;
      result.pr_url = pr.html_url;

      await emitDeployEvent(vtid, 'step.create-pr.completed', 'success', `PR #${pr.number} created`, {
        pr_number: pr.number,
        pr_url: pr.html_url,
      });

      console.log(`[Orchestrator] Step 1 (create-pr): Success - PR #${pr.number}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      steps[0].status = 'error';
      steps[0].detail = errorMsg;
      result.error = `Create PR failed: ${errorMsg}`;

      await emitDeployEvent(vtid, 'step.create-pr.failed', 'error', `Create PR failed: ${errorMsg}`);
      await emitDeployEvent(vtid, 'failed', 'error', `Pipeline failed at create-pr step: ${errorMsg}`);

      console.error(`[Orchestrator] Step 1 (create-pr): Failed - ${errorMsg}`);
      return result;
    }
  }

  // ==================== Step 2: Safe Merge ====================
  if (skip_merge) {
    steps[1].status = 'skipped';
    steps[1].detail = 'Merge skipped by request';
    console.log(`[Orchestrator] Step 2 (safe-merge): Skipped`);
  } else if (!prNumber) {
    steps[1].status = 'skipped';
    steps[1].detail = 'No PR to merge';
    console.log(`[Orchestrator] Step 2 (safe-merge): Skipped - no PR number`);
  } else {
    steps[1].status = 'running';
    await emitDeployEvent(vtid, 'step.safe-merge.started', 'info', `Merging PR #${prNumber}`);

    try {
      // Get PR status first
      const prStatus = await githubService.getPrStatus(DEFAULT_REPO, prNumber);

      if (prStatus.pr.state !== 'open') {
        if (prStatus.pr.state === 'merged') {
          steps[1].status = 'skipped';
          steps[1].detail = 'PR already merged';
          // Note: merge_commit_sha would need to come from a different API call
          console.log(`[Orchestrator] Step 2 (safe-merge): Skipped - already merged`);
        } else {
          throw new Error(`PR #${prNumber} is ${prStatus.pr.state}, not open`);
        }
      } else {
        // Run governance evaluation
        const governance = await githubService.evaluateGovernance(DEFAULT_REPO, prNumber, vtid);

        if (governance.decision === 'blocked') {
          throw new Error(`Governance blocked: ${governance.blocked_reasons.join(', ')}`);
        }

        // Merge the PR
        const mergeResult = await githubService.mergePullRequest(
          DEFAULT_REPO,
          prNumber,
          `${prStatus.pr.title} (#${prNumber})`,
          'squash'
        );

        mergeSha = mergeResult.sha;
        result.merge_sha = mergeSha;

        steps[1].status = 'success';
        steps[1].detail = `Merged with SHA ${mergeSha.substring(0, 7)}`;
        steps[1].data = { merge_sha: mergeSha };

        await emitDeployEvent(vtid, 'step.safe-merge.completed', 'success', `PR #${prNumber} merged`, {
          pr_number: prNumber,
          merge_sha: mergeSha,
        });

        console.log(`[Orchestrator] Step 2 (safe-merge): Success - ${mergeSha.substring(0, 7)}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      steps[1].status = 'error';
      steps[1].detail = errorMsg;
      result.error = `Safe merge failed: ${errorMsg}`;

      await emitDeployEvent(vtid, 'step.safe-merge.failed', 'error', `Safe merge failed: ${errorMsg}`);
      await emitDeployEvent(vtid, 'failed', 'error', `Pipeline failed at safe-merge step: ${errorMsg}`);

      console.error(`[Orchestrator] Step 2 (safe-merge): Failed - ${errorMsg}`);
      return result;
    }
  }

  // ==================== Step 3: Deploy Service ====================
  steps[2].status = 'running';
  await emitDeployEvent(vtid, 'step.deploy-service.started', 'info', `Deploying ${service} to ${environment}`);

  try {
    if (!trigger_workflow) {
      // Dry run - just validate and record
      steps[2].status = 'success';
      steps[2].detail = 'Deployment validated (dry run - workflow not triggered)';
      steps[2].data = { dry_run: true };

      await emitDeployEvent(vtid, 'step.deploy-service.completed', 'success',
        `Deployment validated for ${service} (dry run)`, { dry_run: true });

      console.log(`[Orchestrator] Step 3 (deploy-service): Success (dry run)`);
    } else {
      // Trigger the actual workflow
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
      result.workflow_url = latestRun?.html_url;

      steps[2].status = 'success';
      steps[2].detail = `Workflow triggered${latestRun ? `: ${latestRun.html_url}` : ''}`;
      steps[2].data = {
        workflow_run_id: latestRun?.id,
        workflow_url: latestRun?.html_url,
      };

      await emitDeployEvent(vtid, 'step.deploy-service.completed', 'success',
        `Deploy workflow triggered for ${service}`, {
          workflow_run_id: latestRun?.id,
          workflow_url: latestRun?.html_url,
        });

      console.log(`[Orchestrator] Step 3 (deploy-service): Success - workflow triggered`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    steps[2].status = 'error';
    steps[2].detail = errorMsg;
    result.error = `Deploy service failed: ${errorMsg}`;

    await emitDeployEvent(vtid, 'step.deploy-service.failed', 'error', `Deploy failed: ${errorMsg}`);
    await emitDeployEvent(vtid, 'failed', 'error', `Pipeline failed at deploy-service step: ${errorMsg}`);

    console.error(`[Orchestrator] Step 3 (deploy-service): Failed - ${errorMsg}`);
    return result;
  }

  // ==================== Pipeline Complete ====================
  result.ok = true;

  await emitDeployEvent(vtid, 'completed', 'success',
    `Deployment pipeline completed successfully for ${service}`, {
      service,
      environment,
      pr_number: result.pr_number,
      merge_sha: result.merge_sha,
      workflow_url: result.workflow_url,
    });

  console.log(`[Orchestrator] Pipeline completed successfully for ${vtid}`);

  return result;
}

export default {
  runOperatorDeployPipeline,
};
