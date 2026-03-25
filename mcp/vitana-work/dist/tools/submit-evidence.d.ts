/**
 * submit_evidence tool
 * Records evidence for a task (PR, commit, deploy)
 */
export interface SubmitEvidenceParams {
    vtid: string;
    type: 'pr' | 'commit' | 'deploy';
    url: string;
}
export interface SubmitEvidenceResult {
    ok: boolean;
    event_id?: string;
    error?: string;
}
export declare function submitEvidence(params: SubmitEvidenceParams): Promise<SubmitEvidenceResult>;
//# sourceMappingURL=submit-evidence.d.ts.map