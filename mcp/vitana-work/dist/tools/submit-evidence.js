/**
 * submit_evidence tool
 * Records evidence for a task (PR, commit, deploy)
 */
import { gatewayClient } from '../lib/gateway-client.js';
export async function submitEvidence(params) {
    const { vtid, type, url } = params;
    try {
        const result = await gatewayClient.submitEvidence(vtid, type, url);
        return {
            ok: result.ok,
            event_id: result.event_id,
        };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
//# sourceMappingURL=submit-evidence.js.map