import fetch from 'node-fetch';

export type AgentTier = 'service' | 'embedded' | 'scheduled';
export type AgentStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface AgentRegistrationConfig {
  gatewayUrl: string;
  agentId: string;
  displayName: string;
  description?: string;
  tier: AgentTier;
  role?: string;
  sourcePath: string;
  healthEndpoint?: string;
  metadata?: Record<string, unknown>;
  heartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 60_000;

interface HeartbeatPayload {
  agent_id: string;
  status: AgentStatus;
  display_name?: string;
  description?: string;
  tier?: AgentTier;
  role?: string;
  source_path?: string;
  health_endpoint?: string;
  metadata?: Record<string, unknown>;
}

async function postHeartbeat(gatewayUrl: string, payload: HeartbeatPayload): Promise<boolean> {
  try {
    const res = await fetch(`${gatewayUrl}/api/v1/agents/registry/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[vaea] agents-registry heartbeat failed: ${res.status} ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[vaea] agents-registry heartbeat threw: ${msg}`);
    return false;
  }
}

export function startAgentRegistration(config: AgentRegistrationConfig): () => void {
  if (!config.gatewayUrl) {
    console.warn('[vaea] GATEWAY_URL not set — agents-registry self-registration skipped');
    return () => {};
  }

  const full: HeartbeatPayload = {
    agent_id: config.agentId,
    status: 'healthy',
    display_name: config.displayName,
    description: config.description,
    tier: config.tier,
    role: config.role,
    source_path: config.sourcePath,
    health_endpoint: config.healthEndpoint,
    metadata: config.metadata || {},
  };

  const light: HeartbeatPayload = { agent_id: config.agentId, status: 'healthy' };

  void postHeartbeat(config.gatewayUrl, full).then((ok) => {
    if (ok) console.log(`[vaea] Registered with agents-registry as ${config.agentId}`);
  });

  const interval = config.heartbeatIntervalMs || DEFAULT_HEARTBEAT_MS;
  const handle = setInterval(() => {
    void postHeartbeat(config.gatewayUrl, light);
  }, interval);
  if (typeof handle.unref === 'function') handle.unref();

  return () => {
    clearInterval(handle);
    void postHeartbeat(config.gatewayUrl, { agent_id: config.agentId, status: 'down' });
  };
}
