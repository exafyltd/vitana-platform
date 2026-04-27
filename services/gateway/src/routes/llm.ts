/**
 * VTID-01208: LLM Routing Policy & Telemetry API Routes
 *
 * Endpoints:
 * - GET  /api/v1/llm/routing-policy         - Get current policy + allowlists
 * - POST /api/v1/llm/routing-policy         - Update policy (governed + audited)
 * - POST /api/v1/llm/routing-policy/reset   - Reset to recommended defaults
 * - GET  /api/v1/llm/routing-policy/audit   - Get audit history
 * - GET  /api/v1/llm/telemetry              - Query LLM call events
 */

import { Router, Request, Response } from 'express';
import * as jose from 'jose';
import { z } from 'zod';
import {
  getRoutingPolicyResponse,
  updateRoutingPolicy,
  resetToDefaults,
  getPolicyAuditHistory,
} from '../services/llm-routing-policy-service';
import { queryLLMTelemetry } from '../services/llm-telemetry-service';
import { LLM_SAFE_DEFAULTS, VALID_STAGES, VALID_PROVIDERS, type LLMProvider } from '../constants/llm-defaults';
import { getSupabase } from '../lib/supabase';

const router = Router();

// =============================================================================
// Validation Schemas
// =============================================================================

// BOOTSTRAP-LLM-ROUTER: extended provider list (added deepseek + claude_subscription)
// and made fallback nullable so a stage can be configured with no fallback.
const ProviderEnum = z.enum([
  'anthropic',
  'vertex',
  'openai',
  'deepseek',
  'claude_subscription',
] as const);

const StageConfigSchema = z.object({
  primary_provider: ProviderEnum,
  primary_model: z.string().min(1),
  fallback_provider: ProviderEnum.nullable(),
  fallback_model: z.string().min(1).nullable(),
});

// BOOTSTRAP-LLM-ROUTER: extended schema with triage/vision/classifier stages.
const PolicySchema = z.object({
  planner: StageConfigSchema,
  worker: StageConfigSchema,
  validator: StageConfigSchema,
  operator: StageConfigSchema,
  memory: StageConfigSchema,
  triage: StageConfigSchema,
  vision: StageConfigSchema,
  classifier: StageConfigSchema,
});

const UpdatePolicySchema = z.object({
  policy: PolicySchema,
  reason: z.string().optional(),
});

const ResetPolicySchema = z.object({
  reason: z.string().optional(),
});

const TelemetryQuerySchema = z.object({
  vtid: z.string().optional(),
  stage: z.enum([
    'planner',
    'worker',
    'validator',
    'operator',
    'memory',
    'triage',
    'vision',
    'classifier',
  ] as const).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  service: z.string().optional(),
  status: z.enum(['success', 'error'] as const).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

// =============================================================================
// GET /api/v1/llm/routing-policy
// Get current routing policy with allowlists and defaults
// =============================================================================
router.get('/routing-policy', async (req: Request, res: Response) => {
  try {
    const environment = (req.query.environment as string) || 'DEV';
    const response = await getRoutingPolicyResponse(environment);

    res.json({
      ok: true,
      data: {
        policy: response.policy,
        providers: response.providers,
        models: response.models,
        recommended: response.recommended,
        environment,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[LLM API] GET /routing-policy error: ${message}`);

    res.status(500).json({
      ok: false,
      error: 'Failed to fetch routing policy',
      details: message,
    });
  }
});

// =============================================================================
// POST /api/v1/llm/routing-policy
// Update routing policy (governed + audited)
// =============================================================================
router.post('/routing-policy', async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validation = UpdatePolicySchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid request body',
        details: validation.error.issues,
      });
    }

    const { policy, reason } = validation.data;
    const environment = (req.query.environment as string) || 'DEV';

    // Get actor from request (in production, from auth token)
    // For now, use a header or default to 'operator'
    const actorId = req.headers['x-actor-id'] as string || 'operator';
    const actorRole = req.headers['x-actor-role'] as string || 'developer';

    // Validate actor role
    const allowedRoles = ['developer', 'infra', 'admin'];
    if (!allowedRoles.includes(actorRole)) {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden: insufficient permissions',
        details: `Role '${actorRole}' not allowed to update LLM routing policy`,
      });
    }

    const result = await updateRoutingPolicy(
      {
        policy,
        reason,
        actor_id: actorId,
        actor_role: actorRole,
      },
      environment
    );

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: 'Failed to update routing policy',
        details: result.error,
      });
    }

    res.json({
      ok: true,
      data: {
        policy: result.policy,
        message: `Routing policy updated to v${result.policy?.version}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[LLM API] POST /routing-policy error: ${message}`);

    res.status(500).json({
      ok: false,
      error: 'Failed to update routing policy',
      details: message,
    });
  }
});

// =============================================================================
// POST /api/v1/llm/routing-policy/reset
// Reset to recommended defaults
// =============================================================================
router.post('/routing-policy/reset', async (req: Request, res: Response) => {
  try {
    const validation = ResetPolicySchema.safeParse(req.body);
    const reason = validation.success ? validation.data.reason : undefined;
    const environment = (req.query.environment as string) || 'DEV';

    // Get actor from request
    const actorId = req.headers['x-actor-id'] as string || 'operator';
    const actorRole = req.headers['x-actor-role'] as string || 'developer';

    // Validate actor role
    const allowedRoles = ['developer', 'infra', 'admin'];
    if (!allowedRoles.includes(actorRole)) {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden: insufficient permissions',
        details: `Role '${actorRole}' not allowed to reset LLM routing policy`,
      });
    }

    const result = await resetToDefaults(
      {
        actor_id: actorId,
        actor_role: actorRole,
        reason,
      },
      environment
    );

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: 'Failed to reset routing policy',
        details: result.error,
      });
    }

    res.json({
      ok: true,
      data: {
        policy: result.policy,
        message: 'Routing policy reset to recommended defaults',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[LLM API] POST /routing-policy/reset error: ${message}`);

    res.status(500).json({
      ok: false,
      error: 'Failed to reset routing policy',
      details: message,
    });
  }
});

// =============================================================================
// GET /api/v1/llm/routing-policy/audit
// Get policy audit history
// =============================================================================
router.get('/routing-policy/audit', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await getPolicyAuditHistory(limit, offset);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: 'Failed to fetch audit history',
        details: result.error,
      });
    }

    res.json({
      ok: true,
      data: {
        records: result.records,
        pagination: {
          limit,
          offset,
          count: result.records.length,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[LLM API] GET /routing-policy/audit error: ${message}`);

    res.status(500).json({
      ok: false,
      error: 'Failed to fetch audit history',
      details: message,
    });
  }
});

// =============================================================================
// GET /api/v1/llm/telemetry
// Query LLM telemetry events
// =============================================================================
router.get('/telemetry', async (req: Request, res: Response) => {
  try {
    // Parse and validate query params
    const validation = TelemetryQuerySchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid query parameters',
        details: validation.error.issues,
      });
    }

    const params = validation.data;
    const result = await queryLLMTelemetry(params);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: 'Failed to query telemetry',
        details: result.error,
      });
    }

    res.json({
      ok: true,
      data: {
        events: result.events,
        pagination: result.pagination,
        filters_applied: {
          vtid: params.vtid,
          stage: params.stage,
          provider: params.provider,
          model: params.model,
          service: params.service,
          status: params.status,
          since: params.since,
          until: params.until,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[LLM API] GET /telemetry error: ${message}`);

    res.status(500).json({
      ok: false,
      error: 'Failed to query telemetry',
      details: message,
    });
  }
});

// =============================================================================
// GET /api/v1/llm/models
// VTID-02403: Return static catalog of LLM providers + live user_connections_count
// for AI-assistant providers (ChatGPT, Claude). Command Hub consumes this.
// =============================================================================
// =============================================================================
// GET /api/v1/llm/providers/health
//
// BOOTSTRAP-LLM-ROUTER: report which router providers actually have credentials
// configured on this gateway instance. The Command Hub dropdown reads this
// and grays out unavailable providers + shows a tooltip, so the UI can never
// again silently mislead by listing a provider that would fail at call time.
// =============================================================================
router.get('/providers/health', (_req: Request, res: Response) => {
  const providers: Array<{ provider: LLMProvider; available: boolean; reason?: string }> = [
    {
      provider: 'anthropic',
      available: Boolean(process.env.ANTHROPIC_API_KEY),
      reason: process.env.ANTHROPIC_API_KEY ? undefined : 'ANTHROPIC_API_KEY not set on gateway',
    },
    {
      provider: 'openai',
      available: Boolean(process.env.OPENAI_API_KEY),
      reason: process.env.OPENAI_API_KEY ? undefined : 'OPENAI_API_KEY not set on gateway',
    },
    {
      provider: 'vertex',
      available: Boolean(process.env.GOOGLE_CLOUD_PROJECT) || Boolean(process.env.GOOGLE_GEMINI_API_KEY),
      reason:
        process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_GEMINI_API_KEY
          ? undefined
          : 'No Vertex/Google AI credentials',
    },
    {
      provider: 'deepseek',
      available: Boolean(process.env.DEEPSEEK_API_KEY),
      reason: process.env.DEEPSEEK_API_KEY ? undefined : 'DEEPSEEK_API_KEY not set on gateway',
    },
    {
      provider: 'claude_subscription',
      available: (process.env.DEV_AUTOPILOT_USE_WORKER || '').toLowerCase() === 'true',
      reason:
        (process.env.DEV_AUTOPILOT_USE_WORKER || '').toLowerCase() === 'true'
          ? undefined
          : 'DEV_AUTOPILOT_USE_WORKER=true required (worker queue disabled)',
    },
  ];
  res.json({ ok: true, data: providers });
});

router.get('/models', async (req: Request, res: Response) => {
  // Static catalog (mirrors prior front-end defaults so existing UI still works)
  const staticModels: Array<{
    provider: string;
    model_id: string;
    status: string;
    avg_latency: number | string;
    cost_per_1k: string;
    usage: string;
  }> = [
    // Vertex AI
    { provider: 'vertex-ai', model_id: 'gemini-2.5-pro', status: 'active', avg_latency: 850, cost_per_1k: '0.0035', usage: 'Operator Chat, spec quality' },
    { provider: 'vertex-ai', model_id: 'gemini-2.0-flash', status: 'active', avg_latency: 320, cost_per_1k: '0.00015', usage: 'Fact extraction, fast queries' },
    { provider: 'vertex-ai', model_id: 'gemini-1.5-pro', status: 'active', avg_latency: 920, cost_per_1k: '0.0035', usage: 'Fallback routing, long context' },
    // Gemini API
    { provider: 'gemini-api', model_id: 'gemini-3-pro-preview', status: 'active', avg_latency: 1100, cost_per_1k: '0.0040', usage: 'ORB Assistant (Q&A)' },
    { provider: 'gemini-api', model_id: 'gemini-2.0-flash-exp', status: 'active', avg_latency: 280, cost_per_1k: '0.00015', usage: 'Command parsing' },
    { provider: 'gemini-api', model_id: 'gemini-2.5-pro', status: 'active', avg_latency: 880, cost_per_1k: '0.0035', usage: 'General assistance' },
    // OpenAI (embeddings + user-keyed chat)
    { provider: 'openai', model_id: 'text-embedding-3-small', status: 'active', avg_latency: 120, cost_per_1k: '0.00002', usage: 'Semantic memory embeddings' },
    { provider: 'openai', model_id: 'gpt-4o', status: 'active', avg_latency: 900, cost_per_1k: '0.0050', usage: 'ChatGPT (user-supplied key)' },
    { provider: 'openai', model_id: 'gpt-4o-mini', status: 'active', avg_latency: 400, cost_per_1k: '0.00015', usage: 'ChatGPT fast (user-supplied key)' },
    // Anthropic (user-keyed chat)
    // BOOTSTRAP-AI-VERIFY-MODEL: refreshed to current Claude 4.x lineup.
    { provider: 'anthropic', model_id: 'claude-sonnet-4-6', status: 'active', avg_latency: 700, cost_per_1k: '0.003', usage: 'Claude default (user-supplied key)' },
    { provider: 'anthropic', model_id: 'claude-haiku-4-5-20251001', status: 'active', avg_latency: 350, cost_per_1k: '0.0008', usage: 'Claude fast (user-supplied key)' },
    { provider: 'anthropic', model_id: 'claude-opus-4-7', status: 'configured', avg_latency: 1200, cost_per_1k: '0.015', usage: 'Claude premium (user-supplied key)' },
  ];

  // VTID-02403: Augment with user_connections_count + monthly_cost_usd placeholder
  // Map provider name (from static catalog) → connector_registry id we seed.
  const providerMap: Record<string, string> = {
    openai: 'chatgpt',
    anthropic: 'claude',
  };

  // Resolve tenant from JWT if present
  let tenantId: string | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const claims = jose.decodeJwt(authHeader.slice(7));
      const app_metadata = (claims as { app_metadata?: { active_tenant_id?: string } }).app_metadata;
      tenantId = app_metadata?.active_tenant_id ?? null;
      if (!tenantId && typeof claims.sub === 'string') {
        const supabase = getSupabase();
        if (supabase) {
          const { data: ut } = await supabase
            .from('user_tenants')
            .select('tenant_id')
            .eq('user_id', claims.sub)
            .eq('is_active', true)
            .limit(1)
            .maybeSingle();
          tenantId = ut?.tenant_id ?? null;
        }
      }
    } catch { /* ignore */ }
  }

  // Count active connections per provider
  const supabase = getSupabase();
  const aiCounts: Record<string, number> = { chatgpt: 0, claude: 0 };
  if (supabase && tenantId) {
    for (const connectorId of Object.values(providerMap)) {
      const { count } = await supabase
        .from('user_connections')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('connector_id', connectorId)
        .eq('category', 'ai_assistant')
        .eq('is_active', true);
      aiCounts[connectorId] = count ?? 0;
    }
  }

  const models = staticModels.map((m) => {
    const connectorId = providerMap[m.provider];
    if (!connectorId) return m;
    return {
      ...m,
      connector_id: connectorId,
      user_connections_count: aiCounts[connectorId] ?? 0,
      monthly_cost_usd: 0, // Phase 1 placeholder
    };
  });

  return res.json({ ok: true, data: models });
});

// =============================================================================
// GET /api/v1/llm/defaults
// Get safe defaults (static, no DB call)
// =============================================================================
router.get('/defaults', (req: Request, res: Response) => {
  res.json({
    ok: true,
    data: {
      policy: LLM_SAFE_DEFAULTS,
      stages: VALID_STAGES,
      providers: VALID_PROVIDERS,
    },
  });
});

export default router;
