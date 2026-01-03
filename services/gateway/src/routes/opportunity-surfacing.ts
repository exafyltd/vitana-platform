/**
 * VTID-01142: D48 Context-Aware Opportunity & Experience Surfacing Engine Routes
 *
 * API endpoints for surfacing contextual opportunities to users based on their
 * current life context and predictive windows.
 *
 * Hard Governance (Non-Negotiable):
 *   - Memory-first
 *   - Context-aware, not promotional
 *   - User-benefit > monetization
 *   - Explainability mandatory
 *   - No dark patterns
 *   - No forced actions
 *   - All outputs logged to OASIS
 *   - No schema-breaking changes
 *
 * Endpoints:
 *   POST /surface              - Surface opportunities based on context
 *   GET  /active               - Get active opportunities
 *   GET  /history              - Get opportunity history
 *   GET  /stats                - Get surfacing statistics
 *   POST /:id/dismiss          - Dismiss an opportunity
 *   POST /:id/engage           - Record engagement with opportunity
 */

import { Router, Request, Response } from 'express';
import {
  surfaceOpportunities,
  dismissOpportunity,
  recordEngagement,
  getActiveOpportunities,
  DEFAULT_SURFACING_RULES
} from '../services/d48-opportunity-surfacing-engine';
import {
  OpportunitySurfacingInput,
  OpportunityType,
  getDefaultPredictiveWindowsContext,
  getDefaultAnticipatoryGuidanceContext,
  getDefaultSocialAlignmentContext,
  isValidOpportunityType
} from '../types/opportunity-surfacing';
import { emitOasisEvent } from '../services/oasis-event-service';
import { createClient } from '@supabase/supabase-js';

const router = Router();
const LOG_PREFIX = '[D48-Routes]';
const VTID = 'VTID-01142';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

/**
 * Check if running in dev sandbox
 */
function isDevSandbox(): boolean {
  const env = (process.env.ENVIRONMENT || process.env.VITANA_ENV || '').toLowerCase();
  return env === 'dev-sandbox' ||
         env === 'dev' ||
         env === 'development' ||
         env === 'sandbox' ||
         env.includes('dev') ||
         env.includes('sandbox');
}

/**
 * Extract user context from request
 */
function extractUserContext(req: Request): { userId: string; tenantId: string; authToken?: string } | null {
  // Try to get from auth header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    // In production, decode JWT to get user/tenant IDs
    // For now, fall through to dev sandbox handling
  }

  // Dev sandbox fallback
  if (isDevSandbox()) {
    return {
      userId: DEV_IDENTITY.USER_ID,
      tenantId: DEV_IDENTITY.TENANT_ID
    };
  }

  return null;
}

/**
 * Create Supabase service client
 */
function createServiceClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// =============================================================================
// POST /surface - Surface opportunities based on context
// =============================================================================

/**
 * Surface opportunities based on user's current context
 *
 * Required body:
 * - predictive_windows: PredictiveWindowsContext
 * - anticipatory_guidance: AnticipatoryGuidanceContext
 * - social_alignment: SocialAlignmentContext
 *
 * Optional body:
 * - fusion_context: FusionContext
 * - location_context: { latitude, longitude, location_type }
 * - travel_context: { is_traveling, destination, travel_type }
 * - time_availability: { available_minutes, flexible }
 * - budget_sensitivity: 'high' | 'medium' | 'low' | 'unknown'
 * - surfacing_rules: Partial<SurfacingRules>
 * - requested_types: OpportunityType[]
 * - exclude_ids: string[]
 */
router.post('/surface', async (req: Request, res: Response) => {
  try {
    const userContext = extractUserContext(req);
    if (!userContext) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    const body = req.body || {};

    // Build input from request body
    const input: OpportunitySurfacingInput = {
      user_id: userContext.userId,
      tenant_id: userContext.tenantId,
      session_id: body.session_id,

      // Required inputs - use defaults if not provided
      predictive_windows: {
        ...getDefaultPredictiveWindowsContext(),
        ...(body.predictive_windows || {})
      },
      anticipatory_guidance: {
        ...getDefaultAnticipatoryGuidanceContext(),
        ...(body.anticipatory_guidance || {})
      },
      social_alignment: {
        ...getDefaultSocialAlignmentContext(),
        ...(body.social_alignment || {})
      },

      // Optional inputs
      fusion_context: body.fusion_context,
      location_context: body.location_context,
      travel_context: body.travel_context,
      time_availability: body.time_availability,
      budget_sensitivity: body.budget_sensitivity,
      surfacing_rules: body.surfacing_rules,
      requested_types: body.requested_types,
      exclude_ids: body.exclude_ids
    };

    // Validate requested_types if provided
    if (input.requested_types) {
      const invalidTypes = input.requested_types.filter(t => !isValidOpportunityType(t));
      if (invalidTypes.length > 0) {
        return res.status(400).json({
          ok: false,
          error: 'INVALID_OPPORTUNITY_TYPES',
          message: `Invalid opportunity types: ${invalidTypes.join(', ')}`,
          valid_types: ['experience', 'service', 'content', 'activity', 'place', 'offer']
        });
      }
    }

    const authToken = req.headers.authorization?.substring(7);
    const result = await surfaceOpportunities(input, authToken);

    if (!result.ok) {
      return res.status(500).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error in POST /surface:`, error);

    await emitOasisEvent({
      vtid: VTID,
      type: 'opportunity.surface.error',
      source: 'gateway-d48',
      status: 'error',
      message: `Surface endpoint error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      payload: { error: String(error) }
    });

    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =============================================================================
// GET /active - Get active opportunities
// =============================================================================

/**
 * Get active opportunities for the current user
 *
 * Query params:
 * - limit: number (default: 10, max: 50)
 */
router.get('/active', async (req: Request, res: Response) => {
  try {
    const userContext = extractUserContext(req);
    if (!userContext) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const authToken = req.headers.authorization?.substring(7);

    const result = await getActiveOpportunities(
      userContext.userId,
      userContext.tenantId,
      limit,
      authToken
    );

    return res.status(result.ok ? 200 : 500).json(result);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error in GET /active:`, error);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =============================================================================
// GET /history - Get opportunity history
// =============================================================================

/**
 * Get opportunity history for the current user
 *
 * Query params:
 * - status: comma-separated list of statuses (active, dismissed, engaged, expired)
 * - types: comma-separated list of types
 * - since: ISO timestamp
 * - limit: number (default: 50, max: 100)
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const userContext = extractUserContext(req);
    if (!userContext) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    const supabase = createServiceClient();
    if (!supabase) {
      return res.status(503).json({
        ok: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'Database connection not available'
      });
    }

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const statuses = req.query.status ? (req.query.status as string).split(',') : null;
    const types = req.query.types ? (req.query.types as string).split(',') : null;
    const since = req.query.since as string || null;

    let query = supabase
      .from('contextual_opportunities')
      .select('*')
      .eq('tenant_id', userContext.tenantId)
      .eq('user_id', userContext.userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (statuses) {
      query = query.in('status', statuses);
    }

    if (types) {
      query = query.in('opportunity_type', types);
    }

    if (since) {
      query = query.gte('created_at', since);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: error.message
      });
    }

    return res.status(200).json({
      ok: true,
      opportunities: data || [],
      count: data?.length || 0
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} Error in GET /history:`, error);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =============================================================================
// GET /stats - Get surfacing statistics
// =============================================================================

/**
 * Get surfacing statistics for the current user
 *
 * Query params:
 * - since: ISO timestamp (default: 30 days ago)
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const userContext = extractUserContext(req);
    if (!userContext) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    const supabase = createServiceClient();
    if (!supabase) {
      return res.status(503).json({
        ok: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'Database connection not available'
      });
    }

    const sinceParam = req.query.since as string;
    const since = sinceParam || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Get counts by status
    const { data: opportunities, error } = await supabase
      .from('contextual_opportunities')
      .select('status, opportunity_type, priority_domain')
      .eq('tenant_id', userContext.tenantId)
      .eq('user_id', userContext.userId)
      .gte('created_at', since);

    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: error.message
      });
    }

    const opps = opportunities || [];
    const total = opps.length;
    const active = opps.filter(o => o.status === 'active').length;
    const dismissed = opps.filter(o => o.status === 'dismissed').length;
    const engaged = opps.filter(o => o.status === 'engaged').length;
    const expired = opps.filter(o => o.status === 'expired').length;

    // Count by type
    const byType: Record<string, number> = {};
    for (const opp of opps) {
      byType[opp.opportunity_type] = (byType[opp.opportunity_type] || 0) + 1;
    }

    // Count by domain
    const byDomain: Record<string, number> = {};
    for (const opp of opps) {
      byDomain[opp.priority_domain] = (byDomain[opp.priority_domain] || 0) + 1;
    }

    return res.status(200).json({
      ok: true,
      since,
      total,
      active,
      dismissed,
      engaged,
      expired,
      dismissal_rate: total > 0 ? Math.round((dismissed / total) * 100 * 100) / 100 : 0,
      engagement_rate: total > 0 ? Math.round((engaged / total) * 100 * 100) / 100 : 0,
      by_type: byType,
      by_domain: byDomain
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} Error in GET /stats:`, error);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =============================================================================
// POST /:id/dismiss - Dismiss an opportunity
// =============================================================================

/**
 * Dismiss an opportunity
 *
 * Path params:
 * - id: opportunity UUID
 *
 * Body:
 * - reason: 'not_interested' | 'not_relevant' | 'already_done' | 'too_soon' | 'other'
 */
router.post('/:id/dismiss', async (req: Request, res: Response) => {
  try {
    const userContext = extractUserContext(req);
    if (!userContext) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    const opportunityId = req.params.id;
    if (!opportunityId) {
      return res.status(400).json({
        ok: false,
        error: 'MISSING_ID',
        message: 'Opportunity ID is required'
      });
    }

    const validReasons = ['not_interested', 'not_relevant', 'already_done', 'too_soon', 'other'];
    const reason = req.body?.reason || 'not_interested';

    if (!validReasons.includes(reason)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_REASON',
        message: `Invalid reason. Valid values: ${validReasons.join(', ')}`
      });
    }

    const authToken = req.headers.authorization?.substring(7);
    const result = await dismissOpportunity(
      opportunityId,
      userContext.userId,
      userContext.tenantId,
      reason,
      authToken
    );

    return res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error in POST /:id/dismiss:`, error);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =============================================================================
// POST /:id/engage - Record engagement with opportunity
// =============================================================================

/**
 * Record engagement with an opportunity
 *
 * Path params:
 * - id: opportunity UUID
 *
 * Body:
 * - type: 'viewed' | 'saved' | 'clicked' | 'completed'
 */
router.post('/:id/engage', async (req: Request, res: Response) => {
  try {
    const userContext = extractUserContext(req);
    if (!userContext) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    const opportunityId = req.params.id;
    if (!opportunityId) {
      return res.status(400).json({
        ok: false,
        error: 'MISSING_ID',
        message: 'Opportunity ID is required'
      });
    }

    const validTypes = ['viewed', 'saved', 'clicked', 'completed'];
    const engagementType = req.body?.type || 'viewed';

    if (!validTypes.includes(engagementType)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_TYPE',
        message: `Invalid engagement type. Valid values: ${validTypes.join(', ')}`
      });
    }

    const authToken = req.headers.authorization?.substring(7);
    const result = await recordEngagement(
      opportunityId,
      userContext.userId,
      userContext.tenantId,
      engagementType,
      authToken
    );

    return res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error in POST /:id/engage:`, error);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =============================================================================
// GET /config - Get surfacing configuration
// =============================================================================

/**
 * Get current surfacing configuration (for debugging/transparency)
 */
router.get('/config', async (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    vtid: VTID,
    rules: DEFAULT_SURFACING_RULES,
    priority_order: [
      { rank: 1, domain: 'health_wellbeing', description: 'Health & wellbeing' },
      { rank: 2, domain: 'social_relationships', description: 'Social belonging' },
      { rank: 3, domain: 'learning_growth', description: 'Personal growth' },
      { rank: 4, domain: 'exploration_discovery', description: 'Performance & productivity' },
      { rank: 5, domain: 'commerce_monetization', description: 'Commerce (last)' }
    ],
    opportunity_types: [
      { type: 'experience', description: 'Event, retreat, session' },
      { type: 'service', description: 'Coach, practitioner, lab, wellness' },
      { type: 'content', description: 'Article, guide, program' },
      { type: 'activity', description: 'Routine, ritual, challenge' },
      { type: 'place', description: 'Location-based wellness/social' },
      { type: 'offer', description: 'Aligned & non-intrusive offer' }
    ],
    ethical_constraints: [
      'No urgency manipulation',
      'No scarcity framing',
      'No pressure language',
      'Clear separation between value and offer',
      'Explainability mandatory',
      'No forced actions'
    ]
  });
});

// =============================================================================
// GET /health - Health check
// =============================================================================

router.get('/health', async (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    vtid: VTID,
    service: 'd48-opportunity-surfacing',
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

export default router;
