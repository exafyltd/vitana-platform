/**
 * CICD Types - VTID-0516 Autonomous Safe-Merge Layer
 * Type definitions for GitHub PR, Safe-Merge, and Deploy operations
 */

import { z } from 'zod';

// ==================== Create PR ====================
export const CreatePrRequestSchema = z.object({
  vtid: z.string().min(1, 'VTID is required'),
  branch: z.string().optional(), // Can be auto-generated if missing
  title: z.string().min(1, 'PR title is required'),
  body: z.string().min(1, 'PR body/description is required'),
  base: z.string().default('main'),
  head: z.string().min(1, 'Head branch is required'),
});

export type CreatePrRequest = z.infer<typeof CreatePrRequestSchema>;

export interface CreatePrResponse {
  ok: boolean;
  pr_number?: number;
  pr_url?: string;
  vtid: string;
  error?: string;
  details?: Record<string, unknown>;
}

// ==================== Safe Merge ====================
export const SafeMergeRequestSchema = z.object({
  vtid: z.string().min(1, 'VTID is required'),
  repo: z.string().default('exafyltd/vitana-platform'),
  pr_number: z.number().int().positive('PR number must be a positive integer'),
  require_checks: z.boolean().default(true),
  merge_strategy: z.enum(['squash', 'merge', 'rebase']).default('squash'),
});

export type SafeMergeRequest = z.infer<typeof SafeMergeRequestSchema>;

export interface SafeMergeResponse {
  ok: boolean;
  merged?: boolean;
  branch?: string;
  repo?: string;
  vtid: string;
  reason?: string;
  details?: {
    pr_state?: string;
    base?: string;
    head?: string;
    checks?: CheckStatus[];
    files_touched?: string[];
    services_impacted?: string[];
    governance_decision?: 'approved' | 'blocked';
  };
  next?: {
    can_auto_deploy: boolean;
    service: string;
    environment: string;
  };
}

export interface CheckStatus {
  name: string;
  status: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped';
  conclusion?: string;
}

// ==================== Deploy Service ====================
export const DeployServiceRequestSchema = z.object({
  vtid: z.string().min(1, 'VTID is required'),
  service: z.string().min(1, 'Service name is required'),
  environment: z.enum(['dev'], { errorMap: () => ({ message: "Only 'dev' environment is allowed" }) }),
  trigger_workflow: z.boolean().default(true),
});

export type DeployServiceRequest = z.infer<typeof DeployServiceRequestSchema>;

export interface DeployServiceResponse {
  ok: boolean;
  status: 'queued' | 'blocked' | 'failed';
  vtid: string;
  service?: string;
  environment?: string;
  workflow_run_id?: number;
  workflow_url?: string;
  error?: string;
  details?: Record<string, unknown>;
}

// ==================== PR Details from GitHub ====================
export interface GitHubPullRequest {
  number: number;
  state: 'open' | 'closed' | 'merged';
  title: string;
  body: string | null;
  base: {
    ref: string;
    sha: string;
  };
  head: {
    ref: string;
    sha: string;
  };
  mergeable: boolean | null;
  mergeable_state: string;
  html_url: string;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
}

export interface GitHubCombinedStatus {
  state: 'success' | 'failure' | 'pending';
  statuses: Array<{
    context: string;
    state: 'success' | 'failure' | 'pending' | 'error';
    description: string | null;
  }>;
}

// ==================== Governance ====================
export interface GovernanceEvaluation {
  decision: 'approved' | 'blocked';
  vtid: string;
  files_touched: string[];
  services_impacted: string[];
  blocked_reasons: string[];
  timestamp: string;
}

// ==================== OASIS Events ====================
export type CicdEventType =
  | 'cicd.github.create_pr.requested'
  | 'cicd.github.create_pr.succeeded'
  | 'cicd.github.create_pr.failed'
  | 'cicd.github.create_pr.skipped_existing' // VTID-01031: PR reuse path
  | 'cicd.github.find_pr.requested'          // VTID-01031: Find existing PR
  | 'cicd.github.find_pr.succeeded'          // VTID-01031: Existing PR found
  | 'cicd.github.safe_merge.requested'
  | 'cicd.github.safe_merge.evaluated'
  | 'cicd.github.safe_merge.approved'
  | 'cicd.github.safe_merge.blocked'
  | 'cicd.github.safe_merge.executed'
  | 'cicd.deploy.service.requested'
  | 'cicd.deploy.service.accepted'
  | 'cicd.deploy.service.blocked'
  | 'cicd.deploy.service.succeeded'
  | 'cicd.deploy.service.failed'
  | 'cicd.deploy.service.validated'
  | 'cicd.deploy.version.recorded'  // VTID-0510: Software version recorded
  // DEV-OASIS-0210: Deploy gateway events for Command Hub UI
  | 'deploy.gateway.success'
  | 'deploy.gateway.failed'
  // VTID-0407: Governance deploy enforcement events
  | 'governance.deploy.blocked'
  | 'governance.deploy.allowed'
  // DEV-OASIS-0210: Governance evaluation events
  | 'governance.evaluation'
  // VTID-0536: Gemini Operator Tools Bridge events
  | 'assistant.turn'
  // VTID-0150-B: Assistant Core events
  | 'assistant.session.started'
  | 'autopilot.intent.created'
  | 'autopilot.intent.approved'
  | 'autopilot.intent.rejected'
  | 'autopilot.intent.executed'
  | 'governance.evaluate'
  | 'vtid.created'
  | 'autopilot.status.requested'
  | 'autopilot.list.requested'
  // VTID-0151: Assistant Core v2 Multimodal events
  | 'assistant.live.started'
  | 'assistant.live.frame'
  | 'assistant.live.audio'
  // VTID-0538: Knowledge Hub events
  | 'knowledge.search'
  | 'knowledge.search.success'
  | 'knowledge.search.error'
  // VTID-0601: Autonomous Safe Merge & Deploy Control
  | 'cicd.merge.requested'
  | 'cicd.merge.success'
  | 'cicd.merge.failed'
  | 'cicd.deploy.requested'
  | 'cicd.deploy.started'
  | 'cicd.approval.created'
  | 'cicd.approval.approved'
  | 'cicd.approval.denied'
  // VTID-01005: Terminal Lifecycle Events (MANDATORY for governance compliance)
  | 'vtid.lifecycle.completed'
  | 'vtid.lifecycle.failed'
  // VTID-01018: Operator Action Lifecycle Events (MANDATORY for hard contract)
  | 'operator.action.started'
  | 'operator.action.completed'
  | 'operator.action.failed'
  // VTID-0135: ORB Voice Conversation Events
  | 'orb.session.started'
  | 'orb.turn.received'
  | 'orb.turn.responded'
  | 'orb.session.ended'
  // VTID-01039: ORB Conversation Aggregation
  | 'orb.session.summary'
  // VTID-01032: Multi-service deploy selection event
  | 'cicd.deploy.selection'
  // VTID-01033: CICD Concurrency Lock Events
  | 'cicd.lock.acquire.requested'
  | 'cicd.lock.acquire.succeeded'
  | 'cicd.lock.acquire.blocked'
  | 'cicd.lock.released'
  | 'cicd.lock.expired'
  // VTID-01063: Route Guard Events
  | 'governance.route.duplicate.detected'
  // VTID-01103: Health Compute Engine Events
  | 'health.compute.features_daily'
  | 'health.compute.vitana_index'
  | 'health.recommendations.refresh'
  | 'health.compute.error'
  // VTID-01105: Memory Write Events
  | 'memory.write'
  | 'memory.read'
  | 'memory.write.user_message'
  | 'memory.write.assistant_message'
  // VTID-01106: ORB Memory Bridge Events
  | 'orb.memory.context_fetched'
  | 'orb.memory.context_injected'
  // VTID-01115: Memory Relevance Scoring Events
  | 'orb.memory.scored_context_fetched'
  | 'memory.scoring.completed'
  | 'memory.scoring.excluded'
  | 'memory.scoring.sensitive_flagged'
  // VTID-01107: ORB Memory Debug Events
  | 'orb.memory.debug_requested'
  | 'orb.memory.debug_snapshot'
  // VTID-01096: Cross-Domain Personalization Events
  | 'personalization.snapshot.read'
  | 'personalization.applied'
  | 'personalization.audit.written'
  // VTID-01095: Daily Scheduler Events
  | 'vtid.daily_recompute.started'
  | 'vtid.stage.longevity.success'
  | 'vtid.stage.longevity.failed'
  | 'vtid.stage.topics.success'
  | 'vtid.stage.topics.failed'
  | 'vtid.stage.community_recs.success'
  | 'vtid.stage.community_recs.failed'
  | 'vtid.stage.matches.success'
  | 'vtid.stage.matches.failed'
  | 'vtid.daily_recompute.completed'  // Terminal success
  | 'vtid.daily_recompute.failed'     // Terminal failure
  // VTID-01109: ORB Conversation Persistence Events
  | 'orb.conversation.restored'
  | 'orb.conversation.saved'
  | 'orb.conversation.cleared'
  // VTID-01086: Memory Garden Events
  | 'memory.garden.progress.read'
  | 'memory.garden.ui.refreshed'
  | 'memory.garden.longevity_panel.read'
  // VTID-01087: Relationship Graph Memory Events
  | 'relationship.edge.created'
  | 'relationship.edge.strengthened'
  | 'relationship.graph.read'
  | 'relationship.recommendation.generated'
  | 'relationship.signal.updated'
  | 'relationship.node.created'
  // VTID-01090: Live Rooms + Events as Relationship Nodes
  | 'live.room.created'
  | 'live.room.started'
  | 'live.room.joined'
  | 'live.room.left'
  | 'live.room.ended'
  | 'live.highlight.created'
  | 'meetup.rsvp.updated'
  // VTID-01097: Diary Template Events
  | 'diary.template.shown'
  | 'diary.template.submitted'
  | 'memory.garden.extract.triggered'
  // VTID-01099: Memory Governance Events
  | 'memory.visibility.updated'
  | 'memory.locked'
  | 'memory.unlocked'
  | 'memory.deleted'
  | 'memory.export.requested'
  | 'memory.export.ready'
  // VTID-01117: Context Window Management Events
  | 'orb.context.window_selected'
  // VTID-01118: Cross-Turn State & Continuity Engine Events
  | 'orb.state.snapshot'
  // VTID-01120: D28 Emotional & Cognitive Signal Events
  | 'd28.signal.computed'
  | 'd28.signal.compute.failed'
  | 'd28.signal.overridden'
  // VTID-01122: Safety Guardrail Events
  | 'safety.guardrail.evaluated'
  | 'safety.guardrail.allowed'
  | 'safety.guardrail.restricted'
  | 'safety.guardrail.redirected'
  | 'safety.guardrail.blocked'
  | 'safety.guardrail.rule.triggered'
  | 'safety.guardrail.autonomy.denied'
  // VTID-01123: Response Framing & Delivery Control Events
  | 'response.framing.computed'
  | 'response.framing.applied'
  | 'response.framing.override'
  // VTID-01127: D33 Availability, Time-Window & Readiness Engine Events
  | 'd33.availability.computed'
  | 'd33.availability.override'
  | 'd33.readiness.risk_flagged'
  | 'd33.action_depth.applied'
  | 'd33.guardrail.enforced'
  // VTID-01128: D34 Environmental, Location & Mobility Context Engine Events
  | 'd34.context.computed'
  | 'd34.context.cached'
  | 'd34.context.override'
  | 'd34.context.fallback'
  | 'd34.filter.applied'
  | 'd34.filter.rejected'
  | 'd34.error'
  // VTID-01129: D35 Social Context, Relationship Weighting & Proximity Engine Events
  | 'd35.context.computed'
  | 'd35.context.compute.failed'
  | 'd35.proximity.scored'
  | 'd35.comfort.updated'
  | 'd35.action.filtered'
  | 'd35.boundary.respected'
  | 'd35.api.request'
  | 'd35.api.error'
  // VTID-01130: D36 Financial Sensitivity & Monetization Readiness Events
  | 'd36.monetization.context.computed'
  | 'd36.monetization.context.failed'
  | 'd36.monetization.attempt.recorded';

export interface CicdOasisEvent {
  vtid: string;
  type: CicdEventType;
  source: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  payload?: Record<string, unknown>;
}

// ==================== Allowed Services for Deploy ====================
export const ALLOWED_DEPLOY_SERVICES = ['gateway', 'oasis-operator', 'oasis-projector'] as const;
export type AllowedDeployService = typeof ALLOWED_DEPLOY_SERVICES[number];

// ==================== VTID-0601: Autonomous Safe Merge & Deploy Control ====================

/**
 * VTID-0601: Approval item representing a pending PR or deploy request
 */
export interface ApprovalItem {
  id: string;
  type: 'merge' | 'deploy' | 'merge+deploy';
  vtid: string;
  pr_number?: number;
  branch?: string;
  service?: string;
  environment?: string;
  commit_sha?: string;
  governance_status: 'pass' | 'fail' | 'pending' | 'unknown';
  ci_status: 'pass' | 'fail' | 'pending' | 'unknown';
  requester: string;
  created_at: string;
  pr_url?: string;
  pr_title?: string;
}

/**
 * VTID-0601: Merge request schema for Command Hub approvals
 */
export const CicdMergeRequestSchema = z.object({
  vtid: z.string().min(1, 'VTID is required'),
  pr_number: z.number().int().positive('PR number must be a positive integer'),
  repo: z.string().default('exafyltd/vitana-platform'),
});

export type CicdMergeRequest = z.infer<typeof CicdMergeRequestSchema>;

export interface CicdMergeResponse {
  ok: boolean;
  merged?: boolean;
  sha?: string;
  vtid: string;
  pr_number: number;
  error?: string;
  reason?: string;
}

/**
 * VTID-0601: Deploy request schema for Command Hub approvals
 */
export const CicdDeployRequestSchema = z.object({
  vtid: z.string().min(1, 'VTID is required'),
  service: z.enum(['gateway', 'oasis-operator', 'oasis-projector'], {
    errorMap: () => ({ message: "Service must be 'gateway', 'oasis-operator', or 'oasis-projector'" })
  }),
  environment: z.enum(['dev'], {
    errorMap: () => ({ message: "Only 'dev' environment is allowed" })
  }),
});

export type CicdDeployRequest = z.infer<typeof CicdDeployRequestSchema>;

export interface CicdDeployResponse {
  ok: boolean;
  vtid: string;
  service: string;
  environment: string;
  workflow_url?: string;
  workflow_run_id?: number;
  error?: string;
}

/**
 * VTID-0601: Approval action request schema
 * VTID-0602: Added optional vtid and reason fields with passthrough
 * VTID-0603: Schema accepts vtid/reason; handler reads directly from req.body
 */
export const ApprovalActionRequestSchema = z.object({
  action: z.enum(['merge', 'deploy', 'merge+deploy']).optional(),
  reason: z.string().optional(),
  vtid: z.string().optional(),
}).passthrough();

export type ApprovalActionRequest = z.infer<typeof ApprovalActionRequestSchema>;

// ==================== Governance Rules ====================
export const BLOCKED_FILE_PATTERNS = [
  /\.env(\..+)?$/,           // Environment files
  /secrets?\//i,             // Secrets directories
  /credentials?/i,           // Credential files
  /\.key$/,                  // Key files
  /\.pem$/,                  // PEM certificates
  /gcp.*\.json$/i,           // GCP service account keys
  /firebase.*\.json$/i,      // Firebase configs
] as const;

export const SENSITIVE_PATHS = [
  'production/',
  'prod/',
  '.github/workflows/',      // Workflow modifications need extra review
] as const;

// ==================== VTID-01018: Operator Action Hard Contract ====================
// Canonical event payload structure with MANDATORY fields.
// Backend MUST reject any action if any required field is missing.

/**
 * VTID-01018: Operator action status - exactly one terminal state required
 */
export type OperatorActionStatus = 'started' | 'completed' | 'failed';

/**
 * VTID-01018: Operator action types for command classification
 */
export type OperatorActionType =
  | 'deploy'
  | 'chat'
  | 'upload'
  | 'task_create'
  | 'command'
  | 'repair'
  | 'session';

/**
 * VTID-01018: Canonical operator action event payload
 * ALL fields are MANDATORY unless explicitly marked nullable.
 * Backend rejects the action if any required field is missing.
 */
export interface OperatorActionEventPayload {
  /** VTID this action relates to (nullable if not task-bound) */
  vtid: string | null;
  /** Unique ID for this action execution */
  operator_action_id: string;
  /** ID of the operator performing the action */
  operator_id: string;
  /** Role of the operator */
  operator_role: 'operator' | 'admin' | 'system';
  /** Classification of the action */
  action_type: OperatorActionType;
  /** SHA-256 hash of the action payload for verification */
  action_payload_hash: string;
  /** Current action status */
  status: OperatorActionStatus;
  /** Source of this event - always 'operator' */
  source: 'operator';
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Action-specific payload data */
  payload?: Record<string, unknown>;
}

/**
 * VTID-01018: Zod schema for hard validation of operator action events
 */
export const OperatorActionEventPayloadSchema = z.object({
  vtid: z.string().nullable(),
  operator_action_id: z.string().uuid('operator_action_id must be a valid UUID'),
  operator_id: z.string().min(1, 'operator_id is required'),
  operator_role: z.enum(['operator', 'admin', 'system']),
  action_type: z.enum(['deploy', 'chat', 'upload', 'task_create', 'command', 'repair', 'session']),
  action_payload_hash: z.string().min(64, 'action_payload_hash must be a valid SHA-256 hash').max(64),
  status: z.enum(['started', 'completed', 'failed']),
  source: z.literal('operator'),
  timestamp: z.string().datetime('timestamp must be a valid ISO 8601 datetime'),
  payload: z.record(z.unknown()).optional(),
});

// ==================== Autonomous PR+Merge (Claude Worker Integration) ====================

/**
 * VTID-01032: Deploy target selection reasons
 * These codes indicate how deploy targets were determined.
 */
export type DeployTargetReason =
  | 'deploy_target_explicit'              // Caller provided deploy.services explicitly
  | 'deploy_target_detected_single'       // Auto-detected single service from changed files
  | 'deploy_target_detected_multi'        // Auto-detected multiple services from changed files
  | 'deploy_target_ambiguous_shared_only' // Only shared paths changed, requires explicit services
  | 'no_deploy_target';                   // No deployable service found in changed files

/**
 * VTID-01032: Deploy configuration schema for autonomous PR+merge
 * Allows explicit service targeting or auto-detection based on changed files.
 */
export const DeployConfigSchema = z.object({
  environment: z.enum(['dev']).default('dev'),
  services: z.array(z.string().min(1)).optional(),
});

export type DeployConfig = z.infer<typeof DeployConfigSchema>;

/**
 * Autonomous PR+Merge Request Schema
 * Used by Claude workers to request PR creation and merge in a single call.
 * Gateway handles all GitHub API interactions using GITHUB_SAFE_MERGE_TOKEN.
 *
 * VTID-01032: Extended with deploy configuration for multi-service targeting.
 */
export const AutonomousPrMergeRequestSchema = z.object({
  vtid: z.string().min(1, 'VTID is required'),
  repo: z.string().default('exafyltd/vitana-platform'),
  head_branch: z.string().min(1, 'Head branch is required'),
  base_branch: z.string().default('main'),
  title: z.string().min(1, 'PR title is required'),
  body: z.string().min(1, 'PR body is required'),
  merge_method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  automerge: z.boolean().default(true),
  max_ci_wait_seconds: z.number().int().min(30).max(600).default(300), // 5 min default, max 10 min
  // VTID-01032: Deploy targeting configuration
  deploy: DeployConfigSchema.optional(),
});

export type AutonomousPrMergeRequest = z.infer<typeof AutonomousPrMergeRequestSchema>;

/**
 * VTID-01032: Deploy selection result included in response
 */
export interface DeploySelectionResult {
  services: string[];
  environment: string;
  reason: DeployTargetReason;
  changed_files_count: number;
  workflow_triggered: boolean;
  workflow_url?: string;
}

export interface AutonomousPrMergeResponse {
  ok: boolean;
  vtid: string;
  pr_number?: number;
  pr_url?: string;
  merged?: boolean;
  merge_sha?: string | null;
  ci_status?: 'success' | 'failure' | 'pending' | 'timeout';
  // VTID-01032: Deploy selection result
  deploy?: DeploySelectionResult;
  error?: string;
  // VTID-01031 + VTID-01032: Stable reason codes
  reason?:
    | 'validation_failed'           // Request validation failed
    | 'branch_not_found'            // Head branch doesn't exist on remote
    | 'pr_created'                  // New PR was created (success path)
    | 'pr_reused_existing'          // Existing PR was reused (idempotent success path)
    | 'ci_failed'                   // CI checks failed
    | 'ci_timeout'                  // CI checks did not complete in time
    | 'governance_rejected'         // Governance blocked the merge
    | 'merge_failed'                // Merge operation failed
    | 'github_api_error'            // GitHub API returned an error
    | 'deploy_target_ambiguous';    // VTID-01032: Only shared paths changed, requires explicit services
  details?: Record<string, unknown>;
}

/**
 * VTID-01018: Structured error response for OASIS write failures
 */
export interface OasisWriteFailedError {
  error: 'oasis_write_failed';
  reason: string;
  operator_action_id: string;
  timestamp: string;
}

/**
 * VTID-01018: Action execution result
 */
export interface OperatorActionResult<T = unknown> {
  ok: boolean;
  operator_action_id: string;
  started_event_id?: string;
  terminal_event_id?: string;
  data?: T;
  oasis_error?: OasisWriteFailedError;
}

// ==================== VTID-01033: CICD Concurrency Lock Management ====================

/**
 * VTID-01033: Lock key types for concurrency control
 */
export type LockKeyType = 'global' | 'service' | 'path';

/**
 * VTID-01033: Lock entry representing a held lock
 */
export interface CicdLockEntry {
  /** Full lock key (e.g., "service:gateway", "path:.github/workflows/") */
  key: string;
  /** Type of lock */
  type: LockKeyType;
  /** VTID holding the lock */
  held_by: string;
  /** PR number associated with this lock */
  pr_number?: number;
  /** When the lock was acquired */
  acquired_at: string;
  /** When the lock will expire (for timeout enforcement) */
  expires_at: string;
}

/**
 * VTID-01033: Lock acquisition request
 */
export interface LockAcquisitionRequest {
  vtid: string;
  pr_number?: number;
  /** Services to lock (from deploy targeting) */
  services: string[];
  /** Changed paths that require locking */
  changed_paths: string[];
}

/**
 * VTID-01033: Lock acquisition result
 */
export interface LockAcquisitionResult {
  ok: boolean;
  vtid: string;
  /** Keys that were successfully acquired */
  acquired_keys?: string[];
  /** If blocked, which key caused the block */
  blocked_by_key?: string;
  /** If blocked, which VTID holds the blocking lock */
  blocked_by_vtid?: string;
  /** Error message if blocked */
  error?: string;
}

/**
 * VTID-01033: Concurrency blocked response for API
 */
export interface ConcurrencyBlockedResponse {
  ok: false;
  vtid: string;
  reason: 'concurrency_blocked';
  error: string;
  details: {
    lock_key: string;
    held_by: string;
    pr_number?: number;
    acquired_at?: string;
    expires_at?: string;
  };
}

/**
 * VTID-01033: Concurrency configuration loaded from config file
 */
export interface CicdConcurrencyConfig {
  concurrency: {
    maxParallelMerges: number;
    lockTimeoutMinutes: number;
  };
  criticalPaths: string[];
  strictPaths?: string[];
  lockKeyPrefixes: {
    global: string;
    service: string;
    path: string;
  };
}

/**
 * VTID-01033: Lock event types for OASIS
 */
export type CicdLockEventType =
  | 'cicd.lock.acquire.requested'
  | 'cicd.lock.acquire.succeeded'
  | 'cicd.lock.acquire.blocked'
  | 'cicd.lock.released'
  | 'cicd.lock.expired';
