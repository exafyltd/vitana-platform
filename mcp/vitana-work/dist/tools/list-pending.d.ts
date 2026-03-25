/**
 * list_pending_tasks tool
 * Lists pending work orders from Vitana Gateway
 */
export interface PendingTask {
    vtid: string;
    title: string;
    status: string;
    created_at: string;
}
export interface ListPendingResult {
    tasks: PendingTask[];
}
export declare function listPendingTasks(): Promise<ListPendingResult>;
//# sourceMappingURL=list-pending.d.ts.map