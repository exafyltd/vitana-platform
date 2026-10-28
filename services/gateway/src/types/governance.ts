export interface GovernanceCategory {
    id: string;
    tenant_id: string;
    name: string;
    description?: string;
    severity: number;
    created_at: string;
}

export interface GovernanceRule {
    id: string;
    tenant_id: string;
    category_id?: string;
    name: string;
    description?: string;
    logic: Record<string, any>;
    is_active: boolean;
    created_at: string;
}

export interface GovernanceEvaluation {
    id: string;
    tenant_id: string;
    rule_id: string;
    entity_id: string;
    status: 'PASS' | 'FAIL';
    evaluated_at: string;
    metadata?: Record<string, any>;
}

export interface GovernanceViolation {
    id: string;
    tenant_id: string;
    rule_id: string;
    entity_id: string;
    severity: number;
    status: 'OPEN' | 'RESOLVED' | 'IGNORED';
    created_at: string;
    resolved_at?: string;
}

export interface GovernanceEnforcement {
    id: string;
    tenant_id: string;
    rule_id: string;
    action: string;
    status: string;
    executed_at: string;
    details?: Record<string, any>;
}

export interface GovernanceProposal {
    id: string;
    tenant_id: string;
    proposal_id: string;
    type: 'New Rule' | 'Change Rule' | 'Deprecate Rule';
    rule_code?: string;
    status: 'Draft' | 'Under Review' | 'Approved' | 'Rejected' | 'Implemented';
    created_by: 'User' | 'Gemini' | 'Claude' | 'System' | 'Autopilot';
    original_rule?: Record<string, any>;
    proposed_rule: Record<string, any>;
    rationale?: string;
    timeline: ProposalTimelineEvent[];
    created_at: string;
    updated_at: string;
}

export interface ProposalTimelineEvent {
    event: string;
    timestamp: string;
    actor?: string;
}

// DTO types for frontend
export interface RuleDTO {
    ruleCode: string;
    name: string;
    category: string;
    status: 'Active' | 'Draft' | 'Deprecated' | 'Proposal';
    description: string;
    logic: Record<string, any> | null;
    updatedAt: string;
    relatedServices: string[];
    lastEvaluations: EvaluationSummary[];
}

export interface EvaluationSummary {
    timestamp: string;
    result: 'Pass' | 'Fail';
    executor: string;
}

export interface EvaluationDTO {
    id: string;
    time: string;
    ruleCode: string;
    target: string;
    result: 'Pass' | 'Fail';
    executor: string;
    payload: Record<string, any> | null;
}

export interface ViolationDTO {
    violationId: string;
    ruleCode: string;
    severity: 'Low' | 'Medium' | 'High' | 'Critical';
    status: 'Open' | 'In Progress' | 'Resolved';
    detectedAt: string;
    description?: string;
    impact?: string;
}

export interface ProposalDTO {
    proposalId: string;
    type: 'New Rule' | 'Change Rule' | 'Deprecate Rule';
    ruleCode: string | '(new)';
    status: 'Draft' | 'Under Review' | 'Approved' | 'Rejected' | 'Implemented';
    createdBy: 'User' | 'Gemini' | 'Claude' | 'System' | 'Autopilot';
    updatedAt: string;
    originalRule: Partial<RuleDTO> | null;
    proposedRule: Record<string, any> | null;
    rationale: string | null;
    timeline: ProposalTimelineEvent[];
}

export interface FeedEntry {
    id: string;
    message: string;
    timestamp: string;
    link?: string;
}

export interface OasisGovernanceEventPayload {
    eventId: string;
    eventType: 'GOVERNANCE_CHECK' | 'GOVERNANCE_VIOLATION' | 'GOVERNANCE_ENFORCEMENT';
    timestamp: string;
    data: {
        ruleId?: string;
        entityId?: string;
        result?: 'PASS' | 'FAIL';
        details?: any;
        tenantId?: string;
    };
    sequence?: number;
}

// =============================================================================
// VTID-01160: Task Discovery Governance Types
// =============================================================================

/**
 * VTID-01160: Surface types that can trigger task discovery queries
 */
export type TaskDiscoverySurface = 'orb' | 'operator' | 'mcp' | 'other';

/**
 * VTID-01160: Detected source types for task state queries
 */
export type TaskStateSource = 'oasis' | 'repo_scan' | 'memory' | 'unknown';

/**
 * VTID-01160: Task discovery validation context
 * Passed to the OASIS_ONLY_TASK_TRUTH validator for evaluation
 */
export interface TaskDiscoveryContext {
    /** The surface making the query */
    surface: TaskDiscoverySurface;
    /** The detected source of task data */
    detected_source: TaskStateSource;
    /** The original query or intent */
    requested_query: string;
    /** Whether discover_tasks tool was used */
    used_discover_tasks: boolean;
    /** Task identifiers found in response (if any) */
    task_ids?: string[];
    /** The response source_of_truth field (if present) */
    response_source_of_truth?: string;
    /** Pending task statuses (if present) */
    pending_statuses?: string[];
}

/**
 * VTID-01160: Task discovery validation result
 */
export interface TaskDiscoveryValidationResult {
    /** Whether the validation passed */
    valid: boolean;
    /** Action to take: pass, block, or retry */
    action: 'pass' | 'block' | 'retry';
    /** Human-readable reason if blocked */
    reason?: string;
    /** User-facing message if blocked */
    user_message?: string;
    /** Retry action if applicable */
    retry_action?: 'discover_tasks_required';
    /** List of validation errors */
    errors: TaskDiscoveryError[];
}

/**
 * VTID-01160: Individual validation error
 */
export interface TaskDiscoveryError {
    /** Error code for programmatic handling */
    code: 'INVALID_SOURCE' | 'INVALID_VTID_FORMAT' | 'MISSING_DISCOVER_TASKS' | 'INVALID_STATUS' | 'LEGACY_ID_DETECTED';
    /** Human-readable error message */
    message: string;
    /** The offending value (if applicable) */
    value?: string;
}

/**
 * VTID-01160: OASIS violation payload for task discovery governance
 */
export interface TaskDiscoveryViolationPayload {
    /** Rule ID that was violated */
    rule_id: 'GOV-INTEL-R.1';
    /** Rule name */
    rule_name: 'OASIS_ONLY_TASK_TRUTH';
    /** Violation status */
    status: 'blocked';
    /** Surface that triggered the violation */
    surface: TaskDiscoverySurface;
    /** Detected non-OASIS source */
    detected_source: TaskStateSource;
    /** The original query that was blocked */
    requested_query: string;
    /** Required retry action */
    retry_action: 'discover_tasks_required';
    /** Invalid task IDs (if any) */
    invalid_task_ids?: string[];
    /** Timestamp of violation */
    violated_at: string;
}

/**
 * VTID-01160: VTID format validation constants
 */
export const VTID_FORMAT = {
    /** Valid VTID pattern: VTID-\d{4,5} */
    PATTERN: /^VTID-\d{4,5}$/,
    /** Legacy patterns that must be rejected */
    LEGACY_PATTERNS: [
        /^DEV-/,
        /^ADM-/,
        /^AICOR-/,
        /^OASIS-TASK-/,
    ],
    /** Allowed pending statuses */
    ALLOWED_PENDING_STATUSES: ['scheduled', 'allocated', 'in_progress'] as const,
} as const;

