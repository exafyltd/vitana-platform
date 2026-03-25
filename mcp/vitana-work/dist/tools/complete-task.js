/**
 * complete_task tool
 * Marks a task as completed in OASIS
 */
import { gatewayClient } from '../lib/gateway-client.js';
export async function completeTask(params) {
    const { vtid, summary } = params;
    try {
        const result = await gatewayClient.completeTask(vtid, summary);
        return {
            ok: result.ok,
        };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
//# sourceMappingURL=complete-task.js.map