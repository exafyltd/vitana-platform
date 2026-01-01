/**
 * VTID-01084: Community Personalization v1 (Gateway Routes)
 *
 * Longevity-focused community matching using deterministic signals from:
 * - Diary entries (memory_items)
 * - Memory Garden nodes (values/goals/habits)
 * - Longevity signals (sleep/stress/movement/social from vitana_index_scores)
 *
 * Endpoints:
 * - POST /api/v1/community/groups              - Create a community group
 * - POST /api/v1/community/groups/:id/join     - Join a community group
 * - POST /api/v1/community/meetups             - Create a meetup
 * - POST /api/v1/community/recommendations/recompute - Recompute recommendations
 * - GET  /api/v1/community/recommendations     - Get recommendations
 * - GET  /api/v1/community/recommendations/:id/explain - Get recommendation explanation
 * - GET  /api/v1/community/health              - Health check
 *
 * Dependencies:
 * - VTID-01102 (context bridge)
 * - VTID-01104 (memory RPC)
 * - VTID-01078 (health brain)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01084: Constants & Types
// =============================================================================

const VTID = 'VTID-01084';

/**
 * Create group request schema
 */
const CreateGroupRequestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  topic_key: z.string().min(1, 'Topic key is required'),
  description: z.string().optional(),
  is_public: z.boolean().default(true)
});

/**
 * Create meetup request schema
 */
const CreateMeetupRequestSchema = z.object({
  group_id: z.string().uuid('Invalid group ID'),
  title: z.string().min(1, 'Title is required'),
  starts_at: z.string().datetime('Invalid starts_at datetime'),
  ends_at: z.string().datetime('Invalid ends_at datetime'),
  location_text: z.string().optional().nullable(),
  mode: z.enum(['online', 'in_person']).default('online')
});

/**
 * Recompute recommendations request schema
 */
const RecomputeRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format').optional()
});

/**
 * Get recommendations query schema
 */
const GetRecommendationsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format').optional(),
  type: z.enum(['group', 'meetup']).optional()
});

// =============================================================================
// VTID-01084: Helper Functions
// =============================================================================

/**
 * Extract Bearer token from Authorization header
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Emit a community-related OASIS event
 */
async function emitCommunityEvent(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: VTID,
    type: type as any,
    source: 'community-gateway',
    status,
    message,
    payload: {
      ...payload,
      vtid: VTID
    }
  }).catch(err => console.warn(`[${VTID}] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01084: Routes
// =============================================================================

/**
 * POST /groups -> POST /api/v1/community/groups
 *
 * Create a new community group.
 */
router.post('/groups', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /community/groups`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = CreateGroupRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('community_create_group', {
      p_payload: validation.data
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn(`[${VTID}] community_create_group RPC not found (migration not deployed)`);
        return res.status(503).json({
          ok: false,
          error: 'Community RPC not available (VTID-01084 dependency)'
        });
      }
      console.error(`[${VTID}] community_create_group RPC error:`, error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Emit OASIS event
    await emitCommunityEvent(
      'community.group.created',
      'success',
      `Group created: ${validation.data.name}`,
      {
        group_id: data?.id,
        name: validation.data.name,
        topic_key: validation.data.topic_key
      }
    );

    console.log(`[${VTID}] Group created: ${data?.id}`);

    return res.status(201).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] create group error:`, err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /groups/:id/join -> POST /api/v1/community/groups/:id/join
 *
 * Join a community group.
 */
router.post('/groups/:id/join', async (req: Request, res: Response) => {
  const groupId = req.params.id;
  console.log(`[${VTID}] POST /community/groups/${groupId}/join`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate group ID is a valid UUID
  const uuidSchema = z.string().uuid('Invalid group ID');
  const uuidValidation = uuidSchema.safeParse(groupId);
  if (!uuidValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid group ID format'
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('community_join_group', {
      p_group_id: groupId
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn(`[${VTID}] community_join_group RPC not found (migration not deployed)`);
        return res.status(503).json({
          ok: false,
          error: 'Community RPC not available (VTID-01084 dependency)'
        });
      }
      console.error(`[${VTID}] community_join_group RPC error:`, error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (data && !data.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitCommunityEvent(
      'community.membership.joined',
      'success',
      `User joined group: ${groupId}`,
      {
        group_id: groupId,
        membership_id: data?.membership_id
      }
    );

    console.log(`[${VTID}] User joined group: ${groupId}`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] join group error:`, err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /meetups -> POST /api/v1/community/meetups
 *
 * Create a new meetup.
 */
router.post('/meetups', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /community/meetups`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = CreateMeetupRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('community_create_meetup', {
      p_payload: validation.data
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn(`[${VTID}] community_create_meetup RPC not found (migration not deployed)`);
        return res.status(503).json({
          ok: false,
          error: 'Community RPC not available (VTID-01084 dependency)'
        });
      }
      console.error(`[${VTID}] community_create_meetup RPC error:`, error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (data && !data.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitCommunityEvent(
      'community.meetup.created',
      'success',
      `Meetup created: ${validation.data.title}`,
      {
        meetup_id: data?.id,
        title: validation.data.title,
        group_id: validation.data.group_id,
        starts_at: validation.data.starts_at
      }
    );

    console.log(`[${VTID}] Meetup created: ${data?.id}`);

    return res.status(201).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] create meetup error:`, err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /recommendations/recompute -> POST /api/v1/community/recommendations/recompute
 *
 * Recompute recommendations for the current user.
 */
router.post('/recommendations/recompute', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /community/recommendations/recompute`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = RecomputeRequestSchema.safeParse(req.body || {});
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('community_recompute_recommendations', {
      p_user_id: null, // Will use auth.uid() in RPC
      p_date: validation.data.date || null
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn(`[${VTID}] community_recompute_recommendations RPC not found (migration not deployed)`);
        return res.status(503).json({
          ok: false,
          error: 'Community RPC not available (VTID-01084 dependency)'
        });
      }
      console.error(`[${VTID}] community_recompute_recommendations RPC error:`, error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Emit OASIS event
    await emitCommunityEvent(
      'community.recommendations.recomputed',
      'success',
      `Recommendations recomputed: ${data?.groups || 0} groups, ${data?.meetups || 0} meetups`,
      {
        rec_date: data?.rec_date,
        groups_count: data?.groups || 0,
        meetups_count: data?.meetups || 0
      }
    );

    console.log(`[${VTID}] Recommendations recomputed: ${data?.groups || 0} groups, ${data?.meetups || 0} meetups`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] recompute recommendations error:`, err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /recommendations -> GET /api/v1/community/recommendations
 *
 * Get recommendations for the current user.
 */
router.get('/recommendations', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /community/recommendations`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate query parameters
  const queryValidation = GetRecommendationsQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { date, type } = queryValidation.data;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('community_get_recommendations', {
      p_user_id: null, // Will use auth.uid() in RPC
      p_date: date || null,
      p_type: type || null
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn(`[${VTID}] community_get_recommendations RPC not found (migration not deployed)`);
        return res.status(503).json({
          ok: false,
          error: 'Community RPC not available (VTID-01084 dependency)'
        });
      }
      console.error(`[${VTID}] community_get_recommendations RPC error:`, error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    // Emit OASIS event
    await emitCommunityEvent(
      'community.recommendations.read',
      'success',
      `Recommendations fetched: ${data?.count || 0} items`,
      {
        rec_date: data?.rec_date,
        count: data?.count || 0,
        type_filter: type || 'all'
      }
    );

    console.log(`[${VTID}] Recommendations fetched: ${data?.count || 0} items`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] get recommendations error:`, err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /recommendations/:id/explain -> GET /api/v1/community/recommendations/:id/explain
 *
 * Get detailed explanation for a specific recommendation.
 */
router.get('/recommendations/:id/explain', async (req: Request, res: Response) => {
  const recommendationId = req.params.id;
  console.log(`[${VTID}] GET /community/recommendations/${recommendationId}/explain`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate recommendation ID is a valid UUID
  const uuidSchema = z.string().uuid('Invalid recommendation ID');
  const uuidValidation = uuidSchema.safeParse(recommendationId);
  if (!uuidValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid recommendation ID format'
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'Gateway misconfigured'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('community_get_recommendation_explain', {
      p_recommendation_id: recommendationId
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn(`[${VTID}] community_get_recommendation_explain RPC not found (migration not deployed)`);
        return res.status(503).json({
          ok: false,
          error: 'Community RPC not available (VTID-01084 dependency)'
        });
      }
      console.error(`[${VTID}] community_get_recommendation_explain RPC error:`, error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (data && !data.ok) {
      if (data.error === 'NOT_FOUND') {
        return res.status(404).json(data);
      }
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitCommunityEvent(
      'community.recommendation.explain.read',
      'success',
      `Recommendation explanation fetched: ${recommendationId}`,
      {
        recommendation_id: recommendationId,
        rec_type: data?.recommendation?.rec_type,
        matched_rules: data?.evidence?.matched_rules
      }
    );

    console.log(`[${VTID}] Recommendation explanation fetched: ${recommendationId}`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] get recommendation explain error:`, err.message);
    return res.status(502).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /health -> GET /api/v1/community/health
 *
 * Health check for community system.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'community-gateway',
    version: '1.0.0',
    vtid: VTID,
    timestamp: new Date().toISOString(),
    capabilities: {
      create_groups: hasSupabaseUrl && hasSupabaseKey,
      create_meetups: hasSupabaseUrl && hasSupabaseKey,
      join_groups: hasSupabaseUrl && hasSupabaseKey,
      recommendations: hasSupabaseUrl && hasSupabaseKey,
      explain: hasSupabaseUrl && hasSupabaseKey
    },
    dependencies: {
      'VTID-01102': 'context_bridge',
      'VTID-01104': 'memory_core',
      'VTID-01078': 'health_brain'
    }
  });
});

export default router;
