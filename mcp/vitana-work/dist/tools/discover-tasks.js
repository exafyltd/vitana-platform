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
import { gatewayClient } from '../lib/gateway-client.js';
// ============================================================================
// Main Discovery Function - THIN INTERFACE
// ============================================================================
/**
 * Discover pending tasks via Gateway canonical endpoint.
 *
 * MCP is THIN INTERFACE:
 * - Does NOT own state or compute anything
 * - Does NOT validate VTID formats (Gateway does that)
 * - Does NOT filter legacy patterns (Gateway does that)
 * - Just calls Gateway and returns the response
 */
export async function discoverTasks(params = {}) {
    const { statuses = ['scheduled', 'allocated', 'in_progress'], limit = 50, } = params;
    // Validate limit (basic bounds check only)
    const validatedLimit = Math.min(Math.max(limit, 1), 200);
    try {
        // Call Gateway canonical endpoint - Gateway reads from vtid_ledger
        // All filtering, validation, and business logic happens in Gateway
        const tasks = await gatewayClient.discoverTasks({
            statuses,
            limit: validatedLimit,
        });
        return {
            ok: true,
            source_of_truth: 'vtid_ledger',
            queried: {
                statuses,
                limit: validatedLimit,
            },
            tasks: tasks.map(t => ({
                vtid: t.vtid,
                title: t.title,
                status: t.status,
                layer: t.layer,
                module: t.module,
                created_at: t.created_at,
                updated_at: t.updated_at,
            })),
            count: tasks.length,
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
            ok: false,
            source_of_truth: 'vtid_ledger',
            queried: {
                statuses,
                limit: validatedLimit,
            },
            tasks: [],
            count: 0,
            error: errorMessage,
        };
    }
}
//# sourceMappingURL=discover-tasks.js.map