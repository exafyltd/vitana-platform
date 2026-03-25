/**
 * pickup_task tool
 * Fetches task spec and gets routing decision from orchestrator
 */
export interface PickupTaskParams {
    vtid: string;
}
export interface PickupTaskResult {
    vtid: string;
    title: string;
    spec: string;
    session_name: string;
    run_id: string;
    target: string;
    assigned_subagents: string[];
    confidence: number;
    rationale: string;
    warning?: string;
}
export declare function pickupTask(params: PickupTaskParams): Promise<PickupTaskResult>;
//# sourceMappingURL=pickup-task.d.ts.map