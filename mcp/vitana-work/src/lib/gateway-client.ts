/**
 * Gateway Client - HTTP client for Vitana Gateway API calls
 * All calls include actor: "claude-code" for traceability
 */

export interface GatewayConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface WorkOrder {
  vtid: string;
  title: string;
  spec?: string;
  status: string;
  created_at: string;
}

export interface RouteDecision {
  run_id: string;
  target: string;
  assigned_subagents: string[];
  confidence: number;
  rationale: string;
}

export interface OasisEvent {
  ok: boolean;
  event_id?: string;
  error?: string;
}

export interface EvidenceResult {
  ok: boolean;
  event_id?: string;
  error?: string;
}

export interface TaskCompleteResult {
  ok: boolean;
  error?: string;
}

class GatewayClient {
  private config: GatewayConfig;

  constructor() {
    this.config = {
      baseUrl: process.env.VITANA_GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app',
      apiKey: process.env.VITANA_API_KEY,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
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

    return response.json() as Promise<T>;
  }

  /**
   * GET /api/v1/workorders - List pending work orders
   */
  async listWorkOrders(): Promise<WorkOrder[]> {
    const result = await this.request<{ workorders: WorkOrder[] }>(
      'GET',
      '/api/v1/workorders'
    );
    return result.workorders || [];
  }

  /**
   * GET /api/v1/workorders/:vtid - Get a specific work order
   */
  async getWorkOrder(vtid: string): Promise<WorkOrder> {
    return this.request<WorkOrder>('GET', `/api/v1/workorders/${vtid}`);
  }

  /**
   * POST /api/v1/worker/orchestrator/route - Get routing decision from orchestrator
   */
  async routeTask(
    vtid: string,
    spec: string
  ): Promise<RouteDecision> {
    return this.request<RouteDecision>('POST', '/api/v1/worker/orchestrator/route', {
      vtid,
      spec,
      actor: 'claude-code',
    });
  }

  /**
   * POST /api/v1/oasis/events - Emit an OASIS event for progress tracking
   */
  async emitEvent(
    vtid: string,
    topic: string,
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<OasisEvent> {
    return this.request<OasisEvent>('POST', '/api/v1/oasis/events', {
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
   * POST /api/v1/evidence - Submit evidence (PR, commit, deploy)
   */
  async submitEvidence(
    vtid: string,
    type: 'pr' | 'commit' | 'deploy',
    url: string
  ): Promise<EvidenceResult> {
    return this.request<EvidenceResult>('POST', '/api/v1/evidence', {
      vtid,
      type,
      url,
      actor: 'claude-code',
    });
  }

  /**
   * PATCH /api/v1/oasis/tasks/:vtid - Move task to validation
   * NOTE: Does NOT set terminal 'completed' status. Uses 'in_validation' for governance.
   * Terminal completion requires human validation or separate governance workflow.
   */
  async completeTask(vtid: string, summary: string): Promise<TaskCompleteResult> {
    // First, emit the ready_for_validation event
    await this.emitEvent(
      vtid,
      'task.ready_for_validation',
      `Task ready for validation: ${summary}`,
      { summary }
    );

    // Then transition to in_validation status (governance-safe, not terminal)
    return this.request<TaskCompleteResult>(
      'PATCH',
      `/api/v1/oasis/tasks/${vtid}`,
      {
        status: 'in_validation',
        summary,
        actor: 'claude-code',
      }
    );
  }
}

// Singleton export
export const gatewayClient = new GatewayClient();
