/**
 * report_progress tool
 * Emits an OASIS event to track progress on a task
 */
export interface ReportProgressParams {
    vtid: string;
    message: string;
}
export interface ReportProgressResult {
    ok: boolean;
    event_id?: string;
    error?: string;
}
export declare function reportProgress(params: ReportProgressParams): Promise<ReportProgressResult>;
//# sourceMappingURL=report-progress.d.ts.map