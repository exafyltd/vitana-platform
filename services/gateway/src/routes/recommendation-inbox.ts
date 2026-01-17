/**
 * Recommendation Inbox Routes - VTID-01180
 *
 * API endpoints for the Autopilot Recommendation Inbox that powers the
 * popup/notification inbox in the frontend. Users can view, read, accept,
 * dismiss, or snooze personalized health recommendations.
 *
 * Endpoints:
 * - GET /inbox - List pending recommendations
 * - GET /inbox/count - Get count for badge
 * - POST /:id/read - Mark as read
 * - POST /:id/accept - Accept/take action
 * - POST /:id/dismiss - Dismiss (not interested)
 * - POST /:id/snooze - Snooze for later
 * - POST /:id/feedback - Submit rating/feedback
 */

import { Router, Request, Response } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

const LOG_PREFIX = '[VTID-01180]';

// =============================================================================
// Helper: Supabase RPC call
// =============================================================================
async function callRpc<T>(
  functionName: string,
  params: Record<string, unknown>,
  authToken?: string
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': authToken ? `Bearer ${authToken}` : `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = await response.json() as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Helper: Extract user ID from request
// =============================================================================
function getUserId(req: Request): string | null {
  // Check for user ID in various places:
  // 1. JWT token (if auth middleware sets it)
  // 2. X-User-ID header (for service-to-service calls)
  // 3. Query param (for testing)

  // @ts-ignore - user may be set by auth middleware
  if (req.user?.id) return req.user.id;
  // @ts-ignore - user may be set by auth middleware
  if (req.user?.sub) return req.user.sub;

  const headerUserId = req.get('X-User-ID');
  if (headerUserId) return headerUserId;

  const queryUserId = req.query.user_id as string;
  if (queryUserId) return queryUserId;

  return null;
}

// =============================================================================
// GET /inbox - List pending recommendations
// =============================================================================
/**
 * GET /inbox
 *
 * Query params:
 * - status: comma-separated status filter (default: 'pending,snoozed')
 * - limit: max items (default: 20, max: 100)
 * - offset: pagination offset (default: 0)
 *
 * Response:
 * {
 *   ok: true,
 *   recommendations: [...],
 *   count: number,
 *   has_more: boolean
 * }
 */
router.get('/inbox', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'User ID required' });
    }

    // Parse query params
    const statusParam = req.query.status as string || 'pending,snoozed';
    const statuses = statusParam.split(',').map(s => s.trim());
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    console.log(`${LOG_PREFIX} Inbox requested for user ${userId.slice(0, 8)}... (limit: ${limit}, offset: ${offset})`);

    const result = await callRpc<any[]>('get_recommendation_inbox', {
      p_user_id: userId,
      p_status: statuses,
      p_limit: limit + 1, // Fetch one extra to check has_more
      p_offset: offset,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const recommendations = result.data || [];
    const hasMore = recommendations.length > limit;
    if (hasMore) {
      recommendations.pop(); // Remove the extra item
    }

    return res.status(200).json({
      ok: true,
      recommendations,
      count: recommendations.length,
      has_more: hasMore,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Inbox error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// GET /inbox/count - Get count for badge
// =============================================================================
/**
 * GET /inbox/count
 *
 * Response:
 * {
 *   ok: true,
 *   count: number
 * }
 */
router.get('/inbox/count', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'User ID required' });
    }

    console.log(`${LOG_PREFIX} Inbox count requested for user ${userId.slice(0, 8)}...`);

    const result = await callRpc<number>('get_recommendation_inbox_count', {
      p_user_id: userId,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.status(200).json({
      ok: true,
      count: result.data || 0,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Inbox count error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /:id/read - Mark as read
// =============================================================================
/**
 * POST /:id/read
 *
 * Marks a recommendation as read (viewed by user).
 */
router.post('/:id/read', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'User ID required' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    console.log(`${LOG_PREFIX} Marking recommendation ${id.slice(0, 8)}... as read`);

    const result = await callRpc<any>('mark_recommendation_read', {
      p_recommendation_id: id,
      p_user_id: userId,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const response = result.data;
    if (!response?.ok) {
      return res.status(400).json({ ok: false, error: response?.error || 'Failed to mark as read' });
    }

    return res.status(200).json({
      ...response,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Mark read error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /:id/accept - Accept/take action
// =============================================================================
/**
 * POST /:id/accept
 *
 * Body:
 * {
 *   action_taken?: { ... } // Optional metadata about what action was taken
 * }
 */
router.post('/:id/accept', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'User ID required' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    const { action_taken } = req.body;

    console.log(`${LOG_PREFIX} Accepting recommendation ${id.slice(0, 8)}...`);

    const result = await callRpc<any>('accept_recommendation', {
      p_recommendation_id: id,
      p_user_id: userId,
      p_action_taken: action_taken || {},
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const response = result.data;
    if (!response?.ok) {
      return res.status(400).json({ ok: false, error: response?.error || 'Failed to accept' });
    }

    // Emit OASIS event for tracking
    await emitOasisEvent({
      vtid: 'SYSTEM',
      type: 'autopilot.recommendation.accepted' as any,
      source: 'recommendation-inbox',
      status: 'info',
      message: `User accepted recommendation`,
      payload: {
        recommendation_id: id,
        user_id: userId,
        action_taken,
      },
    });

    return res.status(200).json({
      ...response,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Accept error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /:id/dismiss - Dismiss (not interested)
// =============================================================================
/**
 * POST /:id/dismiss
 *
 * Body:
 * {
 *   feedback_note?: string // Optional reason for dismissal
 * }
 */
router.post('/:id/dismiss', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'User ID required' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    const { feedback_note } = req.body;

    console.log(`${LOG_PREFIX} Dismissing recommendation ${id.slice(0, 8)}...`);

    const result = await callRpc<any>('dismiss_recommendation', {
      p_recommendation_id: id,
      p_user_id: userId,
      p_feedback_note: feedback_note || null,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const response = result.data;
    if (!response?.ok) {
      return res.status(400).json({ ok: false, error: response?.error || 'Failed to dismiss' });
    }

    // Emit OASIS event for tracking
    await emitOasisEvent({
      vtid: 'SYSTEM',
      type: 'autopilot.recommendation.dismissed' as any,
      source: 'recommendation-inbox',
      status: 'info',
      message: `User dismissed recommendation`,
      payload: {
        recommendation_id: id,
        user_id: userId,
        feedback_note,
      },
    });

    return res.status(200).json({
      ...response,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Dismiss error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /:id/snooze - Snooze for later
// =============================================================================
/**
 * POST /:id/snooze
 *
 * Body:
 * {
 *   hours?: number // Hours to snooze (default: 24)
 * }
 */
router.post('/:id/snooze', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'User ID required' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    const hours = Math.min(Math.max(parseInt(req.body.hours) || 24, 1), 168); // 1-168 hours (1 week max)

    console.log(`${LOG_PREFIX} Snoozing recommendation ${id.slice(0, 8)}... for ${hours} hours`);

    const result = await callRpc<any>('snooze_recommendation', {
      p_recommendation_id: id,
      p_user_id: userId,
      p_snooze_hours: hours,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const response = result.data;
    if (!response?.ok) {
      return res.status(400).json({ ok: false, error: response?.error || 'Failed to snooze' });
    }

    return res.status(200).json({
      ...response,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Snooze error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /:id/feedback - Submit rating/feedback
// =============================================================================
/**
 * POST /:id/feedback
 *
 * Body:
 * {
 *   rating: number (1-5, required)
 *   note?: string
 * }
 */
router.post('/:id/feedback', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'User ID required' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    const { rating, note } = req.body;
    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ ok: false, error: 'Rating must be a number between 1 and 5' });
    }

    console.log(`${LOG_PREFIX} Submitting feedback for recommendation ${id.slice(0, 8)}... (rating: ${rating})`);

    const result = await callRpc<any>('submit_recommendation_feedback', {
      p_recommendation_id: id,
      p_user_id: userId,
      p_rating: rating,
      p_note: note || null,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const response = result.data;
    if (!response?.ok) {
      return res.status(400).json({ ok: false, error: response?.error || 'Failed to submit feedback' });
    }

    // Emit OASIS event for tracking
    await emitOasisEvent({
      vtid: 'SYSTEM',
      type: 'autopilot.recommendation.feedback' as any,
      source: 'recommendation-inbox',
      status: 'info',
      message: `User submitted feedback (rating: ${rating})`,
      payload: {
        recommendation_id: id,
        user_id: userId,
        rating,
        note,
      },
    });

    return res.status(200).json({
      ...response,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Feedback error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// GET /health - Health check
// =============================================================================
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'recommendation-inbox',
    vtid: 'VTID-01180',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /inbox',
      'GET /inbox/count',
      'POST /:id/read',
      'POST /:id/accept',
      'POST /:id/dismiss',
      'POST /:id/snooze',
      'POST /:id/feedback',
    ],
  });
});

export default router;
