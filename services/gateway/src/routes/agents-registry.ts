/**
 * Agents Registry Routes
 *
 * Real registry for every LLM-powered workload in the platform — replaces the
 * hardcoded array in worker-orchestrator.ts. Backed by the agents_registry
 * table created in migration 20260410000000_agents_registry.sql.
 *
 * Endpoints:
 *   GET  /api/v1/agents/registry                — list all agents (filterable)
 *   GET  /api/v1/agents/registry/:agent_id      — single agent with full metadata
 *   POST /api/v1/agents/registry/heartbeat      — self-registration / status update
 *
 * Tiers:
 *   service   — dedicated agent process / Cloud Run service
 *   embedded  — LLM workload running inside the gateway process
 *   scheduled — recurring background job that calls an LLM
 *
 * Heartbeat is the upsert path: services call this on startup with their full
 * metadata, then heartbeat every ~60s with status updates. Status auto-decays
 * to 'degraded' if no heartbeat for >2 minutes (computed at read time, not
 * written back to the row).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const agentsRegistryRouter = Router();

const LOG_PREFIX = '[agents-registry]';
const HEARTBEAT_HEALTHY_WINDOW_MS = 2 * 60 * 1000;   // 2 min
const HEARTBEAT_DEGRADED_WINDOW_MS = 5 * 60 * 1000;  // 5 min

// =============================================================================
// Supabase helper (matches worker-orchestrator.ts pattern)
// =============================================================================

async function supabaseRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=representation',
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Status derivation (read-time, not stored)
// =============================================================================

interface AgentRow {
  agent_id: string;
  display_name: string;
  description: string | null;
  tier: 'service' | 'embedded' | 'scheduled';
  role: string | null;
  llm_provider: 'claude' | 'gemini' | 'conductor' | 'none' | 'unknown' | null;
  llm_model: string | null;
  source_path: string;
  entry_endpoint: string | null;
  health_endpoint: string | null;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  last_heartbeat_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface AgentRowWithDerivedStatus extends AgentRow {
  derived_status: 'healthy' | 'degraded' | 'down' | 'unknown';
  heartbeat_age_ms: number | null;
}

function deriveStatus(row: AgentRow): AgentRowWithDerivedStatus {
  const result: AgentRowWithDerivedStatus = {
    ...row,
    derived_status: row.status,
    heartbeat_age_ms: null,
  };

  if (!row.last_heartbeat_at) {
    return result;
  }

  const heartbeatAge = Date.now() - new Date(row.last_heartbeat_at).getTime();
  result.heartbeat_age_ms = heartbeatAge;

  // Embedded agents don't heartbeat individually — they live or die with the
  // gateway process. The gateway bootstrap stamps them on startup.
  if (row.tier === 'embedded') {
    return result;
  }

  // Scheduled jobs decay on a longer timeline because their cadence can be hours.
  if (row.tier === 'scheduled') {
    if (heartbeatAge > 24 * 60 * 60 * 1000) {
      result.derived_status = 'down';
    } else if (heartbeatAge > 6 * 60 * 60 * 1000) {
      result.derived_status = 'degraded';
    }
    return result;
  }

  // Service tier: 2 min healthy / 5 min degraded / beyond is down.
  if (row.status === 'healthy') {
    if (heartbeatAge > HEARTBEAT_DEGRADED_WINDOW_MS) {
      result.derived_status = 'down';
    } else if (heartbeatAge > HEARTBEAT_HEALTHY_WINDOW_MS) {
      result.derived_status = 'degraded';
    }
  }

  return result;
}

// =============================================================================
// GET /api/v1/agents/registry — list all agents
// =============================================================================

agentsRegistryRouter.get('/api/v1/agents/registry', async (req: Request, res: Response) => {
  try {
    const tier = typeof req.query.tier === 'string' ? req.query.tier : undefined;
    const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;

    const filters: string[] = [];
    if (tier) filters.push(`tier=eq.${encodeURIComponent(tier)}`);
    if (provider) filters.push(`llm_provider=eq.${encodeURIComponent(provider)}`);
    filters.push('select=*');
    filters.push('order=tier.asc,agent_id.asc');

    const result = await supabaseRequest<AgentRow[]>(
      `/rest/v1/agents_registry?${filters.join('&')}`
    );

    if (!result.ok || !result.data) {
      return res.status(500).json({
        ok: false,
        error: result.error || 'Failed to load agents registry',
      });
    }

    let rows = result.data.map(deriveStatus);
    if (status) {
      rows = rows.filter((r) => r.derived_status === status);
    }

    const byTier = {
      service: rows.filter((r) => r.tier === 'service'),
      embedded: rows.filter((r) => r.tier === 'embedded'),
      scheduled: rows.filter((r) => r.tier === 'scheduled'),
    };

    const counts = {
      total: rows.length,
      by_tier: {
        service: byTier.service.length,
        embedded: byTier.embedded.length,
        scheduled: byTier.scheduled.length,
      },
      by_status: {
        healthy: rows.filter((r) => r.derived_status === 'healthy').length,
        degraded: rows.filter((r) => r.derived_status === 'degraded').length,
        down: rows.filter((r) => r.derived_status === 'down').length,
        unknown: rows.filter((r) => r.derived_status === 'unknown').length,
      },
      by_provider: {
        claude: rows.filter((r) => r.llm_provider === 'claude').length,
        gemini: rows.filter((r) => r.llm_provider === 'gemini').length,
        conductor: rows.filter((r) => r.llm_provider === 'conductor').length,
        none: rows.filter((r) => r.llm_provider === 'none').length,
        unknown: rows.filter((r) => r.llm_provider === 'unknown' || r.llm_provider === null).length,
      },
    };

    return res.status(200).json({
      ok: true,
      counts,
      agents: rows,
      by_tier: byTier,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} list error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// GET /api/v1/agents/registry/:agent_id — single agent
// =============================================================================

agentsRegistryRouter.get('/api/v1/agents/registry/:agent_id', async (req: Request, res: Response) => {
  try {
    const { agent_id } = req.params;
    const result = await supabaseRequest<AgentRow[]>(
      `/rest/v1/agents_registry?agent_id=eq.${encodeURIComponent(agent_id)}&select=*`
    );

    if (!result.ok || !result.data) {
      return res.status(500).json({ ok: false, error: result.error || 'Lookup failed' });
    }

    if (result.data.length === 0) {
      return res.status(404).json({ ok: false, error: `Agent '${agent_id}' not found` });
    }

    return res.status(200).json({
      ok: true,
      agent: deriveStatus(result.data[0]),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} get error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /api/v1/agents/registry/heartbeat — self-registration / status update
// =============================================================================

const heartbeatSchema = z.object({
  agent_id: z.string().min(1).max(128),
  display_name: z.string().min(1).max(256).optional(),
  description: z.string().optional(),
  tier: z.enum(['service', 'embedded', 'scheduled']).optional(),
  role: z.string().optional(),
  llm_provider: z.enum(['claude', 'gemini', 'conductor', 'none', 'unknown']).optional(),
  llm_model: z.string().optional(),
  source_path: z.string().optional(),
  entry_endpoint: z.string().optional(),
  health_endpoint: z.string().optional(),
  status: z.enum(['healthy', 'degraded', 'down', 'unknown']).optional(),
  last_error: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

agentsRegistryRouter.post('/api/v1/agents/registry/heartbeat', async (req: Request, res: Response) => {
  try {
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid heartbeat payload',
        details: parsed.error.flatten(),
      });
    }

    const payload = parsed.data;
    const now = new Date().toISOString();

    // Try update first (common case — heartbeat for an already-seeded row)
    const updateBody: Record<string, unknown> = {
      last_heartbeat_at: now,
      status: payload.status || 'healthy',
      updated_at: now,
    };
    if (payload.last_error !== undefined) updateBody.last_error = payload.last_error;
    if (payload.metadata !== undefined) updateBody.metadata = payload.metadata;
    if (payload.display_name !== undefined) updateBody.display_name = payload.display_name;
    if (payload.description !== undefined) updateBody.description = payload.description;
    if (payload.role !== undefined) updateBody.role = payload.role;
    if (payload.llm_provider !== undefined) updateBody.llm_provider = payload.llm_provider;
    if (payload.llm_model !== undefined) updateBody.llm_model = payload.llm_model;
    if (payload.health_endpoint !== undefined) updateBody.health_endpoint = payload.health_endpoint;
    if (payload.entry_endpoint !== undefined) updateBody.entry_endpoint = payload.entry_endpoint;
    if (payload.source_path !== undefined) updateBody.source_path = payload.source_path;
    if (payload.tier !== undefined) updateBody.tier = payload.tier;

    const updateResult = await supabaseRequest<AgentRow[]>(
      `/rest/v1/agents_registry?agent_id=eq.${encodeURIComponent(payload.agent_id)}`,
      { method: 'PATCH', body: updateBody }
    );

    if (updateResult.ok && Array.isArray(updateResult.data) && updateResult.data.length > 0) {
      return res.status(200).json({
        ok: true,
        agent_id: payload.agent_id,
        action: 'updated',
        agent: deriveStatus(updateResult.data[0]),
      });
    }

    // No row updated — try insert (first-time registration)
    if (!payload.tier || !payload.display_name || !payload.source_path) {
      return res.status(400).json({
        ok: false,
        error: `Agent '${payload.agent_id}' is not registered yet — first registration requires tier, display_name, and source_path`,
      });
    }

    const insertBody: Record<string, unknown> = {
      agent_id: payload.agent_id,
      display_name: payload.display_name,
      description: payload.description ?? null,
      tier: payload.tier,
      role: payload.role ?? null,
      llm_provider: payload.llm_provider ?? 'unknown',
      llm_model: payload.llm_model ?? null,
      source_path: payload.source_path,
      entry_endpoint: payload.entry_endpoint ?? null,
      health_endpoint: payload.health_endpoint ?? null,
      status: payload.status || 'healthy',
      last_heartbeat_at: now,
      last_error: payload.last_error ?? null,
      metadata: payload.metadata ?? {},
    };

    const insertResult = await supabaseRequest<AgentRow[]>(
      '/rest/v1/agents_registry',
      { method: 'POST', body: insertBody }
    );

    if (!insertResult.ok || !insertResult.data) {
      return res.status(500).json({
        ok: false,
        error: insertResult.error || 'Insert failed',
      });
    }

    console.log(`${LOG_PREFIX} new agent registered: ${payload.agent_id}`);
    return res.status(201).json({
      ok: true,
      agent_id: payload.agent_id,
      action: 'created',
      agent: deriveStatus(insertResult.data[0]),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} heartbeat error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// Bootstrap helper for Tier 2 (embedded) agents
// =============================================================================

// Agents that live inside the gateway process — if the gateway is up, they are up.
// Includes both "embedded" tier (LLM workloads) and "scheduled" tier (cron jobs).
const GATEWAY_HOSTED_AGENTS = [
  'conversation-intelligence',
  'orb-live',
  'gemini-operator',
  'inline-fact-extractor',
  'llm-analyzer',
  'recommendation-generator',
  'embedding-service',
  'recommendation-engine-scheduler',
  'daily-recompute',
] as const;

/**
 * Bootstrap on gateway startup.
 *
 * Previously this stamped status='healthy' + last_heartbeat_at=now for all
 * gateway-hosted agents at startup, which was a fake heartbeat: an embedded
 * agent could have last failed 24h ago and still display green. The dashboard
 * "16 healthy" overstated reality.
 *
 * Truthful behavior: on startup, mark gateway-hosted agents 'unknown' (we
 * don't know yet whether their last invocation succeeded). Each agent's call
 * site emits a real heartbeat via recordAgentHeartbeat() after a successful
 * run. If no call comes in, the dashboard correctly shows 'unknown' rather
 * than fake-healthy.
 */
export async function bootstrapEmbeddedAgents(): Promise<void> {
  for (const agentId of GATEWAY_HOSTED_AGENTS) {
    const result = await supabaseRequest(
      `/rest/v1/agents_registry?agent_id=eq.${encodeURIComponent(agentId)}`,
      {
        method: 'PATCH',
        body: {
          status: 'unknown',
          last_error: null,
          updated_at: new Date().toISOString(),
        },
      }
    );
    if (!result.ok) {
      console.warn(`${LOG_PREFIX} bootstrap failed for ${agentId}: ${result.error}`);
    }
  }
  console.log(`${LOG_PREFIX} registered ${GATEWAY_HOSTED_AGENTS.length} gateway-hosted agents (status=unknown until first heartbeat)`);
}

/**
 * Record a real heartbeat for an embedded/scheduled agent after a successful
 * invocation. Call sites should invoke this in their post-success path so
 * status reflects actual usage rather than gateway-uptime.
 *
 * Errors are logged but never thrown — heartbeat must never break the call.
 */
export async function recordAgentHeartbeat(
  agentId: string,
  opts: { error?: string | null } = {}
): Promise<void> {
  const now = new Date().toISOString();
  const result = await supabaseRequest(
    `/rest/v1/agents_registry?agent_id=eq.${encodeURIComponent(agentId)}`,
    {
      method: 'PATCH',
      body: {
        status: opts.error ? 'degraded' : 'healthy',
        last_heartbeat_at: now,
        last_error: opts.error ?? null,
        updated_at: now,
      },
    }
  );
  if (!result.ok) {
    console.warn(`${LOG_PREFIX} heartbeat record failed for ${agentId}: ${result.error}`);
  }
}

// =============================================================================
// Helper exposed for the legacy /api/v1/worker/subagents endpoint
// =============================================================================

export async function fetchServiceTierAgents(): Promise<{
  ok: boolean;
  agents?: AgentRowWithDerivedStatus[];
  error?: string;
}> {
  const result = await supabaseRequest<AgentRow[]>(
    '/rest/v1/agents_registry?tier=eq.service&select=*&order=agent_id.asc'
  );
  if (!result.ok || !result.data) {
    return { ok: false, error: result.error };
  }
  return { ok: true, agents: result.data.map(deriveStatus) };
}
