/**
 * pickup_task tool
 * Fetches task spec and gets routing decision from orchestrator
 */
import { gatewayClient } from '../lib/gateway-client.js';
const LOW_CONFIDENCE_THRESHOLD = 70;
export async function pickupTask(params) {
    const { vtid } = params;
    // Step 1: Fetch the work order spec
    const workOrder = await gatewayClient.getWorkOrder(vtid);
    const spec = workOrder.spec || '';
    const title = workOrder.title;
    // Step 2: Get routing decision from orchestrator
    const routeDecision = await gatewayClient.routeTask(vtid, spec);
    // Extract VTID number for session name (e.g., "VTID-01165" -> "01165")
    const vtidNumber = vtid.replace(/^VTID-/i, '');
    const sessionName = `${vtidNumber} - ${title}`;
    // Build result
    const result = {
        vtid,
        title,
        spec,
        session_name: sessionName,
        run_id: routeDecision.run_id,
        target: routeDecision.target,
        assigned_subagents: routeDecision.assigned_subagents,
        confidence: routeDecision.confidence,
        rationale: routeDecision.rationale,
    };
    // Safety rule: Low confidence warning
    if (routeDecision.confidence < LOW_CONFIDENCE_THRESHOLD) {
        result.warning = `⚠️ LOW CONFIDENCE ROUTING (${routeDecision.confidence}%): The orchestrator is not confident about the routing decision. Please verify the target domain and assigned sub-agents before proceeding.`;
    }
    return result;
}
//# sourceMappingURL=pickup-task.js.map