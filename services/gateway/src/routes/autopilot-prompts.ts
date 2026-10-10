/**
 * Autopilot Prompts Routes - VTID-01089 Autopilot Matchmaking Prompts
 *
 * One-Tap Consent + Rate Limits + Opt-out for matchmaking suggestions.
 *
 * Endpoints:
 * - GET  /api/v1/autopilot/prompts/today     - Get today's prompts for user
 * - POST /api/v1/autopilot/prompts/generate  - Generate prompts from matches
 * - POST /api/v1/autopilot/prompts/:id/action - Execute action on a prompt
 * - GET  /api/v1/autopilot/prefs             - Get user prompt preferences
 * - POST /api/v1/autopilot/prefs             - Update user prompt preferences
 *
 * Dependencies:
 * - VTID-01088 (matches_daily table)
 * - VTID-01087 (relationship graph)
 * - Autopilot Growth Rule
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { getSupabase } from '../lib/supabase';
import { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { fetchPrimaryTenantForUser } from '../middleware/auth-supabase-jwt-repository';
import * as repo from './autopilot-prompts-repository';
import { withDependencyHealth } from '../services/dependency-probe';
import {
  UpdatePrefsRequestSchema,
  GeneratePromptsRequestSchema,
  PromptActionRequestSchema,
} from '../types/autopilot-prompts';
import {
  getPromptPrefs,
  updatePromptPrefs,
  generatePrompts,
  getTodayPrompts,
  executePromptAction,
} from '../services/autopilot-prompts-service';

const router = Router();
const VTID = 'VTID-01089';

// =============================================================================
// VTID-01089: Helper Functions
// =============================================================================

/**
 * Extract Bearer token from Authorization header.
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

const TENANT_LOOKUP_TIMEOUT_MS = 2500;

/**
 * VTID-05048: the caller's tenant when me_context does not carry one — the
 * verified identity's tenant, else the user's primary user_tenants row (the
 * same lookup requireTenant does). Never a header, never a default tenant.
 */
async function resolveFallbackTenant(req: Request, userId: string): Promise<string | null> {
  const identTenant = (req as AuthenticatedRequest).identity?.tenant_id;
  if (identTenant) return identTenant;
  const admin = getSupabase();
  if (!admin) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TENANT_LOOKUP_TIMEOUT_MS);
  try {
    const { data } = await fetchPrimaryTenantForUser(admin, userId, controller.signal);
    return (data as { tenant_id?: string } | null)?.tenant_id ?? null;
  } catch (err: any) {
    console.warn(`[${VTID}] primary tenant lookup failed for ${userId}: ${err?.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get user context (tenant_id, user_id) from authenticated request.
 * Uses the me context RPC to get the current user's identity.
 *
 * VTID-05048: the tenant used to fall back to a caller-supplied x-tenant-id
 * header and then to a hardcoded '1111…' id that is not a real tenant. Both
 * are gone: me_context → verified identity → primary user_tenants row, else
 * 400 TENANT_REQUIRED.
 */
async function getUserContext(req: Request): Promise<{
  ok: boolean;
  status?: number;
  tenant_id?: string;
  user_id?: string;
  error?: string;
}> {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, error: 'UNAUTHENTICATED' };
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Call me_context RPC to get user identity
    const { data, error } = await repo.fetchMeContext(supabase);

    let userId: string | undefined;
    let tenantId: string | null = null;

    if (error) {
      console.warn(`[${VTID}] me_context RPC error:`, error.message);

      // Fallback: try to get user directly from auth
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError || !authData?.user) {
        return { ok: false, error: 'Failed to get user context' };
      }
      userId = authData.user.id;
    } else {
      userId = data?.user_id || data?.id;
      tenantId = data?.tenant_id || null;
    }

    if (!userId) {
      return { ok: false, error: 'UNAUTHENTICATED' };
    }

    if (!tenantId) tenantId = await resolveFallbackTenant(req, userId);
    if (!tenantId) {
      return { ok: false, status: 400, error: 'TENANT_REQUIRED' };
    }

    return {
      ok: true,
      tenant_id: tenantId,
      user_id: userId,
    };
  } catch (err: any) {
    console.error(`[${VTID}] getUserContext error:`, err.message);
    return { ok: false, error: 'Failed to get user context' };
  }
}

// =============================================================================
// VTID-01089: Preferences Endpoints
// =============================================================================

/**
 * GET /prefs -> GET /api/v1/autopilot/prefs
 *
 * Get user prompt preferences.
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "prefs": {
 *     "enabled": true,
 *     "max_prompts_per_day": 5,
 *     "quiet_hours": { "from": "22:00", "to": "08:00" },
 *     "allow_types": ["person", "group", "event", "service"],
 *     "prompts_today": 2,
 *     "in_quiet_hours": false
 *   }
 * }
 */
router.get('/prefs', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /prefs`);

  const context = await getUserContext(req);
  if (!context.ok || !context.tenant_id || !context.user_id) {
    return res.status(context.status || 401).json({
      ok: false,
      error: context.error || 'UNAUTHENTICATED',
    });
  }

  const result = await getPromptPrefs(context.tenant_id, context.user_id);

  if (!result.ok) {
    return res.status(500).json({
      ok: false,
      error: result.error || 'Failed to get preferences',
    });
  }

  return res.status(200).json(result);
});

/**
 * POST /prefs -> POST /api/v1/autopilot/prefs
 *
 * Update user prompt preferences.
 *
 * Request body:
 * {
 *   "enabled": boolean,             // optional
 *   "max_prompts_per_day": number,  // optional (0-50)
 *   "quiet_hours": { "from": "HH:MM", "to": "HH:MM" } | null,  // optional
 *   "allow_types": ["person", "group", ...]  // optional
 * }
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "prefs": { ... }
 * }
 */
router.post('/prefs', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /prefs`);

  const context = await getUserContext(req);
  if (!context.ok || !context.tenant_id || !context.user_id) {
    return res.status(context.status || 401).json({
      ok: false,
      error: context.error || 'UNAUTHENTICATED',
    });
  }

  // Validate request body
  const validation = UpdatePrefsRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
  }

  const result = await updatePromptPrefs(
    context.tenant_id,
    context.user_id,
    validation.data
  );

  if (!result.ok) {
    return res.status(500).json({
      ok: false,
      error: result.error || 'Failed to update preferences',
    });
  }

  return res.status(200).json(result);
});

// =============================================================================
// VTID-01089: Prompts Endpoints
// =============================================================================

/**
 * GET /prompts/today -> GET /api/v1/autopilot/prompts/today
 *
 * Get today's prompts for the current user.
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "prompts": [ ... ],
 *   "rate_limit_info": {
 *     "max_per_day": 5,
 *     "used_today": 2,
 *     "remaining": 3,
 *     "in_quiet_hours": false
 *   }
 * }
 */
router.get('/prompts/today', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /prompts/today`);

  const context = await getUserContext(req);
  if (!context.ok || !context.tenant_id || !context.user_id) {
    return res.status(context.status || 401).json({
      ok: false,
      error: context.error || 'UNAUTHENTICATED',
    });
  }

  const result = await getTodayPrompts(context.tenant_id, context.user_id);

  if (!result.ok) {
    return res.status(500).json({
      ok: false,
      error: result.error || 'Failed to get prompts',
    });
  }

  return res.status(200).json(result);
});

/**
 * POST /prompts/generate -> POST /api/v1/autopilot/prompts/generate
 *
 * Generate prompts from matches_daily for the current user.
 * Enforces rate limits and quiet hours.
 *
 * Request body (optional):
 * {
 *   "score_threshold": 75,  // minimum match score (default: 75)
 *   "limit": 5              // max prompts to generate (default: 5)
 * }
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "generated": 3,
 *   "prompts": [ ... ],
 *   "rate_limit_info": { ... }
 * }
 */
router.post('/prompts/generate', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /prompts/generate`);

  const context = await getUserContext(req);
  if (!context.ok || !context.tenant_id || !context.user_id) {
    return res.status(context.status || 401).json({
      ok: false,
      error: context.error || 'UNAUTHENTICATED',
    });
  }

  // Validate request body (with defaults)
  const validation = GeneratePromptsRequestSchema.safeParse(req.body || {});
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
  }

  const result = await generatePrompts(
    context.tenant_id,
    context.user_id,
    validation.data
  );

  if (!result.ok) {
    return res.status(500).json({
      ok: false,
      error: result.error || 'Failed to generate prompts',
    });
  }

  return res.status(200).json(result);
});

/**
 * POST /prompts/:id/action -> POST /api/v1/autopilot/prompts/:id/action
 *
 * Execute an action on a prompt.
 *
 * Request body:
 * {
 *   "action": "yes" | "not_now" | "options"
 * }
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "prompt_id": "uuid",
 *   "action": "yes",
 *   "new_state": "accepted",
 *   "action_result": { ... }  // only for "yes"
 *   "options": [ ... ]        // only for "options"
 * }
 *
 * Action behaviors:
 * - "yes": Executes the action based on match type:
 *   - person: create connection request
 *   - group: join group
 *   - event: RSVP/join
 *   - service/product/location: save interest edge
 * - "not_now": state → dismissed
 * - "options": returns top 5 candidates of same type (no state change)
 */
router.post('/prompts/:id/action', async (req: Request, res: Response) => {
  const promptId = req.params.id;
  console.log(`[${VTID}] POST /prompts/${promptId}/action`);

  const context = await getUserContext(req);
  if (!context.ok || !context.tenant_id || !context.user_id) {
    return res.status(context.status || 401).json({
      ok: false,
      error: context.error || 'UNAUTHENTICATED',
    });
  }

  // Validate request body
  const validation = PromptActionRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
  }

  const result = await executePromptAction(
    context.tenant_id,
    context.user_id,
    promptId,
    validation.data
  );

  if (!result.ok) {
    if (result.error === 'Prompt not found') {
      return res.status(404).json({
        ok: false,
        error: 'Prompt not found',
      });
    }
    return res.status(500).json({
      ok: false,
      error: result.error || 'Failed to execute action',
    });
  }

  return res.status(200).json(result);
});

// =============================================================================
// VTID-01089: Health Check
// =============================================================================

/**
 * GET /prompts/health -> GET /api/v1/autopilot/prompts/health
 *
 * Health check for autopilot prompts service.
 */
router.get('/prompts/health', async (_req: Request, res: Response) => {
  // VTID-04665: report whether the dependency answers, not just that the route exists.
  return res.status(200).json(await withDependencyHealth([{ table: 'autopilot_prompts' }], {
    ok: true,
    service: 'autopilot-prompts',
    vtid: VTID,
    timestamp: new Date().toISOString(),
    status: 'healthy',
    capabilities: {
      prompts: true,
      preferences: true,
      rate_limits: true,
      quiet_hours: true,
      oasis_events: true,
    },
  }));
});

export default router;
