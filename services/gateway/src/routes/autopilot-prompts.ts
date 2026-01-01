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

/**
 * Get user context (tenant_id, user_id) from authenticated request.
 * Uses the me context RPC to get the current user's identity.
 */
async function getUserContext(req: Request): Promise<{
  ok: boolean;
  tenant_id?: string;
  user_id?: string;
  error?: string;
}> {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, error: 'UNAUTHENTICATED' };
  }

  // Check for tenant_id in headers (for multi-tenant support)
  const headerTenantId = req.headers['x-tenant-id'] as string | undefined;

  try {
    const supabase = createUserSupabaseClient(token);

    // Call me_context RPC to get user identity
    const { data, error } = await supabase.rpc('me_context');

    if (error) {
      console.warn(`[${VTID}] me_context RPC error:`, error.message);

      // Fallback: try to get user directly from auth
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError || !authData?.user) {
        return { ok: false, error: 'Failed to get user context' };
      }

      // Use header tenant_id or default
      const tenantId = headerTenantId || '11111111-1111-1111-1111-111111111111'; // Default: Maxina

      return {
        ok: true,
        tenant_id: tenantId,
        user_id: authData.user.id,
      };
    }

    // Use tenant_id from context or header
    const tenantId = data?.tenant_id || headerTenantId || '11111111-1111-1111-1111-111111111111';

    return {
      ok: true,
      tenant_id: tenantId,
      user_id: data?.user_id || data?.id,
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
    return res.status(401).json({
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
    return res.status(401).json({
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
    return res.status(401).json({
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
    return res.status(401).json({
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
    return res.status(401).json({
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
router.get('/prompts/health', (_req: Request, res: Response) => {
  return res.status(200).json({
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
  });
});

export default router;
