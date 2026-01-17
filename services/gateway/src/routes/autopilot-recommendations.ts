/**
 * Autopilot Recommendations Routes - VTID-01180
 *
 * API endpoints for the Autopilot Recommendation popup in Command Hub.
 * Users can view AI-generated recommendations and activate them to create
 * VTID task cards with spec snapshots.
 *
 * Endpoints:
 * - GET /recommendations - List recommendations (filtered by status)
 * - GET /recommendations/count - Get count for badge
 * - POST /recommendations/:id/activate - Activate recommendation (creates VTID)
 * - POST /recommendations/:id/reject - Reject/dismiss recommendation
 * - POST /recommendations/:id/snooze - Snooze for later
 *
 * Mounted at: /api/v1/autopilot/recommendations
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
  // @ts-ignore - user may be set by auth middleware
  if (req.user?.id) return req.user.id;
  // @ts-ignore - user may be set by auth middleware
  if (req.user?.sub) return req.user.sub;

  const headerUserId = req.get('X-User-ID') || req.get('X-Vitana-User');
  if (headerUserId) return headerUserId;

  const queryUserId = req.query.user_id as string;
  if (queryUserId) return queryUserId;

  return null;
}

// =============================================================================
// GET /recommendations - List recommendations
// =============================================================================
/**
 * GET /recommendations
 *
 * Query params:
 * - status: comma-separated status filter (default: 'new')
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
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);

    // Parse query params
    const statusParam = req.query.status as string || 'new';
    const statuses = statusParam.split(',').map(s => s.trim());
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    console.log(`${LOG_PREFIX} Recommendations requested (status: ${statuses.join(',')}, limit: ${limit})`);

    const result = await callRpc<any[]>('get_autopilot_recommendations', {
      p_status: statuses,
      p_limit: limit + 1, // Fetch one extra to check has_more
      p_offset: offset,
      p_user_id: userId,
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
    console.error(`${LOG_PREFIX} List recommendations error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// GET /recommendations/count - Get count for badge
// =============================================================================
/**
 * GET /recommendations/count
 *
 * Response:
 * {
 *   ok: true,
 *   count: number
 * }
 */
router.get('/count', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);

    console.log(`${LOG_PREFIX} Recommendations count requested`);

    const result = await callRpc<number>('get_autopilot_recommendations_count', {
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
    console.error(`${LOG_PREFIX} Count error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /recommendations/:id/activate - Activate recommendation (creates VTID)
// =============================================================================
/**
 * POST /recommendations/:id/activate
 *
 * Creates a VTID task card with spec snapshot from the recommendation.
 * Idempotent: If already activated, returns existing VTID.
 *
 * Response:
 * {
 *   ok: true,
 *   vtid: "VTID-XXXXX",
 *   recommendation_id: "...",
 *   title: "...",
 *   status: "activated",
 *   activated_at: "...",
 *   spec_checksum: "...",
 *   already_activated?: boolean
 * }
 */
router.post('/:id/activate', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    console.log(`${LOG_PREFIX} Activating recommendation ${id.slice(0, 8)}...`);

    const result = await callRpc<any>('activate_autopilot_recommendation', {
      p_recommendation_id: id,
      p_user_id: userId,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const response = result.data;
    if (!response?.ok) {
      return res.status(400).json({ ok: false, error: response?.error || 'Failed to activate' });
    }

    // Emit OASIS event for tracking
    await emitOasisEvent({
      vtid: response.vtid || 'SYSTEM',
      type: 'autopilot.recommendation.activated' as any,
      source: 'autopilot-recommendations',
      status: 'info',
      message: `Recommendation activated: ${response.title}`,
      payload: {
        recommendation_id: id,
        vtid: response.vtid,
        user_id: userId,
        already_activated: response.already_activated,
      },
    });

    return res.status(200).json({
      ...response,
      vtid_ref: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Activate error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /recommendations/:id/reject - Reject/dismiss recommendation
// =============================================================================
/**
 * POST /recommendations/:id/reject
 *
 * Body:
 * {
 *   reason?: string // Optional reason for rejection
 * }
 */
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    console.log(`${LOG_PREFIX} Rejecting recommendation ${id.slice(0, 8)}...`);

    const result = await callRpc<any>('reject_autopilot_recommendation', {
      p_recommendation_id: id,
      p_reason: reason || null,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const response = result.data;
    if (!response?.ok) {
      return res.status(400).json({ ok: false, error: response?.error || 'Failed to reject' });
    }

    return res.status(200).json({
      ...response,
      vtid: 'VTID-01180',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Reject error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /recommendations/:id/snooze - Snooze for later
// =============================================================================
/**
 * POST /recommendations/:id/snooze
 *
 * Body:
 * {
 *   hours?: number // Hours to snooze (default: 24)
 * }
 */
router.post('/:id/snooze', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const hours = Math.min(Math.max(parseInt(req.body.hours) || 24, 1), 168); // 1-168 hours (1 week max)

    if (!id) {
      return res.status(400).json({ ok: false, error: 'Recommendation ID required' });
    }

    console.log(`${LOG_PREFIX} Snoozing recommendation ${id.slice(0, 8)}... for ${hours} hours`);

    const result = await callRpc<any>('snooze_autopilot_recommendation', {
      p_recommendation_id: id,
      p_hours: hours,
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
// GET /recommendations/health - Health check
// =============================================================================
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'autopilot-recommendations',
    vtid: 'VTID-01180',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /recommendations',
      'GET /recommendations/count',
      'POST /recommendations/:id/activate',
      'POST /recommendations/:id/reject',
      'POST /recommendations/:id/snooze',
    ],
  });
});

export default router;
