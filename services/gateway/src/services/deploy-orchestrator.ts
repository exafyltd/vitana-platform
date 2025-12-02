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
 */
export async function createVtid(
  family: 'DEV' | 'ADM' | 'GOVRN' | 'OASIS',
  module: string,
  title: string
): Promise<{ ok: boolean; vtid?: string; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !svcKey) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    // Generate VTID via database RPC
    const rpcResp = await fetch(`${supabaseUrl}/rest/v1/rpc/next_vtid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
      body: JSON.stringify({ p_family: family, p_module: module.toUpperCase() }),
    });

    if (!rpcResp.ok) {
      const errorText = await rpcResp.text();
      console.error(`[Deploy Orchestrator] VTID generation failed: ${rpcResp.status} - ${errorText}`);
      return { ok: false, error: `VTID generation failed: ${errorText}` };
    }

    const vtid = await rpcResp.json() as string;

    // Insert into VtidLedger
    const insertResp = await fetch(`${supabaseUrl}/rest/v1/VtidLedger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        id: randomUUID(),
        vtid,
        task_family: family,
        task_module: module.toUpperCase(),
        module: module.toUpperCase(),
        layer: module.toUpperCase().slice(0, 3),
        title,
        status: 'scheduled',
        tenant: 'vitana',
        is_test: false,
        description_md: '',
        metadata: {},
      }),
    });

    if (!insertResp.ok) {
      const errorText = await insertResp.text();
      console.error(`[Deploy Orchestrator] VTID insert failed: ${insertResp.status} - ${errorText}`);
      return { ok: false, error: `VTID insert failed: ${errorText}` };
    }

    console.log(`[Deploy Orchestrator] Created VTID: ${vtid}`);
    return { ok: true, vtid };

  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

/**
 * Create a Command Hub task for non-deploy commands.
 */
export async function createTask(
  vtid: string,
  title: string,
  taskType: string,
  metadata: Record<string, unknown> = {}
): Promise<{ ok: boolean; task_id?: string; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !svcKey) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const taskId = `${vtid}-${randomUUID().slice(0, 8).toUpperCase()}`;

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        id: randomUUID(),
        vtid: taskId,
        title,
        summary: `Task type: ${taskType}`,
        layer: 'CMD',
        module: 'CMD',
        task_family: 'OASIS',
        task_module: 'CMD',
        status: 'scheduled',
        tenant: 'vitana',
        is_test: false,
        description_md: '',
        metadata: { ...metadata, parent_vtid: vtid, task_type: taskType },
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`[Deploy Orchestrator] Task creation failed: ${resp.status} - ${errorText}`);
      return { ok: false, error: `Task creation failed: ${errorText}` };
    }

    console.log(`[Deploy Orchestrator] Created task: ${taskId}`);
    return { ok: true, task_id: taskId };

  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

export default {
  executeDeploy,
  createVtid,
  createTask,
};
