/**
 * Gateway Client - HTTP client for Vitana Gateway API calls
 * All calls include actor: "claude-code" for traceability
 */
export interface GatewayConfig {
    baseUrl: string;
    apiKey?: string;
}
export interface WorkOrder {
    vtid: string;
    title: string;
    spec?: string;
    status: string;
    created_at: string;
}
export interface RouteDecision {
    run_id: string;
    target: string;
    assigned_subagents: string[];
    confidence: number;
    rationale: string;
}
export interface OasisEvent {
    ok: boolean;
    event_id?: string;
    error?: string;
}
export interface EvidenceResult {
    ok: boolean;
    event_id?: string;
    error?: string;
}
export interface TaskCompleteResult {
    ok: boolean;
    error?: string;
}
export interface DiscoverTasksParams {
    tenant?: string;
    environment?: string;
    statuses?: string[];
    limit?: number;
    include_events?: boolean;
}
export interface OasisTask {
    vtid: string;
    title: string;
    status: string;
    layer?: string;
    module?: string;
    assigned_to?: string | null;
    created_at: string;
    updated_at: string;
    is_terminal?: boolean;
    terminal_outcome?: string | null;
    completed_at?: string | null;
}
declare class GatewayClient {
    private config;
    constructor();
    private request;
    /**
     * List pending work orders - MAPS TO CANONICAL: GET /api/v1/oasis/vtid-ledger
     * NOTE: "workorders" is not a separate endpoint - it uses the vtid_ledger source of truth
     */
    listWorkOrders(): Promise<WorkOrder[]>;
    /**
     * Get a specific work order - MAPS TO CANONICAL: GET /api/v1/vtid/:vtid
     * NOTE: Uses the canonical VTID endpoint, not a separate workorders endpoint
     */
    getWorkOrder(vtid: string): Promise<WorkOrder>;
    /**
     * POST /api/v1/worker/orchestrator/route - Get routing decision from orchestrator
     */
    routeTask(vtid: string, spec: string): Promise<RouteDecision>;
    /**
     * POST /api/v1/oasis/events - Emit an OASIS event for progress tracking
     */
    emitEvent(vtid: string, topic: string, message: string, metadata?: Record<string, unknown>): Promise<OasisEvent>;
    /**
     * Submit evidence (PR, commit, deploy) - MAPS TO CANONICAL: POST /api/v1/oasis/events
     * NOTE: Evidence is recorded as OASIS events, not a separate evidence endpoint.
     * The event topic and metadata capture the evidence type and URL.
     */
    submitEvidence(vtid: string, type: 'pr' | 'commit' | 'deploy', url: string): Promise<EvidenceResult>;
    /**
     * Complete a task - MAPS TO CANONICAL: POST /api/v1/vtid/lifecycle/complete
     * NOTE: Task completion MUST go through the terminal lifecycle endpoint (VTID-01005)
     * This is the MANDATORY endpoint for marking a VTID as terminally complete.
     * OASIS is the single source of truth for task completion.
     */
    completeTask(vtid: string, summary: string): Promise<TaskCompleteResult>;
    /**
     * VTID-01161: GET /api/v1/oasis/vtid-ledger - Discover pending tasks from vtid_ledger
     * This is the ONLY source of truth for task lifecycle per contract.
     * MCP is THIN INTERFACE - all filtering/logic happens in Gateway.
     */
    discoverTasks(params?: DiscoverTasksParams): Promise<OasisTask[]>;
}
export declare const gatewayClient: GatewayClient;
export {};
//# sourceMappingURL=gateway-client.d.ts.map