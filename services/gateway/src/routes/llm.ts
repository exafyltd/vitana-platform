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
import { queryLLMTelemetry, getLLMTelemetrySummary } from '../services/llm-telemetry-service';
import { verifyProvider } from '../services/llm-router';
import { emitOasisEvent } from '../services/oasis-event-service';
import { requireAdminAuth } from '../middleware/auth-supabase-jwt';
import {
  LLM_SAFE_DEFAULTS,
  VALID_STAGES,
  VALID_PROVIDERS,
  getProviderFlagship,
  type LLMProvider,
} from '../constants/llm-defaults';
import { getSupabase } from '../lib/supabase';

const router = Router();

// =============================================================================
// Validation Schemas
// =============================================================================

// BOOTSTRAP-LLM-ROUTER: extended provider list (added deepseek + claude_subscription)
// and made fallback nullable so a stage can be configured with no fallback.
//
// VTID-03565: derived from VALID_PROVIDERS rather than restated as a literal.
// It previously omitted 'bedrock' while VALID_PROVIDERS included it, so the
// Command Hub dropdown OFFERED Bedrock and this endpoint then rejected the
// save with a 400 — i.e. the standing "Claude always via Bedrock" rule
// (VTID-03563) could not physically be stored through the API. Deriving the
// schema from the single source of truth means adding a provider to
// VALID_PROVIDERS can never again leave the write path unable to accept it.
// Exported for tests: a test that restates this schema instead of importing it
// cannot detect the drift it exists to prevent (VTID-03565).
export const ProviderEnum = z.enum(
  VALID_PROVIDERS as unknown as [LLMProvider, ...LLMProvider[]],
);

export const StageConfigSchema = z.object({
  primary_provider: ProviderEnum,
  primary_model: z.string().min(1),
  fallback_provider: ProviderEnum.nullable(),
  fallback_model: z.string().min(1).nullable(),
});

// BOOTSTRAP-LLM-ROUTER: extended schema with triage/vision/classifier stages.
//
// VTID-03565: `vision` and `classifier` are optional because the ACTIVE
// production policy (v10, 2026-05-02) does not contain them — it predates
// their addition and carries only the original six stages. Requiring all
// eight meant a read-modify-write round-trip of the live policy 400'd on
// stages the caller never touched, so the only way to change routing was to
// write the table directly (against "Always route DB mutations through
// Gateway APIs"). The other six stay REQUIRED: a partial policy is not
// merged with defaults — `loadPolicy()` takes the row wholesale — so
// dropping one would make every call to that stage fail with
// "No policy configured for stage '<x>'".
export const PolicySchema = z.object({
  planner: StageConfigSchema,
  worker: StageConfigSchema,
  validator: StageConfigSchema,
  operator: StageConfigSchema,
  memory: StageConfigSchema,
  triage: StageConfigSchema,
  vision: StageConfigSchema.optional(),
  classifier: StageConfigSchema.optional(),
});

const UpdatePolicySchema = z.object({
  policy: PolicySchema,
  reason: z.string().optional(),
});

const ResetPolicySchema = z.object({
  reason: z.string().optional(),
});

// VTID-03565: model is optional — omitted, the preflight uses the provider's
// flagship. An explicit model is what makes this useful for Bedrock, where the
// question is usually "can this account invoke THIS inference profile?".
const VerifyProviderSchema = z.object({
  provider: ProviderEnum,
  model: z.string().min(1).optional(),
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
// GET /api/v1/llm/telemetry/summary
//
// VTID-03599: aggregate call volume for the Command Hub "Usage Summary" tab
// -- totals, provider/service/stage breakdowns, hourly trend, and a named
// non_bedrock_google_or_anthropic_calls watchdog count. Direct follow-up to
// VTID-03579/03563: routing tables and per-call events already existed, but
// nothing ever aggregated them into a "how many calls, by whom, on what"
// answer -- so a runaway loop or a silent Google fallback only became
// visible when someone happened to read a bill.
//
// Admin-gated (unlike its sibling GET /telemetry, a pre-existing gap out of
// scope here): this endpoint surfaces aggregate cost/volume data, and the
// Command Hub client already sends the admin bearer token on every request
// via buildContextHeaders(), so this is a drop-in requirement change.
// =============================================================================
router.get('/telemetry/summary', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const hoursRaw = req.query.hours;
    const hours = hoursRaw !== undefined ? Number(hoursRaw) : 24;

    if (!Number.isFinite(hours) || hours <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid query parameters',
        details: 'hours must be a positive number',
      });
    }

    const result = await getLLMTelemetrySummary(hours);

    if (!result.ok || !result.summary) {
      return res.status(500).json({
        ok: false,
        error: 'Failed to query telemetry summary',
        details: result.error,
      });
    }

    res.json({ ok: true, data: result.summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[LLM API] GET /telemetry/summary error: ${message}`);

    res.status(500).json({
      ok: false,
      error: 'Failed to query telemetry summary',
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
    // VTID-03565: 'bedrock' was missing from this list entirely, so the one
    // provider the standing rule (VTID-03563) mandates was the one provider
    // an operator could not see the state of.
    {
      provider: 'bedrock',
      available: Boolean(process.env.BEDROCK_ROLE_ARN),
      reason: process.env.BEDROCK_ROLE_ARN
        ? undefined
        : 'BEDROCK_ROLE_ARN not set on gateway — the router SKIPS bedrock and serves the fallback',
    },
  ];
  res.json({
    ok: true,
    data: providers,
    // Stated inline because this payload reads like a health check and is not
    // one: every entry above is an env-var presence test. `anthropic` reported
    // available:true throughout VTID-03563 while all 268 of its calls failed
    // on credit balance. Use POST /providers/verify for ground truth.
    note: 'available = credentials present, NOT verified working. POST /api/v1/llm/providers/verify performs a real invoke.',
  });
});

// =============================================================================
// POST /api/v1/llm/providers/verify
// Real preflight: actually invoke a provider/model and report what happened.
// =============================================================================
// Gated with real middleware, NOT the x-actor-role header the older handlers in
// this file use (VTID-03565). Two reasons: this endpoint spends money on every
// call — it performs a genuine provider completion — and a spoofable request
// header is not a gate for that. As a NEW route it has no existing caller to
// break, so it can start at the standard the rest of the admin surface already
// uses (requireAdminAuth = requireAuth + requireExafyAdmin).
router.post('/providers/verify', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const validation = VerifyProviderSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid request body',
        details: validation.error.issues,
      });
    }

    const { provider } = validation.data;
    // Default to the provider's flagship so an operator can verify a provider
    // without first knowing its model-id convention (Bedrock's, in particular,
    // is a cross-region inference profile id, not a plain model name).
    const model = validation.data.model || getProviderFlagship(provider);

    const result = await verifyProvider(provider, model);

    // Record the preflight as a governance DECISION, not as LLM traffic. This
    // is the evidence the "verify Bedrock FIRST, then flip routing" ordering
    // rule asks for — without it, "was this provider ever actually checked?"
    // has no auditable answer, which is the same gap that let a routing table
    // claim two stages were on Claude while Google served every call.
    // Never fails the request: the diagnosis is the deliverable, and an OASIS
    // outage must not turn a successful preflight into a 500.
    try {
      await emitOasisEvent({
        vtid: 'VTID-03565',
        type: 'llm.provider.verified',
        source: 'gateway',
        status: result.ok ? 'success' : 'error',
        message: `Provider preflight ${provider}/${model}: ${result.ok ? 'OK' : result.error || 'failed'}`,
        payload: {
          provider,
          model,
          ok: result.ok,
          available: result.available,
          error: result.error,
          latency_ms: result.latencyMs,
        },
        actor_id: (req as { identity?: { user_id?: string } }).identity?.user_id,
        actor_role: 'admin',
        surface: 'command-hub',
      });
    } catch (emitErr) {
      console.warn(`[LLM API] preflight OASIS emit failed: ${String(emitErr).slice(0, 200)}`);
    }

    // Always HTTP 200: a failed preflight is a successful diagnosis, and the
    // caller needs the body to read `error`. Non-2xx would make "Bedrock is
    // denied" indistinguishable from "the verify endpoint is broken".
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err).slice(0, 300) });
  }
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
    // Vertex AI (Operator Chat NOT yet migrated — routes/operator.ts still
    // calls processWithGemini/gemini-operator.ts, default gemini-2.5-pro —
    // plus voice/live pipeline)
    { provider: 'vertex-ai', model_id: 'gemini-2.5-pro', status: 'active', avg_latency: 850, cost_per_1k: '0.0035', usage: 'Operator Chat (not yet migrated — see gemini-operator.ts)' },
    { provider: 'vertex-ai', model_id: 'gemini-2.0-flash', status: 'active', avg_latency: 320, cost_per_1k: '0.00015', usage: 'Fact extraction, fast queries' },
    { provider: 'vertex-ai', model_id: 'gemini-1.5-pro', status: 'active', avg_latency: 920, cost_per_1k: '0.0035', usage: 'Fallback routing, long context' },
    // Gemini API
    { provider: 'gemini-api', model_id: 'gemini-3-pro-preview', status: 'active', avg_latency: 1100, cost_per_1k: '0.0040', usage: 'ORB Assistant (Q&A)' },
    { provider: 'gemini-api', model_id: 'gemini-2.0-flash-exp', status: 'active', avg_latency: 280, cost_per_1k: '0.00015', usage: 'Command parsing' },
    // OpenAI (embeddings + user-keyed chat)
    { provider: 'openai', model_id: 'text-embedding-3-small', status: 'active', avg_latency: 120, cost_per_1k: '0.00002', usage: 'Semantic memory embeddings' },
    { provider: 'openai', model_id: 'gpt-4o', status: 'active', avg_latency: 900, cost_per_1k: '0.0050', usage: 'ChatGPT (user-supplied key)' },
    { provider: 'openai', model_id: 'gpt-4o-mini', status: 'active', avg_latency: 400, cost_per_1k: '0.00015', usage: 'ChatGPT fast (user-supplied key)' },
    // Anthropic
    // BOOTSTRAP-GEMINI-TO-CLAUDE: spec generation, intent classify/extract,
    // matchmaker, and the architecture investigator now call Claude Sonnet
    // 4.6 directly (server-side key, not user-supplied). Operator Chat
    // itself is NOT included — that's the still-Gemini row above.
    { provider: 'anthropic', model_id: 'claude-sonnet-4-6', status: 'active', avg_latency: 700, cost_per_1k: '0.003', usage: 'Spec generation, intent classify/extract, matchmaker, architecture investigator' },
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
