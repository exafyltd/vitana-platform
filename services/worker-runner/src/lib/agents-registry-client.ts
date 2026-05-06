/**
 * Agents Registry Client (TypeScript)
 *
 * Self-registration helper for Node services. Posts a heartbeat to the
 * Gateway's agents registry on startup, then heartbeats every 60 seconds.
 *
 * NOT YET WIRED into worker-runner/index.ts — staged for a follow-up that
 * will call startAgentRegistration() from main().
 *
 * Errors are logged but never thrown — agent registration must NEVER block
 * the host service from starting up.
 */

import fetch from 'node-fetch';

export type AgentTier = 'service' | 'embedded' | 'scheduled';
// BOOTSTRAP-WORKER-TRUTH: extended to match the DB constraint after
// 20260510000200_BOOTSTRAP_agents_provider_check_extend.sql.
export type AgentProvider =
  | 'claude'
  | 'gemini'
  | 'conductor'
  | 'deepseek'
  | 'openai'
  | 'embedded'
  | 'none'
  | 'unknown';
export type AgentStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface AgentRegistrationConfig {
  gatewayUrl: string;
  agentId: string;
  displayName: string;
  description?: string;
  tier: AgentTier;
  role?: string;
  llmProvider?: AgentProvider;
  llmModel?: string;
  sourcePath: string;
  healthEndpoint?: string;
  metadata?: Record<string, unknown>;
  heartbeatIntervalMs?: number;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

const DEFAULT_HEARTBEAT_MS = 60_000;

interface HeartbeatPayload {
  agent_id: string;
  status: AgentStatus;
  display_name?: string;
  description?: string;
  tier?: AgentTier;
  role?: string;
  llm_provider?: AgentProvider;
  llm_model?: string;
  source_path?: string;
  health_endpoint?: string;
  metadata?: Record<string, unknown>;
  last_error?: string | null;
}

async function sendHeartbeat(
  gatewayUrl: string,
  payload: HeartbeatPayload,
  logger: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<boolean> {
  try {
    const response = await fetch(`${gatewayUrl}/api/v1/agents/registry/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.warn(
        `[agents-registry] Heartbeat for ${payload.agent_id} failed: ${response.status} ${text.slice(0, 200)}`
      );
      return false;
    }

    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[agents-registry] Heartbeat for ${payload.agent_id} threw: ${msg}`);
    return false;
  }
}

/**
 * Register the agent and start the heartbeat loop.
 * Returns a stop() function that cancels the loop.
 */
export function startAgentRegistration(config: AgentRegistrationConfig): () => void {
  const logger = config.logger || {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
  };

  const fullPayload: HeartbeatPayload = {
    agent_id: config.agentId,
    status: 'healthy',
    display_name: config.displayName,
    description: config.description,
    tier: config.tier,
    role: config.role,
    llm_provider: config.llmProvider || 'unknown',
    llm_model: config.llmModel,
    source_path: config.sourcePath,
    health_endpoint: config.healthEndpoint,
    metadata: config.metadata || {},
  };

  const lightPayload: HeartbeatPayload = {
    agent_id: config.agentId,
    status: 'healthy',
  };

  void sendHeartbeat(config.gatewayUrl, fullPayload, logger).then((ok) => {
    if (ok) {
      logger.info(`[agents-registry] Registered ${config.agentId}`);
    }
  });

  const intervalMs = config.heartbeatIntervalMs || DEFAULT_HEARTBEAT_MS;
  const handle = setInterval(() => {
    void sendHeartbeat(config.gatewayUrl, lightPayload, logger);
  }, intervalMs);

  if (typeof handle.unref === 'function') {
    handle.unref();
  }

  return () => {
    clearInterval(handle);
    void sendHeartbeat(
      config.gatewayUrl,
      { agent_id: config.agentId, status: 'down' },
      logger
    );
  };
}
