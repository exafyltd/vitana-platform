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
    'governance.violated'
] as const;

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

export default cicdEvents;
