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

  const payload: Record<string, unknown> = {
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
    // VTID-01260: Actor identification and surface tracking
    ...(event.actor_id && { actor_id: event.actor_id }),
    ...(event.actor_email && { actor_email: event.actor_email }),
    ...(event.actor_role && { actor_role: event.actor_role }),
    ...(event.surface && { surface: event.surface }),
    ...(event.conversation_turn_id && { conversation_turn_id: event.conversation_turn_id }),
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
      // VTID-01260: Surface tracking
      surface: 'cicd',
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

  // ==================== VTID-01031: Find PR Events (Idempotency) ====================
  findPrRequested: (vtid: string, headBranch: string, baseBranch: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.find_pr.requested',
      source: 'gateway-cicd',
      status: 'info',
      message: `Searching for existing PR: ${headBranch} -> ${baseBranch}`,
      payload: { head_branch: headBranch, base_branch: baseBranch },
    }),

  findPrSucceeded: (vtid: string, prNumber: number, prUrl: string, headBranch: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.find_pr.succeeded',
      source: 'gateway-cicd',
      status: 'success',
      message: `Found existing PR #${prNumber} for ${headBranch}`,
      payload: { pr_number: prNumber, pr_url: prUrl, head_branch: headBranch },
    }),

  createPrSkippedExisting: (vtid: string, prNumber: number, prUrl: string, headBranch: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.github.create_pr.skipped_existing',
      source: 'gateway-cicd',
      status: 'info',
      message: `PR creation skipped - reusing existing PR #${prNumber} for ${headBranch}`,
      payload: { pr_number: prNumber, pr_url: prUrl, head_branch: headBranch, reused: true },
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

  // ==================== DEV-OASIS-0210: Deploy Gateway Events ====================
  // These events are used by Command Hub UI for Live Ticker, Operator Console,
  // and Task Event History displays.

  deployGatewaySuccess: (
    vtid: string,
    service: string,
    environment: string,
    swv?: string,
    branch?: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'deploy.gateway.success',
      source: 'gateway-deploy-orchestrator',
      status: 'success',
      message: `Gateway deploy SUCCESS (${swv || 'latest'} on ${branch || 'main'})`,
      payload: {
        vtid,
        swv: swv || null,
        service,
        environment,
        branch: branch || 'main',
        deployed_at: new Date().toISOString(),
      },
    }),

  deployGatewayFailed: (
    vtid: string,
    service: string,
    environment: string,
    error: string,
    swv?: string,
    branch?: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'deploy.gateway.failed',
      source: 'gateway-deploy-orchestrator',
      status: 'error',
      message: `Gateway deploy FAILED (${swv || 'latest'} on ${branch || 'main'}): ${error}`,
      payload: {
        vtid,
        swv: swv || null,
        service,
        environment,
        branch: branch || 'main',
        error,
        failed_at: new Date().toISOString(),
      },
    }),

  // ==================== DEV-OASIS-0210: Governance Evaluation Events ====================
  governanceEvaluation: (
    vtid: string,
    service: string,
    result: 'pass' | 'fail' | 'warning',
    level: 'L1' | 'L2' | 'L3' | 'L4',
    ruleIds: string[] = [],
    swv?: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'governance.evaluation',
      source: 'governance-engine',
      status: result === 'fail' ? 'error' : result === 'warning' ? 'warning' : 'success',
      message: `Governance evaluation ${result} for ${service}`,
      payload: {
        vtid,
        swv: swv || null,
        result,
        rule_ids: ruleIds,
        level,
        service,
        evaluated_at: new Date().toISOString(),
      },
    }),

  // ==================== VTID-0601: Autonomous Safe Merge & Deploy Control ====================

  /**
   * VTID-0601: Emit merge requested event
   */
  mergeRequested: (vtid: string, prNumber: number, repo: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.merge.requested',
      source: 'command-hub-cicd',
      status: 'info',
      message: `Merge requested for PR #${prNumber} via Command Hub`,
      payload: { pr_number: prNumber, repo, source: 'command-hub' },
      // VTID-01260: Surface tracking
      surface: 'command-hub',
    }),

  /**
   * VTID-0601: Emit merge success event
   */
  mergeSuccess: (vtid: string, prNumber: number, sha: string, repo: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.merge.success',
      source: 'command-hub-cicd',
      status: 'success',
      message: `PR #${prNumber} merged successfully via Command Hub`,
      payload: { pr_number: prNumber, sha, repo, merged_at: new Date().toISOString() },
    }),

  /**
   * VTID-0601: Emit merge failed event
   */
  mergeFailed: (vtid: string, prNumber: number, reason: string, repo: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.merge.failed',
      source: 'command-hub-cicd',
      status: 'error',
      message: `Merge failed for PR #${prNumber}: ${reason}`,
      payload: { pr_number: prNumber, reason, repo, failed_at: new Date().toISOString() },
    }),

  /**
   * VTID-0601: Emit deploy requested event (Command Hub triggered)
   */
  deployRequestedFromHub: (vtid: string, service: string, environment: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.deploy.requested',
      source: 'command-hub-cicd',
      status: 'info',
      message: `Deploy requested for ${service} to ${environment} via Command Hub`,
      payload: { service, environment, source: 'command-hub', requested_at: new Date().toISOString() },
    }),

  /**
   * VTID-0601: Emit deploy started event
   */
  deployStarted: (vtid: string, service: string, environment: string, workflowUrl?: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.deploy.started',
      source: 'command-hub-cicd',
      status: 'info',
      message: `Deploy workflow started for ${service} to ${environment}`,
      payload: { service, environment, workflow_url: workflowUrl, started_at: new Date().toISOString() },
    }),

  /**
   * VTID-0601: Emit approval created event
   */
  approvalCreated: (vtid: string, approvalId: string, type: string, prNumber?: number, service?: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.approval.created',
      source: 'command-hub-cicd',
      status: 'info',
      message: `Approval request created: ${type}${prNumber ? ` for PR #${prNumber}` : ''}${service ? ` (${service})` : ''}`,
      payload: { approval_id: approvalId, approval_type: type, pr_number: prNumber, service, created_at: new Date().toISOString() },
    }),

  /**
   * VTID-0601: Emit approval approved event
   */
  approvalApproved: (vtid: string, approvalId: string, type: string, approvedBy: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.approval.approved',
      source: 'command-hub-cicd',
      status: 'success',
      message: `Approval granted: ${type} approved by ${approvedBy}`,
      payload: { approval_id: approvalId, approval_type: type, approved_by: approvedBy, approved_at: new Date().toISOString() },
    }),

  /**
   * VTID-0601: Emit approval denied event
   */
  approvalDenied: (vtid: string, approvalId: string, type: string, deniedBy: string, reason?: string) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.approval.denied',
      source: 'command-hub-cicd',
      status: 'warning',
      message: `Approval denied: ${type}${reason ? ` - ${reason}` : ''}`,
      payload: { approval_id: approvalId, approval_type: type, denied_by: deniedBy, reason, denied_at: new Date().toISOString() },
    }),

  // ==================== VTID-01032: Multi-Service Deploy Selection ====================

  /**
   * VTID-01032: Emit deploy selection event
   * This event records which services were selected for deployment and how.
   */
  deploySelection: (
    vtid: string,
    services: string[],
    environment: string,
    reason: string,
    changedFilesCount: number,
    prNumber?: number,
    mergeSha?: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.deploy.selection',
      source: 'autonomous-pr-merge',
      status: services.length > 0 ? 'info' : 'warning',
      message: services.length > 0
        ? `Deploy selection: ${services.join(', ')} to ${environment} (${reason})`
        : `No deploy target: ${reason}`,
      payload: {
        services,
        environment,
        reason,
        changed_files_count: changedFilesCount,
        pr_number: prNumber,
        merge_sha: mergeSha,
        selected_at: new Date().toISOString(),
      },
    }),

  // ==================== VTID-01018: Operator Action Lifecycle Events ====================
  // These events enforce the hard contract for operator actions.
  // Every operator action MUST emit started + exactly one terminal event.

  /**
   * VTID-01018: Emit operator.action.started event
   * This MUST be emitted BEFORE any action execution begins.
   * MANDATORY for hard contract compliance.
   */
  operatorActionStarted: (
    vtid: string | null,
    operatorActionId: string,
    operatorId: string,
    operatorRole: 'operator' | 'admin' | 'system',
    actionType: string,
    actionPayloadHash: string,
    payload?: Record<string, unknown>
  ) =>
    emitOasisEvent({
      vtid: vtid || 'VTID-01018',
      type: 'operator.action.started',
      source: 'operator-console',
      status: 'info',
      message: `Operator action started: ${actionType}`,
      payload: {
        operator_action_id: operatorActionId,
        operator_id: operatorId,
        operator_role: operatorRole,
        action_type: actionType,
        action_payload_hash: actionPayloadHash,
        source: 'operator',
        ...payload,
      },
      // VTID-01260: Actor identification and surface tracking
      actor_id: operatorId,
      actor_email: operatorId,
      actor_role: operatorRole,
      surface: 'operator',
    }),

  /**
   * VTID-01018: Emit operator.action.completed event
   * This MUST be emitted when an action completes successfully.
   * MANDATORY for hard contract compliance.
   */
  operatorActionCompleted: (
    vtid: string | null,
    operatorActionId: string,
    operatorId: string,
    operatorRole: 'operator' | 'admin' | 'system',
    actionType: string,
    actionPayloadHash: string,
    payload?: Record<string, unknown>
  ) =>
    emitOasisEvent({
      vtid: vtid || 'VTID-01018',
      type: 'operator.action.completed',
      source: 'operator-console',
      status: 'success',
      message: `Operator action completed: ${actionType}`,
      payload: {
        operator_action_id: operatorActionId,
        operator_id: operatorId,
        operator_role: operatorRole,
        action_type: actionType,
        action_payload_hash: actionPayloadHash,
        source: 'operator',
        ...payload,
      },
      // VTID-01260: Actor identification and surface tracking
      actor_id: operatorId,
      actor_email: operatorId,
      actor_role: operatorRole,
      surface: 'operator',
    }),

  /**
   * VTID-01018: Emit operator.action.failed event
   * This MUST be emitted when an action fails.
   * MANDATORY for hard contract compliance.
   */
  operatorActionFailed: (
    vtid: string | null,
    operatorActionId: string,
    operatorId: string,
    operatorRole: 'operator' | 'admin' | 'system',
    actionType: string,
    actionPayloadHash: string,
    errorReason: string,
    payload?: Record<string, unknown>
  ) =>
    emitOasisEvent({
      vtid: vtid || 'VTID-01018',
      type: 'operator.action.failed',
      source: 'operator-console',
      status: 'error',
      message: `Operator action failed: ${actionType} - ${errorReason}`,
      payload: {
        operator_action_id: operatorActionId,
        operator_id: operatorId,
        operator_role: operatorRole,
        action_type: actionType,
        action_payload_hash: actionPayloadHash,
        source: 'operator',
        error_reason: errorReason,
        ...payload,
      },
      // VTID-01260: Actor identification and surface tracking
      actor_id: operatorId,
      actor_email: operatorId,
      actor_role: operatorRole,
      surface: 'operator',
    }),

  // ==================== VTID-01005: Terminal Lifecycle Events ====================
  // These are the MANDATORY terminal events that must be emitted for every VTID
  // that reaches a terminal state. OASIS is the single source of truth.

  /**
   * VTID-01005: Emit terminal COMPLETED lifecycle event
   * This MUST be emitted when a VTID reaches successful completion.
   * MANDATORY for governance contract compliance.
   */
  vtidLifecycleCompleted: (
    vtid: string,
    source: 'claude' | 'cicd' | 'operator',
    summary?: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'vtid.lifecycle.completed',
      source: `vtid-lifecycle-${source}`,
      status: 'success',
      message: summary || `VTID ${vtid} completed successfully`,
      payload: {
        vtid,
        outcome: 'success',
        source,
        terminal: true,
        completed_at: new Date().toISOString(),
      },
    }),

  /**
   * VTID-01005: Emit terminal FAILED lifecycle event
   * This MUST be emitted when a VTID fails terminally.
   * MANDATORY for governance contract compliance.
   */
  vtidLifecycleFailed: (
    vtid: string,
    source: 'claude' | 'cicd' | 'operator',
    reason?: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'vtid.lifecycle.failed',
      source: `vtid-lifecycle-${source}`,
      status: 'error',
      message: reason || `VTID ${vtid} failed`,
      payload: {
        vtid,
        outcome: 'failed',
        source,
        terminal: true,
        reason,
        failed_at: new Date().toISOString(),
      },
    }),

  // ==================== VTID-01033: CICD Lock Events ====================

  /**
   * VTID-01033: Emit lock acquisition requested event
   */
  lockAcquireRequested: (
    vtid: string,
    keys: string[],
    prNumber?: number
  ) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.lock.acquire.requested',
      source: 'cicd-lock-manager',
      status: 'info',
      message: `Lock acquisition requested for ${keys.length} key(s)`,
      payload: {
        requested_keys: keys,
        pr_number: prNumber,
        requested_at: new Date().toISOString(),
      },
    }),

  /**
   * VTID-01033: Emit lock acquisition succeeded event
   */
  lockAcquireSucceeded: (
    vtid: string,
    acquiredKeys: string[],
    expiresAt: string,
    prNumber?: number
  ) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.lock.acquire.succeeded',
      source: 'cicd-lock-manager',
      status: 'success',
      message: `Acquired ${acquiredKeys.length} lock(s): ${acquiredKeys.join(', ')}`,
      payload: {
        acquired_keys: acquiredKeys,
        expires_at: expiresAt,
        pr_number: prNumber,
        acquired_at: new Date().toISOString(),
      },
    }),

  /**
   * VTID-01033: Emit lock acquisition blocked event
   */
  lockAcquireBlocked: (
    vtid: string,
    blockedKey: string,
    heldBy: string,
    heldSince?: string,
    expiresAt?: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.lock.acquire.blocked',
      source: 'cicd-lock-manager',
      status: 'warning',
      message: `Lock acquisition blocked: ${blockedKey} held by ${heldBy}`,
      payload: {
        blocked_key: blockedKey,
        held_by: heldBy,
        held_since: heldSince,
        expires_at: expiresAt,
        blocked_at: new Date().toISOString(),
      },
    }),

  /**
   * VTID-01033: Emit lock released event
   */
  lockReleased: (
    vtid: string,
    releasedKeys: string[],
    reason: 'success' | 'failure' | 'timeout' | 'explicit'
  ) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.lock.released',
      source: 'cicd-lock-manager',
      status: 'info',
      message: `Released ${releasedKeys.length} lock(s): ${releasedKeys.join(', ')}`,
      payload: {
        released_keys: releasedKeys,
        reason,
        released_at: new Date().toISOString(),
      },
    }),

  /**
   * VTID-01033: Emit lock expired event
   */
  lockExpired: (
    vtid: string,
    expiredKey: string,
    heldSince: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'cicd.lock.expired',
      source: 'cicd-lock-manager',
      status: 'warning',
      message: `Lock expired: ${expiredKey}`,
      payload: {
        expired_key: expiredKey,
        held_since: heldSince,
        expired_at: new Date().toISOString(),
      },
    }),
};

/**
 * VTID-0408 + DEV-OASIS-0210: Governance History Event Types
 * These are the event types that appear in the governance history timeline.
 */
export const GOVERNANCE_EVENT_TYPES = [
    'governance.deploy.blocked',
    'governance.deploy.allowed',
    'governance.evaluation',  // DEV-OASIS-0210: Standard governance evaluation event
    'governance.evaluate',    // Legacy event type for backward compatibility
    'governance.rule.created',
    'governance.rule.updated',
    'governance.violated',
    'governance.control.updated'  // VTID-01181: System control state changes (arm/disarm)
] as const;

/**
 * VTID-01099: Memory Governance Event Types
 * These are the event types for memory governance user controls.
 */
export const MEMORY_GOVERNANCE_EVENT_TYPES = [
    'memory.visibility.updated',
    'memory.locked',
    'memory.unlocked',
    'memory.deleted',
    'memory.export.requested',
    'memory.export.ready'
] as const;

/**
 * VTID-01099: Memory Governance Event Helpers
 * Helper functions for emitting memory governance events.
 */
export const memoryGovernanceEvents = {
  /**
   * Emit visibility updated event
   */
  visibilityUpdated: (
    tenantId: string,
    userId: string,
    domain: string,
    visibility: string,
    hasCustomRules: boolean
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01099',
      type: 'memory.visibility.updated',
      source: 'memory-governance',
      status: 'success',
      message: `Visibility set for ${domain}: ${visibility}`,
      payload: {
        tenant_id: tenantId,
        user_id: userId,
        domain,
        visibility,
        has_custom_rules: hasCustomRules,
        updated_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit entity locked event
   */
  locked: (
    tenantId: string,
    userId: string,
    entityType: string,
    entityId: string,
    reason?: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01099',
      type: 'memory.locked',
      source: 'memory-governance',
      status: 'success',
      message: `Entity locked: ${entityType}/${entityId}`,
      payload: {
        tenant_id: tenantId,
        user_id: userId,
        entity_type: entityType,
        entity_id: entityId,
        reason,
        locked_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit entity unlocked event
   */
  unlocked: (
    tenantId: string,
    userId: string,
    entityType: string,
    entityId: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01099',
      type: 'memory.unlocked',
      source: 'memory-governance',
      status: 'success',
      message: `Entity unlocked: ${entityType}/${entityId}`,
      payload: {
        tenant_id: tenantId,
        user_id: userId,
        entity_type: entityType,
        entity_id: entityId,
        unlocked_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit entity deleted event
   */
  deleted: (
    tenantId: string,
    userId: string,
    entityType: string,
    entityId: string,
    cascade?: Record<string, unknown>
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01099',
      type: 'memory.deleted',
      source: 'memory-governance',
      status: 'success',
      message: `Entity deleted: ${entityType}/${entityId}`,
      payload: {
        tenant_id: tenantId,
        user_id: userId,
        entity_type: entityType,
        entity_id: entityId,
        cascade,
        deleted_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit export requested event
   */
  exportRequested: (
    tenantId: string,
    userId: string,
    exportId: string,
    domains: string[],
    format: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01099',
      type: 'memory.export.requested',
      source: 'memory-governance',
      status: 'info',
      message: `Export requested: ${domains.join(', ')} (${format})`,
      payload: {
        tenant_id: tenantId,
        user_id: userId,
        export_id: exportId,
        domains,
        format,
        requested_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit export ready event
   */
  exportReady: (
    tenantId: string,
    userId: string,
    exportId: string,
    domains: string[],
    format: string,
    fileUrl: string,
    fileSizeBytes: number
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01099',
      type: 'memory.export.ready',
      source: 'memory-governance',
      status: 'success',
      message: `Export ready: ${domains.join(', ')} (${format})`,
      payload: {
        tenant_id: tenantId,
        user_id: userId,
        export_id: exportId,
        domains,
        format,
        file_url: fileUrl,
        file_size_bytes: fileSizeBytes,
        ready_at: new Date().toISOString(),
      },
    }),
};

/**
 * VTID-01123: Response Framing Event Types
 * These are the event types for response framing decisions.
 */
export const RESPONSE_FRAMING_EVENT_TYPES = [
    'response.framing.computed',
    'response.framing.applied',
    'response.framing.override'
] as const;

/**
 * VTID-01123: Response Framing Event Helpers
 * Helper functions for emitting response framing events.
 */
export const responseFramingEvents = {
  /**
   * Emit framing computed event
   * Called when a response profile is computed
   */
  framingComputed: (
    decisionId: string,
    responseProfile: {
      depth_level: string;
      tone: string;
      pacing: string;
      directness: string;
      confidence_expression: string;
    },
    inputSummary: {
      intent_type: string;
      intent_confidence: number;
      domain: string;
      emotional_state: string;
      cognitive_load: number;
      engagement_level: number;
    },
    rationaleCodes: string[],
    conversationId?: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01123',
      type: 'response.framing.computed',
      source: 'response-framing-engine',
      status: 'success',
      message: `Response framing computed: ${responseProfile.tone} tone, ${responseProfile.depth_level} depth`,
      payload: {
        decision_id: decisionId,
        response_profile: responseProfile,
        input_summary: inputSummary,
        rationale_codes: rationaleCodes,
        conversation_id: conversationId,
        computed_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit framing applied event
   * Called when a response profile is applied to output generation
   */
  framingApplied: (
    decisionId: string,
    responseProfile: {
      depth_level: string;
      tone: string;
      pacing: string;
      directness: string;
      confidence_expression: string;
    },
    outputContext: {
      conversation_id?: string;
      user_id?: string;
      tenant_id?: string;
      output_type?: 'text' | 'voice' | 'mixed';
    }
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01123',
      type: 'response.framing.applied',
      source: 'response-framing-engine',
      status: 'success',
      message: `Response framing applied to output generation`,
      payload: {
        decision_id: decisionId,
        response_profile: responseProfile,
        ...outputContext,
        applied_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit framing override event
   * Called when user preferences or safety constraints override computed values
   */
  framingOverride: (
    decisionId: string,
    overrides: Array<{
      dimension: string;
      original_value: string;
      applied_value: string;
      reason: string;
    }>,
    overrideSource: 'user_preference' | 'safety_constraint' | 'system_policy'
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01123',
      type: 'response.framing.override',
      source: 'response-framing-engine',
      status: 'info',
      message: `Response framing overridden by ${overrideSource}: ${overrides.length} dimension(s)`,
      payload: {
        decision_id: decisionId,
        overrides,
        override_source: overrideSource,
        override_count: overrides.length,
        overridden_at: new Date().toISOString(),
      },
    }),
};

/**
 * VTID-0408: Governance History Event DTO
 */
export interface GovernanceHistoryEvent {
    id: string;
    timestamp: string;
    type: string;
    actor: string;
    level?: string;
    summary: string;
    details?: any;
}

/**
 * VTID-0408: Parameters for fetching governance history
 */
export interface GovernanceHistoryParams {
    limit: number;
    offset: number;
    type?: string;
    level?: string;
    actor?: string;
}

/**
 * VTID-0408: Fetches governance history events from OASIS.
 * Queries oasis_events table for governance-related event types.
 */
export async function getGovernanceHistory(params: GovernanceHistoryParams): Promise<{
    ok: boolean;
    events: GovernanceHistoryEvent[];
    pagination: {
        limit: number;
        offset: number;
        count: number;
        has_more: boolean;
    };
    error?: string;
}> {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !supabaseKey) {
        console.warn('[VTID-0408] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
        return {
            ok: false,
            events: [],
            pagination: { limit: params.limit, offset: params.offset, count: 0, has_more: false },
            error: 'Gateway misconfigured: missing Supabase credentials'
        };
    }

    try {
        // Build query URL for oasis_events
        // We query for multiple governance event types using OR filter
        const eventTypesFilter = GOVERNANCE_EVENT_TYPES.map(t => `topic.eq.${t}`).join(',');

        let queryUrl = `${supabaseUrl}/rest/v1/oasis_events?or=(${eventTypesFilter})&order=created_at.desc&limit=${params.limit + 1}&offset=${params.offset}`;

        // Add type filter if specified
        if (params.type && params.type !== 'all') {
            queryUrl = `${supabaseUrl}/rest/v1/oasis_events?topic=eq.${params.type}&order=created_at.desc&limit=${params.limit + 1}&offset=${params.offset}`;
        }

        const response = await fetch(queryUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.warn('[VTID-0408] Governance history fetch error:', response.status, errorText);
            return {
                ok: false,
                events: [],
                pagination: { limit: params.limit, offset: params.offset, count: 0, has_more: false },
                error: `Failed to fetch events: ${response.status}`
            };
        }

        const rawEvents = await response.json() as any[];

        // Check if there are more results
        const hasMore = rawEvents.length > params.limit;
        const events = rawEvents.slice(0, params.limit);

        // Transform raw OASIS events to GovernanceHistoryEvent DTOs
        const transformedEvents: GovernanceHistoryEvent[] = events.map((ev: any) => {
            const metadata = ev.metadata || {};

            // Derive actor from metadata or default
            let actor = metadata.actor || metadata.initiator || 'system';
            if (ev.service === 'gateway-governance') {
                actor = 'validator';
            } else if (metadata.source === 'autopilot' || metadata.initiator === 'agent') {
                actor = 'autopilot';
            } else if (metadata.source === 'operator' || metadata.initiator === 'user') {
                actor = 'operator';
            }

            // Derive level from metadata
            const level = metadata.level || undefined;

            // Create human-readable summary
            let summary = ev.message || '';
            if (!summary) {
                switch (ev.topic) {
                    case 'governance.deploy.blocked':
                        summary = `Deploy blocked for ${metadata.service || 'unknown'} (${metadata.violations?.length || 0} violations)`;
                        break;
                    case 'governance.deploy.allowed':
                        summary = `Deploy allowed for ${metadata.service || 'unknown'}`;
                        break;
                    case 'governance.evaluate':
                        summary = `Governance evaluation for ${metadata.action || 'action'} on ${metadata.service || 'service'}`;
                        break;
                    case 'governance.rule.created':
                        summary = `Rule created: ${metadata.rule_id || metadata.ruleCode || 'unknown'}`;
                        break;
                    case 'governance.rule.updated':
                        summary = `Rule updated: ${metadata.rule_id || metadata.ruleCode || 'unknown'}`;
                        break;
                    case 'governance.violated':
                        summary = `Governance violation detected`;
                        break;
                    default:
                        summary = `Governance event: ${ev.topic}`;
                }
            }

            return {
                id: ev.id,
                timestamp: ev.created_at,
                type: ev.topic,
                actor,
                level,
                summary,
                details: {
                    ...metadata,
                    vtid: ev.vtid,
                    service: ev.service,
                    status: ev.status
                }
            };
        });

        // Apply additional filters in memory (for level and actor)
        let filteredEvents = transformedEvents;

        if (params.level && params.level !== 'all') {
            filteredEvents = filteredEvents.filter(ev => ev.level === params.level);
        }

        if (params.actor && params.actor !== 'all') {
            filteredEvents = filteredEvents.filter(ev => ev.actor === params.actor);
        }

        console.log(`[VTID-0408] Governance history fetched: ${filteredEvents.length} events`);

        return {
            ok: true,
            events: filteredEvents,
            pagination: {
                limit: params.limit,
                offset: params.offset,
                count: filteredEvents.length,
                has_more: hasMore
            }
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.warn('[VTID-0408] Governance history fetch error:', errorMessage);
        return {
            ok: false,
            events: [],
            pagination: { limit: params.limit, offset: params.offset, count: 0, has_more: false },
            error: errorMessage
        };
    }
}

// =============================================================================
// VTID-01122: Safety Guardrail Event Types
// =============================================================================

/**
 * VTID-01122: Safety Guardrail Event Types
 * These are the event types for safety guardrail decisions.
 */
export const SAFETY_GUARDRAIL_EVENT_TYPES = [
  'safety.guardrail.evaluated',
  'safety.guardrail.allowed',
  'safety.guardrail.restricted',
  'safety.guardrail.redirected',
  'safety.guardrail.blocked',
  'safety.guardrail.rule.triggered',
  'safety.guardrail.autonomy.denied'
] as const;

/**
 * VTID-01122: Safety Guardrail Event Helpers
 * Helper functions for emitting safety guardrail events.
 */
export const safetyGuardrailEvents = {
  /**
   * Emit guardrail evaluation event
   */
  evaluated: (
    evaluationId: string,
    requestId: string,
    sessionId: string,
    tenantId: string,
    finalAction: 'allow' | 'restrict' | 'redirect' | 'block',
    primaryDomain: string | null,
    triggeredRules: string[],
    inputHash: string,
    ruleVersion: string,
    evaluationDurationMs: number
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01122',
      type: 'safety.guardrail.evaluated',
      source: 'safety-guardrails',
      status: finalAction === 'allow' ? 'success' : finalAction === 'block' ? 'warning' : 'info',
      message: `Safety guardrail ${finalAction}: ${primaryDomain || 'none'}`,
      payload: {
        evaluation_id: evaluationId,
        request_id: requestId,
        session_id: sessionId,
        tenant_id: tenantId,
        final_action: finalAction,
        primary_domain: primaryDomain,
        triggered_rules: triggeredRules,
        input_hash: inputHash,
        rule_version: ruleVersion,
        evaluation_duration_ms: evaluationDurationMs,
        evaluated_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit allowed event
   */
  allowed: (
    evaluationId: string,
    requestId: string,
    tenantId: string,
    domains: string[]
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01122',
      type: 'safety.guardrail.allowed',
      source: 'safety-guardrails',
      status: 'success',
      message: `Request allowed through safety guardrails`,
      payload: {
        evaluation_id: evaluationId,
        request_id: requestId,
        tenant_id: tenantId,
        domains_evaluated: domains,
        allowed_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit restricted event
   */
  restricted: (
    evaluationId: string,
    requestId: string,
    tenantId: string,
    domain: string,
    reason: string,
    userMessage: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01122',
      type: 'safety.guardrail.restricted',
      source: 'safety-guardrails',
      status: 'info',
      message: `Request restricted: ${domain} - ${reason}`,
      payload: {
        evaluation_id: evaluationId,
        request_id: requestId,
        tenant_id: tenantId,
        domain,
        reason,
        user_message: userMessage,
        restricted_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit redirected event
   */
  redirected: (
    evaluationId: string,
    requestId: string,
    tenantId: string,
    domain: string,
    reason: string,
    clarifyingQuestion: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01122',
      type: 'safety.guardrail.redirected',
      source: 'safety-guardrails',
      status: 'info',
      message: `Request redirected: ${domain} - ${reason}`,
      payload: {
        evaluation_id: evaluationId,
        request_id: requestId,
        tenant_id: tenantId,
        domain,
        reason,
        clarifying_question: clarifyingQuestion,
        redirected_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit blocked event
   */
  blocked: (
    evaluationId: string,
    requestId: string,
    tenantId: string,
    domain: string,
    reason: string,
    userMessage: string,
    alternatives?: string[]
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01122',
      type: 'safety.guardrail.blocked',
      source: 'safety-guardrails',
      status: 'warning',
      message: `Request blocked: ${domain} - ${reason}`,
      payload: {
        evaluation_id: evaluationId,
        request_id: requestId,
        tenant_id: tenantId,
        domain,
        reason,
        user_message: userMessage,
        alternatives,
        blocked_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit rule triggered event
   */
  ruleTriggered: (
    evaluationId: string,
    requestId: string,
    tenantId: string,
    ruleId: string,
    domain: string,
    action: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01122',
      type: 'safety.guardrail.rule.triggered',
      source: 'safety-guardrails',
      status: 'info',
      message: `Rule triggered: ${ruleId} -> ${action}`,
      payload: {
        evaluation_id: evaluationId,
        request_id: requestId,
        tenant_id: tenantId,
        rule_id: ruleId,
        domain,
        action,
        triggered_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit autonomy denied event
   */
  autonomyDenied: (
    evaluationId: string,
    requestId: string,
    tenantId: string,
    domain: string,
    reason: string,
    requestedLevel: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01122',
      type: 'safety.guardrail.autonomy.denied',
      source: 'safety-guardrails',
      status: 'warning',
      message: `Autonomy denied: ${domain} - ${reason}`,
      payload: {
        evaluation_id: evaluationId,
        request_id: requestId,
        tenant_id: tenantId,
        domain,
        reason,
        requested_level: requestedLevel,
        denied_at: new Date().toISOString(),
      },
    }),
};

// =============================================================================
// VTID-01144: D50 Positive Trajectory Reinforcement Event Types
// =============================================================================

/**
 * VTID-01144: Positive Trajectory Reinforcement Event Types
 * These are the event types for the D50 reinforcement engine.
 */
export const REINFORCEMENT_EVENT_TYPES = [
  'd50.eligibility.checked',
  'd50.reinforcement.generated',
  'd50.reinforcement.delivered',
  'd50.reinforcement.dismissed',
  'd50.momentum.computed',
  'd50.trajectory.detected'
] as const;

/**
 * VTID-01144: Positive Trajectory Reinforcement Event Helpers
 * Helper functions for emitting D50 reinforcement events.
 */
export const reinforcementEvents = {
  /**
   * Emit eligibility checked event
   */
  eligibilityChecked: (
    trajectoryTypesChecked: string[],
    eligibleCount: number,
    totalSignalsDerived: number,
    durationMs: number
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01144',
      type: 'd50.eligibility.checked',
      source: 'd50-reinforcement-engine',
      status: 'success',
      message: `Eligibility checked for ${trajectoryTypesChecked.length} trajectory types`,
      payload: {
        trajectory_types_checked: trajectoryTypesChecked,
        eligible_count: eligibleCount,
        total_signals_derived: totalSignalsDerived,
        duration_ms: durationMs,
        checked_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit reinforcement generated event
   */
  reinforcementGenerated: (
    reinforcementId: string,
    trajectoryType: string,
    confidence: number,
    daysSustained: number,
    durationMs: number
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01144',
      type: 'd50.reinforcement.generated',
      source: 'd50-reinforcement-engine',
      status: 'success',
      message: `Reinforcement generated for ${trajectoryType}`,
      payload: {
        reinforcement_id: reinforcementId,
        trajectory_type: trajectoryType,
        confidence,
        days_sustained: daysSustained,
        duration_ms: durationMs,
        generated_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit reinforcement delivered event
   */
  reinforcementDelivered: (
    reinforcementId: string,
    trajectoryType?: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01144',
      type: 'd50.reinforcement.delivered',
      source: 'd50-reinforcement-engine',
      status: 'success',
      message: `Reinforcement delivered`,
      payload: {
        reinforcement_id: reinforcementId,
        trajectory_type: trajectoryType,
        delivered_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit reinforcement dismissed event
   */
  reinforcementDismissed: (
    reinforcementId: string,
    reason: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01144',
      type: 'd50.reinforcement.dismissed',
      source: 'd50-reinforcement-engine',
      status: 'info',
      message: `Reinforcement dismissed`,
      payload: {
        reinforcement_id: reinforcementId,
        reason,
        dismissed_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit momentum computed event
   */
  momentumComputed: (
    overallMomentum: string,
    eligibleCount: number,
    totalTrajectories: number,
    durationMs: number
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01144',
      type: 'd50.momentum.computed',
      source: 'd50-reinforcement-engine',
      status: 'success',
      message: `Momentum state: ${overallMomentum}`,
      payload: {
        overall_momentum: overallMomentum,
        eligible_count: eligibleCount,
        total_trajectories: totalTrajectories,
        duration_ms: durationMs,
        computed_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit trajectory detected event
   */
  trajectoryDetected: (
    trajectoryType: string,
    daysSustained: number,
    confidence: number,
    isPositive: boolean
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01144',
      type: 'd50.trajectory.detected',
      source: 'd50-reinforcement-engine',
      status: 'info',
      message: `${isPositive ? 'Positive' : 'Neutral'} trajectory detected: ${trajectoryType}`,
      payload: {
        trajectory_type: trajectoryType,
        days_sustained: daysSustained,
        confidence,
        is_positive: isPositive,
        detected_at: new Date().toISOString(),
      },
    }),
};

// ==================== VTID-01149: Task Intake Events ====================

export const taskIntakeEvents = {
  /**
   * Emit task creation intent detected event
   */
  taskCreateDetected: (
    sessionId: string,
    surface: 'orb' | 'operator',
    tenant: string = 'vitana'
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01149',
      type: 'autopilot.intent.task_create_detected',
      source: 'task-intake-service',
      status: 'info',
      message: `Task creation intent detected on ${surface}`,
      payload: {
        session_id: sessionId,
        surface,
        tenant,
        detected_at: new Date().toISOString(),
      },
      // VTID-01260: Surface tracking from task intake
      surface: surface,
    }),

  /**
   * Emit intake question asked event
   */
  questionAsked: (
    vtid: string,
    sessionId: string,
    question: 'spec' | 'header',
    surface: 'orb' | 'operator'
  ) =>
    emitOasisEvent({
      vtid,
      type: 'autopilot.task.intake.question_asked',
      source: 'task-intake-service',
      status: 'info',
      message: `Asking ${question} question on ${surface}`,
      payload: {
        session_id: sessionId,
        question,
        surface,
        asked_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit intake answer received event
   */
  answerReceived: (
    vtid: string,
    sessionId: string,
    question: 'spec' | 'header',
    text: string,
    surface: 'orb' | 'operator',
    readyToSchedule: boolean
  ) =>
    emitOasisEvent({
      vtid,
      type: 'autopilot.task.intake.answer_received',
      source: 'task-intake-service',
      status: 'info',
      message: `Received ${question} answer on ${surface}`,
      payload: {
        session_id: sessionId,
        question,
        text,
        surface,
        ready_to_schedule: readyToSchedule,
        received_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit task ready to schedule event
   */
  readyToSchedule: (
    vtid: string,
    header: string,
    specText: string,
    surface: 'orb' | 'operator',
    sessionId: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'autopilot.task.ready_to_schedule',
      source: 'task-intake-service',
      status: 'info',
      message: `Task ready to schedule: ${header}`,
      payload: {
        vtid,
        header,
        spec_text: specText,
        task_family: 'DEV',
        surface,
        session_id: sessionId,
        ready_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit task scheduled event (success)
   */
  taskScheduled: (
    vtid: string,
    header: string,
    operation: 'insert' | 'update' = 'insert'
  ) =>
    emitOasisEvent({
      vtid,
      type: 'commandhub.task.scheduled',
      source: 'task-intake-service',
      status: 'success',
      message: `Task scheduled: ${header}`,
      payload: {
        vtid,
        header,
        task_family: 'DEV',
        status: 'scheduled',
        operation,
        scheduled_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit task schedule failed event (error - does not crash ingestion)
   */
  scheduleFailed: (
    vtid: string,
    error: string
  ) =>
    emitOasisEvent({
      vtid,
      type: 'commandhub.task.schedule_failed',
      source: 'task-intake-service',
      status: 'error',
      message: `Task scheduling failed: ${error}`,
      payload: {
        vtid,
        error,
        failed_at: new Date().toISOString(),
      },
    }),
};

// =============================================================================
// VTID-01160: Task Discovery Governance Event Types
// =============================================================================

/**
 * VTID-01160: Task Discovery Governance Event Types
 * These are the event types for OASIS_ONLY_TASK_TRUTH enforcement.
 */
export const TASK_DISCOVERY_GOVERNANCE_EVENT_TYPES = [
  'governance.violation.oasis_only_task_truth',
  'governance.enforcement.oasis_only_task_truth',
  'governance.validation.task_discovery.passed',
  'governance.validation.task_discovery.blocked',
] as const;

/**
 * VTID-01160: Task Discovery Governance Event Helpers
 * Helper functions for emitting task discovery governance events.
 *
 * HARD GOVERNANCE:
 * - Rule ID: GOV-INTEL-R.1
 * - Name: OASIS_ONLY_TASK_TRUTH
 * - Severity: CRITICAL
 */
export const taskDiscoveryGovernanceEvents = {
  /**
   * Emit governance violation event when non-OASIS task source detected
   *
   * MANDATORY: This event MUST be emitted when any of these conditions occur:
   * 1. Task state query uses non-OASIS source (repo_scan, memory, unknown)
   * 2. Response does not use discover_tasks tool
   * 3. Task IDs do not match VTID-\d{4,5} format
   * 4. Legacy task IDs (DEV-*, ADM-*, AICOR-*) detected in pending list
   */
  violationDetected: (
    surface: 'orb' | 'operator' | 'mcp' | 'other',
    detectedSource: 'repo_scan' | 'memory' | 'unknown',
    requestedQuery: string,
    invalidTaskIds?: string[],
    errorCodes?: string[]
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01160',
      type: 'governance.violation.oasis_only_task_truth',
      source: 'governance-validator',
      status: 'warning',
      message: `BLOCKED: Task status query from ${surface} used non-OASIS source (${detectedSource})`,
      payload: {
        rule_id: 'GOV-INTEL-R.1',
        rule_name: 'OASIS_ONLY_TASK_TRUTH',
        severity: 'CRITICAL',
        status: 'blocked',
        surface,
        detected_source: detectedSource,
        requested_query: requestedQuery,
        retry_action: 'discover_tasks_required',
        invalid_task_ids: invalidTaskIds,
        error_codes: errorCodes,
        violated_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit enforcement event when a task discovery request is blocked
   */
  enforcementBlocked: (
    surface: 'orb' | 'operator' | 'mcp' | 'other',
    reason: string,
    requestedQuery: string,
    userMessage: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01160',
      type: 'governance.enforcement.oasis_only_task_truth',
      source: 'governance-validator',
      status: 'warning',
      message: `Enforcement: Task discovery blocked for ${surface}`,
      payload: {
        rule_id: 'GOV-INTEL-R.1',
        rule_name: 'OASIS_ONLY_TASK_TRUTH',
        action: 'block',
        surface,
        reason,
        requested_query: requestedQuery,
        user_message: userMessage,
        retry_action: 'discover_tasks_required',
        enforced_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit validation passed event for compliant task discovery
   */
  validationPassed: (
    surface: 'orb' | 'operator' | 'mcp' | 'other',
    pendingCount: number,
    requestedQuery: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01160',
      type: 'governance.validation.task_discovery.passed',
      source: 'governance-validator',
      status: 'success',
      message: `Task discovery validation passed for ${surface}`,
      payload: {
        rule_id: 'GOV-INTEL-R.1',
        rule_name: 'OASIS_ONLY_TASK_TRUTH',
        status: 'passed',
        surface,
        source_of_truth: 'OASIS',
        pending_count: pendingCount,
        requested_query: requestedQuery,
        validated_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit validation blocked event with full details
   */
  validationBlocked: (
    surface: 'orb' | 'operator' | 'mcp' | 'other',
    detectedSource: 'oasis' | 'repo_scan' | 'memory' | 'unknown',
    requestedQuery: string,
    errors: Array<{ code: string; message: string; value?: string }>
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01160',
      type: 'governance.validation.task_discovery.blocked',
      source: 'governance-validator',
      status: 'warning',
      message: `Task discovery validation blocked for ${surface}: ${errors.length} error(s)`,
      payload: {
        rule_id: 'GOV-INTEL-R.1',
        rule_name: 'OASIS_ONLY_TASK_TRUTH',
        status: 'blocked',
        surface,
        detected_source: detectedSource,
        requested_query: requestedQuery,
        errors,
        error_count: errors.length,
        retry_action: 'discover_tasks_required',
        blocked_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit legacy ID detection event
   * Used when DEV-*, ADM-*, AICOR-* patterns are found in task responses
   */
  legacyIdDetected: (
    surface: 'orb' | 'operator' | 'mcp' | 'other',
    legacyIds: string[],
    requestedQuery: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01160',
      type: 'governance.violation.oasis_only_task_truth',
      source: 'governance-validator',
      status: 'warning',
      message: `Legacy task IDs detected on ${surface}: ${legacyIds.join(', ')}`,
      payload: {
        rule_id: 'GOV-INTEL-R.1',
        rule_name: 'OASIS_ONLY_TASK_TRUTH',
        violation_type: 'legacy_id_detected',
        severity: 'CRITICAL',
        status: 'blocked',
        surface,
        legacy_ids: legacyIds,
        requested_query: requestedQuery,
        note: 'Legacy IDs may only appear in ignored[] as artifacts, not in pending[]',
        retry_action: 'discover_tasks_required',
        violated_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit invalid VTID format detection event
   */
  invalidVtidFormat: (
    surface: 'orb' | 'operator' | 'mcp' | 'other',
    invalidIds: string[],
    requestedQuery: string
  ) =>
    emitOasisEvent({
      vtid: 'VTID-01160',
      type: 'governance.violation.oasis_only_task_truth',
      source: 'governance-validator',
      status: 'warning',
      message: `Invalid VTID formats detected on ${surface}: ${invalidIds.join(', ')}`,
      payload: {
        rule_id: 'GOV-INTEL-R.1',
        rule_name: 'OASIS_ONLY_TASK_TRUTH',
        violation_type: 'invalid_vtid_format',
        severity: 'CRITICAL',
        status: 'blocked',
        surface,
        invalid_ids: invalidIds,
        expected_format: '^VTID-\\d{4,5}$',
        requested_query: requestedQuery,
        retry_action: 'discover_tasks_required',
        violated_at: new Date().toISOString(),
      },
    }),
};

// =============================================================================
// VTID-01221: Recommendation Sync Events
// =============================================================================
// These events track the recommendation sync between ORB/Operator and Autopilot.
// They provide audit trail and telemetry for the "single brain, multiple surfaces" pattern.

/**
 * VTID-01221: Recommendation Sync Events for Developer Copilot
 */
export const recommendationSyncEvents = {
  /**
   * Emit when recommendations are requested from Autopilot
   * Fired when ORB/Operator calls autopilot_get_recommendations tool
   */
  recommendationsRequested: (
    vtid: string | null,
    context: {
      source: 'orb' | 'operator' | 'api';
      role?: string;
      surface?: string;
      screen?: string;
      user_id?: string;
      thread_id?: string;
    }
  ) =>
    emitOasisEvent({
      vtid: vtid || 'VTID-01221',
      type: 'autopilot.recommendations.requested',
      source: `conversation-${context.source}`,
      status: 'info',
      message: `Recommendations requested from ${context.source}${context.role ? ` by ${context.role}` : ''}`,
      payload: {
        ...context,
        requested_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit when recommendations are successfully received from Autopilot
   */
  recommendationsReceived: (
    vtid: string | null,
    count: number,
    recommendationIds: string[],
    source: 'orb' | 'operator' | 'api',
    durationMs: number
  ) =>
    emitOasisEvent({
      vtid: vtid || 'VTID-01221',
      type: 'autopilot.recommendations.received',
      source: 'autopilot-recommendation-engine',
      status: 'success',
      message: `${count} recommendation(s) received from Autopilot`,
      payload: {
        count,
        recommendation_ids: recommendationIds,
        requester: source,
        duration_ms: durationMs,
        received_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit when recommendations request fails
   * Triggers fallback to deterministic tools
   */
  recommendationsFailed: (
    vtid: string | null,
    error: string,
    source: 'orb' | 'operator' | 'api',
    fallbackTriggered: boolean
  ) =>
    emitOasisEvent({
      vtid: vtid || 'VTID-01221',
      type: 'autopilot.recommendations.failed',
      source: 'autopilot-recommendation-engine',
      status: 'error',
      message: `Failed to fetch recommendations: ${error}`,
      payload: {
        error,
        requester: source,
        fallback_triggered: fallbackTriggered,
        failed_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit when recommendations are presented to the user
   * Tracks which recommendations were shown in which surface
   */
  recommendationPresented: (
    vtid: string | null,
    recommendationIds: string[],
    channel: 'orb' | 'operator' | 'panel',
    format: 'sync-brief' | 'list' | 'inline'
  ) =>
    emitOasisEvent({
      vtid: vtid || 'VTID-01221',
      type: 'dev.recommendation.presented',
      source: `conversation-${channel}`,
      status: 'info',
      message: `Presented ${recommendationIds.length} recommendation(s) via ${channel}`,
      payload: {
        recommendation_ids: recommendationIds,
        channel,
        format,
        presented_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit when user selects/acts on a recommendation
   */
  recommendationSelected: (
    vtid: string | null,
    recommendationId: string,
    action: 'execute' | 'view' | 'copy' | 'dismiss',
    channel: 'orb' | 'operator' | 'panel'
  ) =>
    emitOasisEvent({
      vtid: vtid || 'VTID-01221',
      type: 'dev.recommendation.selected',
      source: 'user-action',
      status: 'info',
      message: `User ${action}d recommendation ${recommendationId}`,
      payload: {
        recommendation_id: recommendationId,
        action,
        channel,
        selected_at: new Date().toISOString(),
      },
    }),

  /**
   * Emit when fallback tools are used (Autopilot unavailable)
   */
  fallbackToolUsed: (
    vtid: string | null,
    toolName: 'oasis_analyze_vtid' | 'dev_verify_deploy_checklist',
    reason: string,
    source: 'orb' | 'operator'
  ) =>
    emitOasisEvent({
      vtid: vtid || 'VTID-01221',
      type: 'dev.fallback.tool_used',
      source: `conversation-${source}`,
      status: 'warning',
      message: `Fallback tool ${toolName} used: ${reason}`,
      payload: {
        tool_name: toolName,
        reason,
        requester: source,
        used_at: new Date().toISOString(),
      },
    }),
};

// Event type constants for VTID-01221
export const RECOMMENDATION_SYNC_EVENT_TYPES = [
  'autopilot.recommendations.requested',
  'autopilot.recommendations.received',
  'autopilot.recommendations.failed',
  'dev.recommendation.presented',
  'dev.recommendation.selected',
  'dev.fallback.tool_used',
];

export default cicdEvents;
