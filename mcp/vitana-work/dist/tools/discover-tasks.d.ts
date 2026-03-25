/**
 * VTID-01161: MCP Task Discovery - THIN INTERFACE
 *
 * HARD GOVERNANCE:
 * 1. vtid_ledger is the ONLY source of truth for task lifecycle
 * 2. MCP is THIN INTERFACE ONLY - calls Gateway canonical endpoints
 * 3. MCP MUST NOT compute status, decide completion, or maintain state
 * 4. All filtering/validation happens in Gateway, not here
 * 5. If MCP is down, system still functions (ORB/Operator/Command Hub work)
 */
export interface DiscoverTasksParams {
    tenant?: string;
    environment?: string;
    statuses?: ('scheduled' | 'allocated' | 'in_progress')[];
    limit?: number;
    include_events?: boolean;
}
export interface DiscoverTasksResult {
    ok: boolean;
    source_of_truth: 'vtid_ledger';
    queried: {
        statuses: string[];
        limit: number;
    };
    tasks: Array<{
        vtid: string;
        title: string;
        status: string;
        layer?: string;
        module?: string;
        created_at: string;
        updated_at: string;
    }>;
    count: number;
    error?: string;
}
/**
 * Discover pending tasks via Gateway canonical endpoint.
 *
 * MCP is THIN INTERFACE:
 * - Does NOT own state or compute anything
 * - Does NOT validate VTID formats (Gateway does that)
 * - Does NOT filter legacy patterns (Gateway does that)
 * - Just calls Gateway and returns the response
 */
export declare function discoverTasks(params?: DiscoverTasksParams): Promise<DiscoverTasksResult>;
//# sourceMappingURL=discover-tasks.d.ts.map