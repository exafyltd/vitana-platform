/**
 * complete_task tool
 * Marks a task as completed in OASIS
 */
export interface CompleteTaskParams {
    vtid: string;
    summary: string;
}
export interface CompleteTaskResult {
    ok: boolean;
    error?: string;
}
export declare function completeTask(params: CompleteTaskParams): Promise<CompleteTaskResult>;
//# sourceMappingURL=complete-task.d.ts.map