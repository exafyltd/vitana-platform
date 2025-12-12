/**
 * OASIS Event Service - VTID-0516 Autonomous Safe-Merge Layer
 * Handles emitting events to OASIS for audit and observability
 */

import { randomUUID } from 'crypto';
import { CicdEventType, CicdOasisEvent } from '../types/cicd';

/**
 * Emit an event to OASIS via Supabase
 */
export async function emitOasisEvent(event: CicdOasisEvent): Promise<{ ok: boolean; event_id?: string; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[OASIS Event] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    return { ok: false, error: 'Gateway misconfigured: missing Supabase credentials' };
  }

  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  const payload = {
    id: eventId,
    created_at: timestamp,
    vtid: event.vtid,
    topic: event.type,
    service: event.source,
    role: 'CICD',
    model: 'autonomous-safe-merge',
    status: event.status,
    message: event.message,
    link: null,
    metadata: event.payload || {},
  };

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OASIS Event] Failed to emit event: ${response.status} - ${errorText}`);
      return { ok: false, error: `Failed to emit event: ${response.status}` };
    }

    console.log(`[OASIS Event] Emitted: ${event.type} for ${event.vtid} (${eventId})`);
    return { ok: true, event_id: eventId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[OASIS Event] Error emitting event: ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Helper functions for common CICD events
 */
export const cicdEvents = {
  // ==================== Create PR Events ====================
  createPrRequested: (vtid: string, head: string, base: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.create_pr.requested',
      source: 'gateway-cicd',
      status: 'info',
      message: `PR creation requested: ${head} -> ${base}`,
      payload: { head, base },
    }),

  createPrSucceeded: (vtid: string, prNumber: number, prUrl: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.create_pr.succeeded',
      source: 'gateway-cicd',
      status: 'success',
      message: `PR #${prNumber} created successfully`,
      payload: { pr_number: prNumber, pr_url: prUrl },
    }),

  createPrFailed: (vtid: string, error: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.create_pr.failed',
      source: 'gateway-cicd',
      status: 'error',
      message: `PR creation failed: ${error}`,
      payload: { error },
    }),

  // ==================== Safe Merge Events ====================
  safeMergeRequested: (vtid: string, repo: string, prNumber: number) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.safe_merge.requested',
      source: 'gateway-cicd',
      status: 'info',
      message: `Safe merge requested for PR #${prNumber} in ${repo}`,
      payload: { repo, pr_number: prNumber },
    }),

  safeMergeEvaluated: (
    vtid: string,
    prNumber: number,
    decision: 'approved' | 'blocked',
    files: string[],
    services: string[],
    blockedReasons: string[] = []
  ) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.safe_merge.evaluated',
      source: 'gateway-cicd',
      status: decision === 'approved' ? 'info' : 'warning',
      message: `PR #${prNumber} governance evaluation: ${decision}`,
      payload: {
        pr_number: prNumber,
        decision,
        files_touched: files,
        services_impacted: services,
        blocked_reasons: blockedReasons,
      },
    }),

  safeMergeApproved: (vtid: string, prNumber: number) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.safe_merge.approved',
      source: 'gateway-cicd',
      status: 'success',
      message: `PR #${prNumber} approved for merge`,
      payload: { pr_number: prNumber },
    }),

  safeMergeBlocked: (vtid: string, prNumber: number, reason: string, details: Record<string, unknown> = {}) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.safe_merge.blocked',
      source: 'gateway-cicd',
      status: 'warning',
      message: `PR #${prNumber} blocked: ${reason}`,
      payload: { pr_number: prNumber, reason, ...details },
    }),

  safeMergeExecuted: (vtid: string, prNumber: number, sha: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.safe_merge.executed',
      source: 'gateway-cicd',
      status: 'success',
      message: `PR #${prNumber} merged successfully`,
      payload: { pr_number: prNumber, merge_sha: sha },
    }),

  // ==================== Deploy Events ====================
  deployRequested: (vtid: string, service: string, environment: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.deploy.service.requested',
      source: 'gateway-cicd',
      status: 'info',
      message: `Deploy requested: ${service} to ${environment}`,
      payload: { service, environment },
    }),

  deployAccepted: (vtid: string, service: string, environment: string, workflowUrl?: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.deploy.service.accepted',
      source: 'gateway-cicd',
      status: 'success',
      message: `Deploy accepted: ${service} to ${environment}`,
      payload: { service, environment, workflow_url: workflowUrl },
    }),

  deployBlocked: (vtid: string, service: string, reason: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.deploy.service.blocked',
      source: 'gateway-cicd',
      status: 'warning',
      message: `Deploy blocked: ${service} - ${reason}`,
      payload: { service, reason },
    }),

  deploySucceeded: (vtid: string, service: string, environment: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.deploy.service.succeeded',
      source: 'gateway-cicd',
      status: 'success',
      message: `Deploy succeeded: ${service} to ${environment}`,
      payload: { service, environment },
    }),

  deployFailed: (vtid: string, service: string, error: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.deploy.service.failed',
      source: 'gateway-cicd',
      status: 'error',
      message: `Deploy failed: ${service} - ${error}`,
      payload: { service, error },
    }),

  deployValidated: (vtid: string, service: string, success: boolean, details: Record<string, unknown> = {}) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.deploy.service.validated',
      source: 'gateway-cicd',
      status: success ? 'success' : 'error',
      message: `Deploy validation ${success ? 'passed' : 'failed'}: ${service}`,
      payload: { service, validation_passed: success, ...details },
    }),

  // ==================== Version Tracking Events (VTID-0510) ====================
  deployVersionRecorded: (
    swvId: string,
    service: string,
    gitCommit: string,
    deployType: 'normal' | 'rollback',
    initiator: 'user' | 'agent',
    environment: string
  ) =>
    emitOasisEvent({
      vtid: `VTID-0510-${swvId}`,
      type: 'cicd.deploy.version.recorded',
      source: 'gateway-versioning',
      status: 'success',
      message: `Software version ${swvId} recorded for ${service}`,
      payload: {
        swv_id: swvId,
        service,
        git_commit: gitCommit,
        deploy_type: deployType,
        initiator,
        environment,
      },
    }),

  // ==================== Governance Deploy Events (VTID-0407) ====================
  governanceDeployBlocked: (
    vtid: string,
    service: string,
    level: string,
    violations: Array<{ rule_id: string; level: string; message: string }>
  ) =>
    emitOasisEvent({
      vtid,
      type: 'governance.deploy.blocked',
      source: 'gateway-governance',
      status: 'warning',
      message: `Deploy blocked by governance: ${service} (${violations.length} violation${violations.length !== 1 ? 's' : ''})`,
      payload: {
        service,
        level,
        violations,
        blocked_at: new Date().toISOString(),
      },
    }),

  governanceDeployAllowed: (
    vtid: string,
    service: string,
    level: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'governance.deploy.allowed',
      source: 'gateway-governance',
      status: 'success',
      message: `Deploy allowed by governance: ${service}`,
      payload: {
        service,
        level,
        allowed_at: new Date().toISOString(),
      },
    }),
};

export default cicdEvents;
