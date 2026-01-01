/**
 * VTID-01094: Match Quality Feedback Loop
 *
 * Gateway endpoints for match feedback and personalization changes.
 *
 * Endpoints:
 * - POST /api/v1/match/:id/feedback  - Record feedback on a match
 * - GET  /api/v1/personalization/changes - Get "Why improved?" history
 * - GET  /api/v1/match/:id - Get match details
 * - GET  /api/v1/matches - Get user's matches
 *
 * Dependencies:
 * - VTID-01088 (matches_daily)
 * - VTID-01093 (user_topic_profile)
 * - VTID-01087 (relationship_edges)
 * - VTID-01094 (match_feedback, personalization_change_log)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01094: Constants & Schemas
// =============================================================================

const FEEDBACK_TYPES = ['like', 'dislike', 'block', 'wrong_topic'] as const;
type FeedbackType = typeof FEEDBACK_TYPES[number];

/**
 * Match feedback request schema
 */
const MatchFeedbackRequestSchema = z.object({
  feedback_type: z.enum(FEEDBACK_TYPES),
  topic_key: z.string().optional(),
  note: z.string().max(500).optional()
});

type MatchFeedbackRequest = z.infer<typeof MatchFeedbackRequestSchema>;

/**
 * Personalization changes query schema
 */
const PersonalizationChangesQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

// =============================================================================
// VTID-01094: Helpers
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
 * Emit OASIS event for match feedback actions
 */
async function emitMatchFeedbackEvent(
  type: 'match.feedback.recorded' | 'topics.profile.updated.from_feedback' | 'personalization.change_log.written',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01094',
    type: type as any,
    source: 'match-feedback-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01094] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01094: Routes
// =============================================================================

/**
 * POST /:id/feedback -> POST /api/v1/match/:id/feedback
 *
 * Record feedback on a match with deterministic personalization updates.
 *
 * Request body:
 * - feedback_type: 'like' | 'dislike' | 'block' | 'wrong_topic'
 * - topic_key: string (required for wrong_topic)
 * - note: string (optional)
 *
 * Response:
 * - ok: boolean
 * - feedback_id: UUID
 * - feedback_type: string
 * - match_id: UUID
 * - changes: array of topic changes applied
 */
router.post('/:id/feedback', async (req: Request, res: Response) => {
  const matchId = req.params.id;
  console.log(`[VTID-01094] POST /match/${matchId}/feedback`);

  // 1. Auth check
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Bearer token required'
    });
  }

  // 2. Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(matchId)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_MATCH_ID',
      message: 'Match ID must be a valid UUID'
    });
  }

  // 3. Validate request body
  const validation = MatchFeedbackRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01094] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { feedback_type, topic_key, note } = validation.data;

  // 4. Additional validation for wrong_topic
  if (feedback_type === 'wrong_topic' && !topic_key) {
    return res.status(400).json({
      ok: false,
      error: 'TOPIC_KEY_REQUIRED',
      message: 'topic_key is required when feedback_type is wrong_topic'
    });
  }

  // 5. Check Supabase config
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[VTID-01094] Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    return res.status(503).json({
      ok: false,
      error: 'GATEWAY_MISCONFIGURED',
      message: 'Supabase credentials not configured'
    });
  }

  try {
    // 6. Create user-context Supabase client
    const supabase = createUserSupabaseClient(token);

    // 7. Call record_match_feedback RPC
    const { data, error } = await supabase.rpc('record_match_feedback', {
      p_payload: {
        match_id: matchId,
        feedback_type,
        topic_key: topic_key || null,
        note: note || null
      }
    });

    if (error) {
      // Check if RPC doesn't exist (migration not applied)
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01094] record_match_feedback RPC not found (migration not applied)');
        return res.status(503).json({
          ok: false,
          error: 'RPC_NOT_AVAILABLE',
          message: 'Match feedback RPC not available (VTID-01094 migration pending)'
        });
      }

      console.error('[VTID-01094] record_match_feedback RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: 'RPC_ERROR',
        message: error.message
      });
    }

    // 8. Check RPC response
    if (!data || data.ok === false) {
      const errorCode = data?.error || 'UNKNOWN_ERROR';
      console.warn(`[VTID-01094] Feedback failed: ${errorCode}`);

      // Map error codes to HTTP status
      const statusMap: Record<string, number> = {
        'TENANT_NOT_FOUND': 403,
        'UNAUTHENTICATED': 401,
        'MATCH_ID_REQUIRED': 400,
        'INVALID_FEEDBACK_TYPE': 400,
        'TOPIC_KEY_REQUIRED_FOR_WRONG_TOPIC': 400,
        'MATCH_NOT_FOUND': 404
      };

      return res.status(statusMap[errorCode] || 400).json({
        ok: false,
        error: errorCode,
        message: data?.message || 'Feedback recording failed'
      });
    }

    // 9. Emit OASIS events
    const changes = data.changes || [];
    const topicDeltas: Record<string, number> = {};
    for (const change of changes) {
      if (change.topic_key && change.delta !== undefined) {
        topicDeltas[change.topic_key] = change.delta;
      }
    }

    // Event 1: Feedback recorded
    await emitMatchFeedbackEvent(
      'match.feedback.recorded',
      'success',
      `Match feedback recorded: ${feedback_type}`,
      {
        vtid: 'VTID-01094',
        feedback_id: data.feedback_id,
        feedback_type,
        match_id: matchId,
        topic_key: topic_key || null,
        has_note: !!note
      }
    );

    // Event 2: Topic profile updated (if there are changes)
    if (Object.keys(topicDeltas).length > 0) {
      await emitMatchFeedbackEvent(
        'topics.profile.updated.from_feedback',
        'success',
        `Topic profile updated from ${feedback_type} feedback`,
        {
          vtid: 'VTID-01094',
          feedback_type,
          match_id: matchId,
          deltas: topicDeltas,
          topics_affected: Object.keys(topicDeltas).length
        }
      );
    }

    // Event 3: Change log written
    await emitMatchFeedbackEvent(
      'personalization.change_log.written',
      'success',
      `Personalization change logged for ${feedback_type}`,
      {
        vtid: 'VTID-01094',
        feedback_id: data.feedback_id,
        feedback_type,
        match_id: matchId,
        changes_count: changes.length
      }
    );

    console.log(`[VTID-01094] Feedback recorded: ${data.feedback_id} (${feedback_type})`);

    // 10. Return success
    return res.status(200).json({
      ok: true,
      feedback_id: data.feedback_id,
      feedback_type: data.feedback_type,
      match_id: data.match_id,
      changes: data.changes || []
    });

  } catch (err: any) {
    console.error('[VTID-01094] Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

// Note: GET / and GET /:id routes are handled by the matchmaking router (VTID-01088)
// This router only adds POST /:id/feedback for the feedback loop

export default router;

// =============================================================================
// Personalization Changes Router (mounted separately at /api/v1/personalization)
// =============================================================================

export const personalizationRouter = Router();

/**
 * GET /changes -> GET /api/v1/personalization/changes
 *
 * Get "Why improved?" personalization change history.
 *
 * Query params:
 * - from: YYYY-MM-DD (optional)
 * - to: YYYY-MM-DD (optional)
 * - limit: number 1-200 (default 50)
 */
personalizationRouter.get('/changes', async (req: Request, res: Response) => {
  console.log('[VTID-01094] GET /personalization/changes');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate query params
  const queryValidation = PersonalizationChangesQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_QUERY_PARAMS',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { from, to, limit } = queryValidation.data;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'GATEWAY_MISCONFIGURED'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Call get_personalization_changes RPC
    const { data, error } = await supabase.rpc('get_personalization_changes', {
      p_from: from || null,
      p_to: to || null,
      p_limit: limit
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'RPC_NOT_AVAILABLE',
          message: 'Personalization RPC not available (VTID-01094 migration pending)'
        });
      }
      console.error('[VTID-01094] get_personalization_changes error:', error.message);
      return res.status(502).json({
        ok: false,
        error: 'RPC_ERROR',
        message: error.message
      });
    }

    if (!data || data.ok === false) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'UNKNOWN_ERROR'
      });
    }

    // Format changes for UI consumption with templates
    const formattedChanges = (data.changes || []).map((change: any) => {
      const changes = change.changes || {};
      const feedbackType = changes.feedback_type;
      const topicChanges = changes.topic_changes || [];

      // Generate human-readable explanations (templates, no LLM)
      const explanations: string[] = [];

      for (const tc of topicChanges) {
        const delta = tc.delta;
        const sign = delta >= 0 ? '+' : '';
        const action = feedbackType === 'like' ? 'liked'
          : feedbackType === 'dislike' ? 'disliked'
          : feedbackType === 'block' ? 'blocked'
          : 'corrected topic for';

        explanations.push(`You ${action} a match → ${tc.topic_key} (${sign}${delta})`);
      }

      return {
        id: change.id,
        date: change.change_date,
        source: change.source,
        feedback_type: feedbackType,
        explanations,
        raw: changes,
        created_at: change.created_at
      };
    });

    console.log(`[VTID-01094] Personalization changes fetched: ${formattedChanges.length} entries`);

    return res.status(200).json({
      ok: true,
      changes: formattedChanges,
      query: data.query
    });

  } catch (err: any) {
    console.error('[VTID-01094] Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

/**
 * GET /topics -> GET /api/v1/personalization/topics
 *
 * Get user's current topic profile scores.
 */
personalizationRouter.get('/topics', async (req: Request, res: Response) => {
  console.log('[VTID-01094] GET /personalization/topics');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      ok: false,
      error: 'GATEWAY_MISCONFIGURED'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase
      .from('user_topic_profile')
      .select('topic_key, score, source, updated_at')
      .order('score', { ascending: false });

    if (error) {
      if (error.message.includes('relation') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'TABLE_NOT_AVAILABLE',
          message: 'user_topic_profile table not available'
        });
      }
      return res.status(502).json({
        ok: false,
        error: 'QUERY_ERROR',
        message: error.message
      });
    }

    return res.status(200).json({
      ok: true,
      topics: data || [],
      count: data?.length || 0
    });

  } catch (err: any) {
    console.error('[VTID-01094] Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /health -> GET /api/v1/personalization/health
 *
 * Health check for personalization system.
 */
personalizationRouter.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'match-feedback-gateway',
    version: '1.0.0',
    vtid: 'VTID-01094',
    timestamp: new Date().toISOString(),
    capabilities: {
      feedback: hasSupabaseUrl && hasSupabaseKey,
      personalization_changes: hasSupabaseUrl && hasSupabaseKey,
      topic_profile: hasSupabaseUrl && hasSupabaseKey
    },
    dependencies: {
      'VTID-01088': 'matches_daily',
      'VTID-01093': 'user_topic_profile',
      'VTID-01087': 'relationship_edges',
      'VTID-01094': 'match_feedback + personalization_change_log'
    },
    feedback_types: FEEDBACK_TYPES,
    deterministic_rules: {
      like: { topic_delta: '+8', edge_delta: '+10' },
      dislike: { topic_delta: '-6', dampening_days: 7 },
      block: { topic_delta: '-10', block_days: 90 },
      wrong_topic: { detected_delta: '-6', provided_delta: '+10' }
    }
  });
});
