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
import { z } from 'zod';
import {
  getRoutingPolicyResponse,
  updateRoutingPolicy,
  resetToDefaults,
  getPolicyAuditHistory,
} from '../services/llm-routing-policy-service';
import { queryLLMTelemetry } from '../services/llm-telemetry-service';
import { LLM_SAFE_DEFAULTS, VALID_STAGES, VALID_PROVIDERS } from '../constants/llm-defaults';

const router = Router();

// =============================================================================
// Validation Schemas
// =============================================================================

const StageConfigSchema = z.object({
  primary_provider: z.enum(['anthropic', 'vertex', 'openai'] as const),
  primary_model: z.string().min(1),
  fallback_provider: z.enum(['anthropic', 'vertex', 'openai'] as const),
  fallback_model: z.string().min(1),
});

const PolicySchema = z.object({
  planner: StageConfigSchema,
  worker: StageConfigSchema,
  validator: StageConfigSchema,
  operator: StageConfigSchema,
  memory: StageConfigSchema,
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
  stage: z.enum(['planner', 'worker', 'validator', 'operator', 'memory'] as const).optional(),
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
