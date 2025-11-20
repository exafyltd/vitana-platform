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
