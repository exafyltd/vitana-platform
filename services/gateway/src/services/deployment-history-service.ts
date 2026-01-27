/**
 * Deployment History Service - VTID-01212
 *
 * Provides enriched deployment history with:
 * - VTID traceability
 * - Deployment provenance (Autopilot vs Manual vs CI)
 * - Validation Engine approval status
 * - Pipeline stage evidence (PL/WO/VA/DE)
 * - Composite health indicator
 */

import { randomUUID } from 'crypto';

// ==================== Types ====================

export type TriggerSource = 'AUTOPILOT' | 'MANUAL' | 'CI' | 'UNKNOWN';
export type ValidationStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'UNKNOWN';
export type GovernanceStatus = 'APPROVED' | 'BLOCKED' | 'UNKNOWN';
export type HealthStatus = 'trusted' | 'warning' | 'failed' | 'unknown';
export type PipelineStageStatus = 'passed' | 'failed' | 'unknown';
export type DeploymentOutcome = 'success' | 'failure' | 'rolled_back';

export interface PipelineStage {
  status: PipelineStageStatus;
  started_at?: string;
  completed_at?: string;
  event_id?: string;
}

export interface PipelineEvidence {
  planner: PipelineStage;
  worker: PipelineStage;
  validator: PipelineStage;
  deploy: PipelineStage;
}

export interface DeploymentEvidence {
  oasis_event_ids: string[];
  pr_number?: number;
  merge_sha?: string;
  workflow_run_id?: number;
  deploy_topic?: string;
  validation_topic?: string;
}

export interface EnrichedDeployment {
  deploy_id: string;
  service: string;
  timestamp: string;
  outcome: DeploymentOutcome;

  vtid: string | null;
  env: string;

  trigger_source: TriggerSource;
  triggered_by: string;

  validation_status: ValidationStatus;
  governance_status: GovernanceStatus;
  governance_level?: string;

  health: HealthStatus;

  pipeline: PipelineEvidence;
  evidence: DeploymentEvidence;
}

export interface DeploymentHistoryResponse {
  ok: boolean;
  items: EnrichedDeployment[];
  next_cursor: string | null;
  total_count?: number;
  error?: string;
}

export interface DeploymentHistoryParams {
  limit?: number;
  cursor?: string;
  health?: string; // comma-separated: trusted,warning,failed
  trigger?: string; // comma-separated: AUTOPILOT,MANUAL,CI
  search?: string;
  days?: number;
}

export interface DeploymentEventsResponse {
  ok: boolean;
  events: OasisEventSummary[];
  error?: string;
}

export interface OasisEventSummary {
  id: string;
  created_at: string;
  topic: string;
  status: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// ==================== Evidence Derivation Rules ====================

/**
 * Derive trigger source from deployment and event data
 * VTID-01212: Deterministic derivation rules
 */
function deriveTriggerSource(
  initiator: string | undefined,
  metadata: Record<string, unknown> | null
): TriggerSource {
  // Check for autopilot indicators
  if (metadata?.autopilot_run_id) {
    return 'AUTOPILOT';
  }

  const topic = metadata?.topic as string || '';
  if (topic.includes('autopilot.')) {
    return 'AUTOPILOT';
  }

  // Check for CI indicators
  const source = metadata?.source as string || '';
  if (initiator === 'agent' && (source.includes('github') || source.includes('ci'))) {
    return 'CI';
  }

  if (metadata?.github_actor || metadata?.workflow_run_id) {
    return 'CI';
  }

  // Manual deployment
  if (initiator === 'user' || source === 'operator.console.chat') {
    return 'MANUAL';
  }

  // Default based on initiator
  if (initiator === 'agent') {
    return 'CI';
  }

  return 'MANUAL';
}

/**
 * Derive triggered by identity from deployment and event data
 * VTID-01212: Deterministic derivation rules
 */
function deriveTriggeredBy(
  triggerSource: TriggerSource,
  initiator: string | undefined,
  metadata: Record<string, unknown> | null
): string {
  // For MANUAL: user identifier
  if (triggerSource === 'MANUAL') {
    const actor = metadata?.actor as string;
    const email = metadata?.email as string;
    if (actor) return actor;
    if (email) return email;
    if (initiator === 'user') return 'user';
    return 'unknown';
  }

  // For AUTOPILOT: autopilot identifiers
  if (triggerSource === 'AUTOPILOT') {
    const runId = metadata?.autopilot_run_id as string;
    const workerId = metadata?.worker_id as string;
    if (runId) return `autopilot:${runId}`;
    if (workerId) return `worker:${workerId}`;
    return 'autopilot';
  }

  // For CI: github actor or workflow
  if (triggerSource === 'CI') {
    const githubActor = metadata?.github_actor as string;
    const workflowId = metadata?.workflow_run_id as number;
    if (githubActor) return githubActor;
    if (workflowId) return `workflow:${workflowId}`;
    return 'CI/CD';
  }

  return 'unknown';
}

/**
 * Derive validation status from OASIS events
 * VTID-01212: Deterministic derivation rules
 */
function deriveValidationStatus(
  validationEvents: Array<{ topic: string; status: string }>
): ValidationStatus {
  if (!validationEvents || validationEvents.length === 0) {
    return 'UNKNOWN';
  }

  // Find the most recent validation event
  for (const event of validationEvents) {
    if (event.topic.includes('validation.passed') || event.status === 'passed') {
      return 'PASSED';
    }
    if (event.topic.includes('validation.failed') || event.status === 'failed') {
      return 'FAILED';
    }
    if (event.topic.includes('validation.skipped') || event.status === 'skipped') {
      return 'SKIPPED';
    }
  }

  return 'UNKNOWN';
}

/**
 * Derive governance status from validation status and governance events
 * VTID-01212: Deterministic derivation rules
 */
function deriveGovernanceStatus(
  validationStatus: ValidationStatus,
  governanceEvents: Array<{ topic: string; status: string }>
): { status: GovernanceStatus; level?: string } {
  // Check explicit governance events first
  if (governanceEvents && governanceEvents.length > 0) {
    for (const event of governanceEvents) {
      if (event.topic.includes('governance.deploy.allowed') || event.topic.includes('approved')) {
        return { status: 'APPROVED', level: 'L1' };
      }
      if (event.topic.includes('governance.deploy.blocked') || event.topic.includes('blocked')) {
        return { status: 'BLOCKED' };
      }
    }
  }

  // Implicit derivation from validation status
  if (validationStatus === 'PASSED') {
    return { status: 'APPROVED', level: 'L1' };
  }

  if (validationStatus === 'FAILED') {
    return { status: 'BLOCKED' };
  }

  return { status: 'UNKNOWN' };
}

/**
 * Derive composite health status
 * VTID-01212: Deterministic derivation rules
 *
 * TRUSTED (green): VTID present + validation PASSED + governance APPROVED + outcome SUCCESS
 * WARNING (yellow): Missing VTID OR validation SKIPPED/UNKNOWN OR governance UNKNOWN (but outcome SUCCESS)
 * FAILED (red): Validation FAILED OR governance BLOCKED OR outcome FAILED/ROLLED_BACK
 * UNKNOWN (gray): Insufficient evidence
 */
function deriveHealth(
  vtid: string | null,
  outcome: DeploymentOutcome,
  validationStatus: ValidationStatus,
  governanceStatus: GovernanceStatus
): HealthStatus {
  // Failed outcomes always result in failed health
  if (outcome === 'failure' || outcome === 'rolled_back') {
    return 'failed';
  }

  // Validation/governance failures
  if (validationStatus === 'FAILED' || governanceStatus === 'BLOCKED') {
    return 'failed';
  }

  // Missing VTID is a warning
  if (!vtid) {
    return 'warning';
  }

  // Unknown/skipped validation is a warning
  if (validationStatus === 'SKIPPED' || validationStatus === 'UNKNOWN') {
    return 'warning';
  }

  // Unknown governance is a warning
  if (governanceStatus === 'UNKNOWN') {
    return 'warning';
  }

  // All conditions met for trusted
  if (validationStatus === 'PASSED' && governanceStatus === 'APPROVED') {
    return 'trusted';
  }

  return 'warning';
}

/**
 * Derive pipeline stage evidence from OASIS events
 */
function derivePipelineStages(
  events: Array<{ topic: string; status: string; created_at: string; id: string }>
): PipelineEvidence {
  const pipeline: PipelineEvidence = {
    planner: { status: 'unknown' },
    worker: { status: 'unknown' },
    validator: { status: 'unknown' },
    deploy: { status: 'unknown' }
  };

  for (const event of events) {
    const topic = event.topic.toLowerCase();

    // Planner stage
    if (topic.includes('planner') || topic.includes('plan.')) {
      if (event.status === 'success' || topic.includes('.completed') || topic.includes('.success')) {
        pipeline.planner = {
          status: 'passed',
          completed_at: event.created_at,
          event_id: event.id
        };
      } else if (event.status === 'error' || event.status === 'failure' || topic.includes('.failed')) {
        pipeline.planner = { status: 'failed', completed_at: event.created_at, event_id: event.id };
      }
    }

    // Worker stage
    if (topic.includes('worker') || topic.includes('orchestrator')) {
      if (event.status === 'success' || topic.includes('.completed') || topic.includes('.success')) {
        pipeline.worker = {
          status: 'passed',
          completed_at: event.created_at,
          event_id: event.id
        };
      } else if (event.status === 'error' || event.status === 'failure' || topic.includes('.failed')) {
        pipeline.worker = { status: 'failed', completed_at: event.created_at, event_id: event.id };
      }
    }

    // Validator stage
    if (topic.includes('validator') || topic.includes('validation')) {
      if (event.status === 'success' || topic.includes('.passed') || topic.includes('.success')) {
        pipeline.validator = {
          status: 'passed',
          completed_at: event.created_at,
          event_id: event.id
        };
      } else if (event.status === 'error' || event.status === 'failure' || topic.includes('.failed')) {
        pipeline.validator = { status: 'failed', completed_at: event.created_at, event_id: event.id };
      }
    }

    // Deploy stage
    if (topic.includes('deploy.') && !topic.includes('version.recorded')) {
      if (event.status === 'success' || topic.includes('.success') || topic.includes('.completed')) {
        pipeline.deploy = {
          status: 'passed',
          completed_at: event.created_at,
          event_id: event.id
        };
      } else if (event.status === 'error' || event.status === 'failure' || topic.includes('.failed')) {
        pipeline.deploy = { status: 'failed', completed_at: event.created_at, event_id: event.id };
      }
    }
  }

  return pipeline;
}

// ==================== Database Queries ====================

/**
 * Get enriched deployment history
 * VTID-01212: Main API function
 */
export async function getEnrichedDeploymentHistory(
  params: DeploymentHistoryParams
): Promise<DeploymentHistoryResponse> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[VTID-01212] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    return { ok: false, items: [], next_cursor: null, error: 'Database not configured' };
  }

  const limit = Math.min(params.limit || 50, 200);
  const days = params.days || 7;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  try {
    // Step 1: Get software versions
    let versionsUrl = `${supabaseUrl}/rest/v1/software_versions?select=swv_id,created_at,git_commit,status,initiator,deploy_type,service,environment&order=created_at.desc&limit=${limit}`;

    // Add date filter
    versionsUrl += `&created_at=gte.${cutoffDate.toISOString()}`;

    // Handle cursor-based pagination
    if (params.cursor) {
      try {
        const cursorData = JSON.parse(Buffer.from(params.cursor, 'base64').toString());
        if (cursorData.ts) {
          versionsUrl += `&created_at=lt.${cursorData.ts}`;
        }
      } catch {
        console.warn('[VTID-01212] Invalid cursor, ignoring');
      }
    }

    const versionsResponse = await fetch(versionsUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    if (!versionsResponse.ok) {
      const errorText = await versionsResponse.text();
      console.error(`[VTID-01212] Failed to fetch software versions: ${versionsResponse.status} - ${errorText}`);
      return { ok: false, items: [], next_cursor: null, error: 'Database query failed' };
    }

    const versions = await versionsResponse.json() as Array<{
      swv_id: string;
      created_at: string;
      git_commit: string;
      status: string;
      initiator: string;
      deploy_type: string;
      service: string;
      environment: string;
    }>;

    if (!versions || versions.length === 0) {
      return { ok: true, items: [], next_cursor: null, total_count: 0 };
    }

    // Step 2: Get OASIS events for VTID correlation and evidence
    // Query events related to deployments (deploy, validation, governance topics)
    const eventsUrl = `${supabaseUrl}/rest/v1/oasis_events?select=id,vtid,topic,status,message,metadata,created_at&order=created_at.desc&limit=500&created_at=gte.${cutoffDate.toISOString()}`;

    const eventsResponse = await fetch(eventsUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    let allEvents: Array<{
      id: string;
      vtid: string;
      topic: string;
      status: string;
      message: string;
      metadata: Record<string, unknown> | null;
      created_at: string;
    }> = [];

    if (eventsResponse.ok) {
      allEvents = await eventsResponse.json() as typeof allEvents;
    } else {
      console.warn('[VTID-01212] Could not fetch OASIS events, continuing without enrichment');
    }

    // Build maps for efficient lookup
    const swvToVtidMap = new Map<string, string>();
    const vtidToEventsMap = new Map<string, typeof allEvents>();

    // Map swv_id to vtid from version.recorded events
    for (const event of allEvents) {
      const eventSwvId = event.metadata?.swv_id as string;
      if (eventSwvId && event.topic === 'cicd.deploy.version.recorded') {
        if (!swvToVtidMap.has(eventSwvId)) {
          swvToVtidMap.set(eventSwvId, event.vtid);
        }
      }

      // Group events by vtid
      if (event.vtid) {
        const existing = vtidToEventsMap.get(event.vtid) || [];
        existing.push(event);
        vtidToEventsMap.set(event.vtid, existing);
      }
    }

    // Step 3: Enrich each deployment
    const enrichedItems: EnrichedDeployment[] = [];

    for (const version of versions) {
      const vtid = swvToVtidMap.get(version.swv_id) || null;
      const relatedEvents = vtid ? (vtidToEventsMap.get(vtid) || []) : [];

      // Find validation events
      const validationEvents = relatedEvents.filter(e =>
        e.topic.includes('validation') || e.topic.includes('validator')
      );

      // Find governance events
      const governanceEvents = relatedEvents.filter(e =>
        e.topic.includes('governance')
      );

      // Get metadata from the most recent deploy event
      const deployEvent = relatedEvents.find(e =>
        e.topic.includes('deploy') && e.metadata?.swv_id === version.swv_id
      );
      const metadata = deployEvent?.metadata || null;

      // Derive all fields
      const triggerSource = deriveTriggerSource(version.initiator, metadata);
      const triggeredBy = deriveTriggeredBy(triggerSource, version.initiator, metadata);
      const validationStatus = deriveValidationStatus(validationEvents);
      const { status: governanceStatus, level: governanceLevel } = deriveGovernanceStatus(
        validationStatus,
        governanceEvents
      );

      const outcome: DeploymentOutcome =
        version.status === 'failure' ? 'failure' :
        version.deploy_type === 'rollback' ? 'rolled_back' : 'success';

      const health = deriveHealth(vtid, outcome, validationStatus, governanceStatus);

      const pipeline = derivePipelineStages(relatedEvents);

      // Build evidence object
      const evidence: DeploymentEvidence = {
        oasis_event_ids: relatedEvents.map(e => e.id),
        pr_number: metadata?.pr_number as number | undefined,
        merge_sha: metadata?.merge_sha as string | undefined,
        workflow_run_id: metadata?.workflow_run_id as number | undefined,
        deploy_topic: deployEvent?.topic,
        validation_topic: validationEvents[0]?.topic
      };

      const enriched: EnrichedDeployment = {
        deploy_id: version.swv_id,
        service: version.service,
        timestamp: version.created_at,
        outcome,
        vtid,
        env: version.environment,
        trigger_source: triggerSource,
        triggered_by: triggeredBy,
        validation_status: validationStatus,
        governance_status: governanceStatus,
        governance_level: governanceLevel,
        health,
        pipeline,
        evidence
      };

      enrichedItems.push(enriched);
    }

    // Step 4: Apply filters
    let filteredItems = enrichedItems;

    // Health filter
    if (params.health) {
      const healthFilters = params.health.split(',').map(h => h.trim().toLowerCase());
      filteredItems = filteredItems.filter(item => healthFilters.includes(item.health));
    }

    // Trigger filter
    if (params.trigger) {
      const triggerFilters = params.trigger.split(',').map(t => t.trim().toUpperCase());
      filteredItems = filteredItems.filter(item => triggerFilters.includes(item.trigger_source));
    }

    // Search filter
    if (params.search) {
      const searchTerm = params.search.toLowerCase();
      filteredItems = filteredItems.filter(item =>
        (item.vtid && item.vtid.toLowerCase().includes(searchTerm)) ||
        item.service.toLowerCase().includes(searchTerm) ||
        item.deploy_id.toLowerCase().includes(searchTerm) ||
        item.triggered_by.toLowerCase().includes(searchTerm)
      );
    }

    // Generate next cursor
    let nextCursor: string | null = null;
    if (versions.length === limit) {
      const lastItem = versions[versions.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ ts: lastItem.created_at })).toString('base64');
    }

    console.log(`[VTID-01212] Returning ${filteredItems.length} enriched deployments`);

    return {
      ok: true,
      items: filteredItems,
      next_cursor: nextCursor,
      total_count: filteredItems.length
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01212] Error fetching enriched deployment history: ${errorMessage}`);
    return { ok: false, items: [], next_cursor: null, error: errorMessage };
  }
}

/**
 * Get OASIS events for a specific deployment
 * VTID-01212: Detail endpoint
 */
export async function getDeploymentEvents(
  deployId: string,
  limit: number = 20
): Promise<DeploymentEventsResponse> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, events: [], error: 'Database not configured' };
  }

  try {
    // First, find the VTID for this deploy_id
    const versionUrl = `${supabaseUrl}/rest/v1/oasis_events?select=vtid&topic=eq.cicd.deploy.version.recorded&metadata->>swv_id=eq.${deployId}&limit=1`;

    const versionResponse = await fetch(versionUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    let vtid: string | null = null;
    if (versionResponse.ok) {
      const versionData = await versionResponse.json() as Array<{ vtid: string }>;
      vtid = versionData[0]?.vtid || null;
    }

    if (!vtid) {
      // No VTID found, return empty events
      return { ok: true, events: [] };
    }

    // Get events for this VTID
    const eventsUrl = `${supabaseUrl}/rest/v1/oasis_events?select=id,created_at,topic,status,message,metadata&vtid=eq.${vtid}&order=created_at.desc&limit=${limit}`;

    const eventsResponse = await fetch(eventsUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    if (!eventsResponse.ok) {
      const errorText = await eventsResponse.text();
      return { ok: false, events: [], error: `Failed to fetch events: ${errorText}` };
    }

    const events = await eventsResponse.json() as OasisEventSummary[];

    return { ok: true, events };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01212] Error fetching deployment events: ${errorMessage}`);
    return { ok: false, events: [], error: errorMessage };
  }
}

export default {
  getEnrichedDeploymentHistory,
  getDeploymentEvents
};
