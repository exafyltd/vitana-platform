/**
 * Autopilot Recommendations Routes - VTID-01180 + VTID-01185
 *
 * API endpoints for the Autopilot Recommendation popup in Command Hub.
 * Users can view AI-generated recommendations and activate them to create
 * VTID task cards with spec snapshots.
 *
 * VTID-01180 Endpoints:
 * - GET /recommendations - List recommendations (filtered by status)
 * - GET /recommendations/count - Get count for badge
 * - POST /recommendations/:id/activate - Activate recommendation (creates VTID)
 * - POST /recommendations/:id/reject - Reject/dismiss recommendation
 * - POST /recommendations/:id/snooze - Snooze for later
 *
 * VTID-01185 Endpoints (Recommendation Engine):
 * - POST /recommendations/generate - Trigger recommendation generation
 * - GET /recommendations/sources - Get analyzer source status
 * - GET /recommendations/history - Get generation run history
 *
 * Mounted at: /api/v1/autopilot/recommendations
 */

import { Router, Request, Response } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
import { generateRecommendations, SourceType } from '../services/recommendation-engine';

const router = Router();

const LOG_PREFIX = '[VTID-01180]';

// =============================================================================
// Helper: Supabase RPC call
// =============================================================================
async function callRpc<T>(
  functionName: string,
  params: Record<string, unknown>,
  authToken?: string
): Promise<{ ok: boolean; data?: T; error?: string; message?: string }> {
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
// VTID-01185: POST /recommendations/generate - Trigger recommendation generation
// =============================================================================
/**
 * POST /recommendations/generate
 *
 * Triggers recommendation generation from analyzers.
 * Admin-only endpoint.
 *
 * Body:
 * {
 *   sources?: string[] // ['codebase', 'oasis', 'health', 'roadmap'] - default all
 *   limit?: number     // Max recommendations to generate (default 20)
 *   force?: boolean    // Regenerate even if recently run
 * }
 *
 * Response:
 * {
 *   ok: true,
 *   generated: 15,
 *   duplicates_skipped: 3,
 *   run_id: "rec-gen-2026-01-17-001",
 *   duration_ms: 45000
 * }
 */
router.post('/generate', async (req: Request, res: Response) => {
  const LOG = '[VTID-01185]';

  try {
    const userId = getUserId(req);
    const {
      sources = ['codebase', 'oasis', 'health', 'roadmap'],
      limit = 20,
      force = false,
    } = req.body;

    // Validate sources
    const validSources: SourceType[] = ['codebase', 'oasis', 'health', 'roadmap'];
    const requestedSources = (Array.isArray(sources) ? sources : [sources]).filter(
      (s: string) => validSources.includes(s as SourceType)
    ) as SourceType[];

    if (requestedSources.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No valid sources specified',
        valid_sources: validSources,
      });
    }

    console.log(`${LOG} Generation requested by ${userId || 'anonymous'} - sources: ${requestedSources.join(', ')}`);

    // Emit start event
    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: 'autopilot.recommendation.generation.started' as any,
      source: 'recommendation-engine',
      status: 'info',
      message: `Recommendation generation started (sources: ${requestedSources.join(', ')})`,
      payload: {
        sources: requestedSources,
        limit,
        force,
        triggered_by: userId,
      },
    });

    // Get base path from environment or use default
    const basePath = process.env.VITANA_BASE_PATH || '/home/user/vitana-platform';

    // Run generation
    const result = await generateRecommendations(basePath, {
      sources: requestedSources,
      limit: Math.min(Math.max(limit, 1), 50),
      force,
      triggered_by: userId || 'api',
      trigger_type: 'manual',
    });

    // Emit completion event
    await emitOasisEvent({
      vtid: 'VTID-01185',
      type: result.ok
        ? ('autopilot.recommendation.generation.completed' as any)
        : ('autopilot.recommendation.generation.failed' as any),
      source: 'recommendation-engine',
      status: result.ok ? 'success' : 'error',
      message: result.ok
        ? `Generated ${result.generated} recommendations (${result.duplicates_skipped} duplicates skipped)`
        : `Generation failed: ${result.errors[0]?.error || 'Unknown error'}`,
      payload: {
        run_id: result.run_id,
        generated: result.generated,
        duplicates_skipped: result.duplicates_skipped,
        duration_ms: result.duration_ms,
        errors: result.errors,
      },
    });

    return res.status(result.ok ? 200 : 500).json({
      ...result,
      vtid: 'VTID-01185',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG} Generation error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// VTID-01185: GET /recommendations/sources - Get analyzer source status
// =============================================================================
/**
 * GET /recommendations/sources
 *
 * Returns available analysis sources and their status.
 *
 * Response:
 * {
 *   ok: true,
 *   sources: [
 *     { type: 'codebase', status: 'ready', last_scan: '2026-01-17T10:00:00Z', files_scanned: 1523 },
 *     { type: 'oasis', status: 'ready', last_scan: '2026-01-17T12:00:00Z', events_analyzed: 50000 },
 *     { type: 'health', status: 'ready', last_scan: '2026-01-17T11:00:00Z', checks_run: 45 },
 *     { type: 'roadmap', status: 'ready', last_scan: '2026-01-17T09:00:00Z', specs_found: 23 }
 *   ]
 * }
 */
router.get('/sources', async (_req: Request, res: Response) => {
  const LOG = '[VTID-01185]';

  try {
    console.log(`${LOG} Sources status requested`);

    const result = await callRpc<any[]>('get_autopilot_analyzer_sources', {});

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const sources = (result.data || []).map((s: any) => ({
      type: s.source_type,
      status: s.status,
      enabled: s.enabled,
      last_scan: s.last_scan_at,
      last_scan_duration_ms: s.last_scan_duration_ms,
      items_scanned: s.items_scanned,
      items_found: s.items_found,
      recommendations_generated: s.recommendations_generated,
      last_error: s.last_error,
      config: s.config,
    }));

    return res.status(200).json({
      ok: true,
      sources,
      vtid: 'VTID-01185',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG} Sources error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// VTID-01185: GET /recommendations/history - Get generation run history
// =============================================================================
/**
 * GET /recommendations/history
 *
 * Returns generation history.
 *
 * Query params:
 * - limit: max items (default: 20, max: 100)
 * - offset: pagination offset (default: 0)
 * - trigger_type: filter by trigger type (manual, scheduled, pr_merge, webhook)
 *
 * Response:
 * {
 *   ok: true,
 *   runs: [
 *     { run_id: "rec-gen-2026-01-17-001", timestamp: "...", generated: 15, duration_ms: 45000 },
 *     { run_id: "rec-gen-2026-01-16-001", timestamp: "...", generated: 8, duration_ms: 32000 }
 *   ]
 * }
 */
router.get('/history', async (req: Request, res: Response) => {
  const LOG = '[VTID-01185]';

  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const triggerType = req.query.trigger_type as string || null;

    console.log(`${LOG} History requested (limit: ${limit}, offset: ${offset})`);

    const result = await callRpc<any[]>('get_autopilot_recommendation_history', {
      p_limit: limit + 1,
      p_offset: offset,
      p_trigger_type: triggerType,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const runs = result.data || [];
    const hasMore = runs.length > limit;
    if (hasMore) {
      runs.pop();
    }

    return res.status(200).json({
      ok: true,
      runs: runs.map((r: any) => ({
        run_id: r.run_id,
        status: r.status,
        trigger_type: r.trigger_type,
        triggered_by: r.triggered_by,
        sources: r.sources,
        recommendations_generated: r.recommendations_generated,
        duplicates_skipped: r.duplicates_skipped,
        errors_count: r.errors_count,
        duration_ms: r.duration_ms,
        started_at: r.started_at,
        completed_at: r.completed_at,
        analysis_summary: r.analysis_summary,
      })),
      count: runs.length,
      has_more: hasMore,
      vtid: 'VTID-01185',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG} History error:`, error);
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
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /recommendations',
      'GET /recommendations/count',
      'POST /recommendations/:id/activate',
      'POST /recommendations/:id/reject',
      'POST /recommendations/:id/snooze',
      'POST /recommendations/generate',
      'GET /recommendations/sources',
      'GET /recommendations/history',
    ],
  });
});

export default router;
