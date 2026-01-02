/**
 * VTID-01129: D35 Social Context Gateway Routes
 *
 * API endpoints for the Social Context, Relationship Weighting & Proximity Engine.
 *
 * Endpoints:
 * - GET  /api/v1/social/comfort        - Get user's comfort profile
 * - POST /api/v1/social/comfort        - Update user's comfort profile
 * - GET  /api/v1/social/proximity/:id  - Get proximity score for a node
 * - GET  /api/v1/social/connections    - Get relevant connections
 * - POST /api/v1/social/context        - Compute full social context bundle
 * - POST /api/v1/social/filter-actions - Filter actions by social context
 * - DELETE /api/v1/social/cache        - Invalidate proximity cache
 * - GET  /api/v1/social/health         - Health check
 *
 * Dependencies:
 * - VTID-01087 (Relationship Graph Memory)
 * - D20-D34 (Context Intelligence Stack)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getComfortProfile,
  updateComfortProfile,
  computeProximityScore,
  computeSocialContext,
  invalidateProximityCache,
  filterActionsForSocialContext,
  respectsSocialBoundaries,
  getOrbSocialContext
} from '../services/d35-social-context-engine';
import {
  ComputeSocialContextRequestSchema,
  UpdateComfortProfileRequestSchema,
  GetProximityScoreRequestSchema,
  SocialComfortProfile,
  ActionSocialContext
} from '../types/social-context';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();
const VTID = 'VTID-01129';

// =============================================================================
// Helper Functions
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
 * Emit a social context OASIS event
 */
async function emitSocialEvent(
  type: 'd35.api.request' | 'd35.api.error',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: VTID,
    type,
    source: 'social-context-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[${VTID}] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// Request Schemas
// =============================================================================

/**
 * Filter actions request schema
 */
const FilterActionsRequestSchema = z.object({
  actions: z.array(z.object({
    action_id: z.string().min(1),
    action_type: z.string().min(1),
    action_description: z.string().min(1),
    social_context: z.object({
      group_size: z.object({
        min: z.number().int().min(0),
        max: z.number().int().min(1)
      }),
      involves_new_people: z.boolean(),
      visibility: z.enum(['public', 'private', 'semi-private']),
      required_tier: z.enum(['close', 'weak', 'community', 'professional']).nullable().optional(),
      preferred_timing: z.enum(['morning', 'afternoon', 'evening', 'flexible']).optional().default('flexible')
    })
  })),
  include_filtered_out: z.boolean().optional().default(false)
});

/**
 * Check boundary request schema
 */
const CheckBoundaryRequestSchema = z.object({
  social_context: z.object({
    group_size: z.object({
      min: z.number().int().min(0),
      max: z.number().int().min(1)
    }),
    involves_new_people: z.boolean(),
    visibility: z.enum(['public', 'private', 'semi-private']),
    required_tier: z.enum(['close', 'weak', 'community', 'professional']).nullable().optional(),
    preferred_timing: z.enum(['morning', 'afternoon', 'evening', 'flexible']).optional().default('flexible')
  })
});

/**
 * Get connections query schema
 */
const GetConnectionsQuerySchema = z.object({
  domain: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

// =============================================================================
// Routes
// =============================================================================

/**
 * GET /comfort -> GET /api/v1/social/comfort
 *
 * Get user's social comfort profile
 */
router.get('/comfort', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /social/comfort`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  try {
    const result = await getComfortProfile(token);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    return res.status(200).json({
      ok: true,
      profile: result.profile
    });
  } catch (err: any) {
    console.error(`[${VTID}] get_comfort error:`, err.message);
    await emitSocialEvent('d35.api.error', 'error', 'Get comfort profile failed', { error: err.message });
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /comfort -> POST /api/v1/social/comfort
 *
 * Update user's social comfort profile
 */
router.post('/comfort', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /social/comfort`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = UpdateComfortProfileRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  try {
    const result = await updateComfortProfile(validation.data, token);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    return res.status(200).json({
      ok: true,
      profile: result.profile
    });
  } catch (err: any) {
    console.error(`[${VTID}] update_comfort error:`, err.message);
    await emitSocialEvent('d35.api.error', 'error', 'Update comfort profile failed', { error: err.message });
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /proximity/:id -> GET /api/v1/social/proximity/:id
 *
 * Get proximity score for a specific node
 */
router.get('/proximity/:id', async (req: Request, res: Response) => {
  const nodeId = req.params.id;
  console.log(`[${VTID}] GET /social/proximity/${nodeId}`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate UUID
  if (!nodeId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_NODE_ID',
      message: 'node_id must be a valid UUID'
    });
  }

  const contextDomain = req.query.domain as string | undefined;

  try {
    const result = await computeProximityScore({
      node_id: nodeId,
      context_domain: contextDomain
    }, token);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    return res.status(200).json({
      ok: true,
      score: result.score
    });
  } catch (err: any) {
    console.error(`[${VTID}] compute_proximity error:`, err.message);
    await emitSocialEvent('d35.api.error', 'error', 'Compute proximity failed', { error: err.message, node_id: nodeId });
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /connections -> GET /api/v1/social/connections
 *
 * Get relevant connections with proximity scores
 */
router.get('/connections', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /social/connections`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query parameters
  const queryValidation = GetConnectionsQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { domain, limit } = queryValidation.data;

  try {
    const result = await computeSocialContext({
      domain,
      max_connections: limit,
      include_actions: false,
      social_intent: false
    }, token);

    if (!result.ok || !result.bundle) {
      return res.status(400).json({
        ok: false,
        error: result.error,
        message: result.message
      });
    }

    return res.status(200).json({
      ok: true,
      connections: result.bundle.relevant_connections,
      count: result.bundle.relevant_connections.length,
      context_domain: domain
    });
  } catch (err: any) {
    console.error(`[${VTID}] get_connections error:`, err.message);
    await emitSocialEvent('d35.api.error', 'error', 'Get connections failed', { error: err.message });
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /context -> POST /api/v1/social/context
 *
 * Compute full social context bundle
 */
router.post('/context', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /social/context`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = ComputeSocialContextRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  try {
    const result = await computeSocialContext(validation.data, token);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    return res.status(200).json({
      ok: true,
      bundle: result.bundle,
      processing_time_ms: result.processing_time_ms
    });
  } catch (err: any) {
    console.error(`[${VTID}] compute_context error:`, err.message);
    await emitSocialEvent('d35.api.error', 'error', 'Compute context failed', { error: err.message });
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /filter-actions -> POST /api/v1/social/filter-actions
 *
 * Filter and weight actions based on social context
 */
router.post('/filter-actions', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /social/filter-actions`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = FilterActionsRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  try {
    // Get comfort profile first
    const profileResult = await getComfortProfile(token);
    if (!profileResult.ok || !profileResult.profile) {
      return res.status(400).json({
        ok: false,
        error: 'PROFILE_NOT_FOUND',
        message: 'Unable to retrieve comfort profile'
      });
    }

    // Get context to derive tags
    const contextResult = await computeSocialContext({
      include_actions: false,
      max_connections: 5,
      social_intent: false
    }, token);

    const contextTags = contextResult.ok && contextResult.bundle
      ? contextResult.bundle.context_tags
      : [];

    // Filter actions
    const filteredActions = filterActionsForSocialContext(
      validation.data.actions as any,
      profileResult.profile,
      contextTags
    );

    // Emit event for filtered actions
    await emitOasisEvent({
      vtid: VTID,
      type: 'd35.action.filtered',
      source: 'social-context-gateway',
      status: 'success',
      message: `Filtered ${validation.data.actions.length} actions to ${filteredActions.length}`,
      payload: {
        input_count: validation.data.actions.length,
        output_count: filteredActions.length,
        top_comfort_fit: filteredActions[0]?.comfort_fit
      }
    });

    console.log(`[${VTID}] Filtered ${validation.data.actions.length} actions to ${filteredActions.length}`);

    return res.status(200).json({
      ok: true,
      actions: filteredActions,
      input_count: validation.data.actions.length,
      output_count: filteredActions.length,
      context_tags: contextTags
    });
  } catch (err: any) {
    console.error(`[${VTID}] filter_actions error:`, err.message);
    await emitSocialEvent('d35.api.error', 'error', 'Filter actions failed', { error: err.message });
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /check-boundary -> POST /api/v1/social/check-boundary
 *
 * Check if an action respects social boundaries
 */
router.post('/check-boundary', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /social/check-boundary`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = CheckBoundaryRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  try {
    // Get comfort profile
    const profileResult = await getComfortProfile(token);
    if (!profileResult.ok || !profileResult.profile) {
      return res.status(400).json({
        ok: false,
        error: 'PROFILE_NOT_FOUND',
        message: 'Unable to retrieve comfort profile'
      });
    }

    // Check boundary
    const result = respectsSocialBoundaries(
      { social_context: validation.data.social_context as ActionSocialContext },
      profileResult.profile
    );

    if (!result.allowed) {
      // Emit boundary respected event
      await emitOasisEvent({
        vtid: VTID,
        type: 'd35.boundary.respected',
        source: 'social-context-gateway',
        status: 'info',
        message: `Action blocked: ${result.reason}`,
        payload: {
          reason: result.reason,
          social_context: validation.data.social_context
        }
      });
    }

    return res.status(200).json({
      ok: true,
      allowed: result.allowed,
      reason: result.reason
    });
  } catch (err: any) {
    console.error(`[${VTID}] check_boundary error:`, err.message);
    await emitSocialEvent('d35.api.error', 'error', 'Check boundary failed', { error: err.message });
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * DELETE /cache -> DELETE /api/v1/social/cache
 *
 * Invalidate proximity cache (optionally for specific node)
 */
router.delete('/cache', async (req: Request, res: Response) => {
  console.log(`[${VTID}] DELETE /social/cache`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const nodeId = req.query.node_id as string | undefined;

  // Validate UUID if provided
  if (nodeId && !nodeId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_NODE_ID',
      message: 'node_id must be a valid UUID'
    });
  }

  try {
    const result = await invalidateProximityCache(nodeId, token);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    console.log(`[${VTID}] Cache invalidated: ${result.deleted_count} entries`);

    return res.status(200).json({
      ok: true,
      deleted_count: result.deleted_count,
      node_id: nodeId || null
    });
  } catch (err: any) {
    console.error(`[${VTID}] invalidate_cache error:`, err.message);
    await emitSocialEvent('d35.api.error', 'error', 'Invalidate cache failed', { error: err.message });
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /orb-context -> GET /api/v1/social/orb-context
 *
 * Get formatted social context for ORB prompt injection
 */
router.get('/orb-context', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /social/orb-context`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const domain = req.query.domain as string | undefined;
  const intentType = req.query.intent_type as string | undefined;
  const emotionalState = req.query.emotional_state as string | undefined;

  try {
    const result = await getOrbSocialContext({
      domain,
      intent_type: intentType,
      emotional_state: emotionalState,
      social_intent: false,
      max_connections: 10,
      include_actions: false
    }, token);

    if (!result) {
      return res.status(200).json({
        ok: true,
        context: null,
        message: 'No social context available'
      });
    }

    return res.status(200).json({
      ok: true,
      context: result.context,
      bundle_id: result.bundle.metadata.bundle_id
    });
  } catch (err: any) {
    console.error(`[${VTID}] orb_context error:`, err.message);
    await emitSocialEvent('d35.api.error', 'error', 'Get ORB context failed', { error: err.message });
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /health -> GET /api/v1/social/health
 *
 * Health check for social context system
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'social-context-gateway',
    version: '1.0.0',
    vtid: VTID,
    timestamp: new Date().toISOString(),
    capabilities: {
      comfort_profile: hasSupabaseUrl && hasSupabaseKey,
      proximity_scoring: hasSupabaseUrl && hasSupabaseKey,
      context_computation: hasSupabaseUrl && hasSupabaseKey,
      action_filtering: true,
      boundary_checking: true,
      orb_integration: hasSupabaseUrl && hasSupabaseKey
    },
    dependencies: {
      'VTID-01087': 'relationship_graph_memory',
      'D20-D34': 'context_intelligence_stack'
    }
  });
});

export default router;
