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

