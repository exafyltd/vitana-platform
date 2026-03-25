/**
 * Gateway Client - HTTP client for Vitana Gateway API calls
 * All calls include actor: "claude-code" for traceability
 */
class GatewayClient {
    config;
    constructor() {
        this.config = {
            baseUrl: process.env.VITANA_GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app',
            apiKey: process.env.VITANA_API_KEY,
        };
    }
    async request(method, path, body) {
        const url = `${this.config.baseUrl}${path}`;
        const headers = {
            'Content-Type': 'application/json',
            'X-Actor': 'claude-code',
        };
        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }
        const response = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gateway error (${response.status}): ${errorText}`);
        }
        return response.json();
    }
    /**
     * List pending work orders - MAPS TO CANONICAL: GET /api/v1/oasis/vtid-ledger
     * NOTE: "workorders" is not a separate endpoint - it uses the vtid_ledger source of truth
     */
    async listWorkOrders() {
        const result = await this.request('GET', '/api/v1/oasis/vtid-ledger?limit=50');
        if (!result.ok || !result.data)
            return [];
        // Map vtid_ledger format to WorkOrder format
        return result.data
            .filter(t => ['scheduled', 'allocated', 'in_progress'].includes(t.status))
            .map(t => ({
            vtid: t.vtid,
            title: t.title,
            spec: undefined,
            status: t.status,
            created_at: t.created_at,
        }));
    }
    /**
     * Get a specific work order - MAPS TO CANONICAL: GET /api/v1/vtid/:vtid
     * NOTE: Uses the canonical VTID endpoint, not a separate workorders endpoint
     */
    async getWorkOrder(vtid) {
        const result = await this.request('GET', `/api/v1/vtid/${vtid}`);
        return {
            vtid: result.vtid,
            title: result.title || result.description || vtid,
            spec: result.summary,
            status: result.status,
            created_at: result.created_at,
        };
    }
    /**
     * POST /api/v1/worker/orchestrator/route - Get routing decision from orchestrator
     */
    async routeTask(vtid, spec) {
        return this.request('POST', '/api/v1/worker/orchestrator/route', {
            vtid,
            spec,
            actor: 'claude-code',
        });
    }
    /**
     * POST /api/v1/oasis/events - Emit an OASIS event for progress tracking
     */
    async emitEvent(vtid, topic, message, metadata) {
        return this.request('POST', '/api/v1/oasis/events', {
            vtid,
            topic,
            service: 'vitana-work-mcp',
            status: 'info',
            message,
            metadata: {
                ...metadata,
                actor: 'claude-code',
            },
        });
    }
    /**
     * Submit evidence (PR, commit, deploy) - MAPS TO CANONICAL: POST /api/v1/oasis/events
     * NOTE: Evidence is recorded as OASIS events, not a separate evidence endpoint.
     * The event topic and metadata capture the evidence type and URL.
     */
    async submitEvidence(vtid, type, url) {
        // Evidence is submitted as OASIS events with specific topics
        const topicMap = {
            pr: 'vtid.evidence.pr_submitted',
            commit: 'vtid.evidence.commit_pushed',
            deploy: 'vtid.evidence.deploy_completed',
        };
        return this.request('POST', '/api/v1/oasis/events', {
            vtid,
            topic: topicMap[type],
            service: 'vitana-work-mcp',
            status: 'success',
            message: `Evidence submitted: ${type} at ${url}`,
            metadata: {
                evidence_type: type,
                evidence_url: url,
                actor: 'claude-code',
                submitted_at: new Date().toISOString(),
            },
        });
    }
    /**
     * Complete a task - MAPS TO CANONICAL: POST /api/v1/vtid/lifecycle/complete
     * NOTE: Task completion MUST go through the terminal lifecycle endpoint (VTID-01005)
     * This is the MANDATORY endpoint for marking a VTID as terminally complete.
     * OASIS is the single source of truth for task completion.
     */
    async completeTask(vtid, summary) {
        return this.request('POST', '/api/v1/vtid/lifecycle/complete', {
            vtid,
            outcome: 'success',
            source: 'claude',
            summary,
        });
    }
    /**
     * VTID-01161: GET /api/v1/oasis/vtid-ledger - Discover pending tasks from vtid_ledger
     * This is the ONLY source of truth for task lifecycle per contract.
     * MCP is THIN INTERFACE - all filtering/logic happens in Gateway.
     */
    async discoverTasks(params = {}) {
        const { statuses = ['scheduled', 'allocated', 'in_progress'], limit = 50 } = params;
        // Build query string - Gateway handles the filtering via vtid_ledger
        const queryParams = new URLSearchParams();
        queryParams.set('limit', String(limit));
        // Only pass first status if specified (Gateway supports single status filter)
        // For multiple statuses, we rely on Gateway to return all and filter client-side
        // TODO: Gateway should support ?status=in.(scheduled,allocated,in_progress)
        const url = `/api/v1/oasis/vtid-ledger?${queryParams.toString()}`;
        const response = await this.request('GET', url);
        if (!response.ok || !response.data) {
            return [];
        }
        // Thin client: minimal filtering only, Gateway is source of truth
        return response.data.filter((task) => statuses.includes(task.status));
    }
}
// Singleton export
export const gatewayClient = new GatewayClient();
//# sourceMappingURL=gateway-client.js.map