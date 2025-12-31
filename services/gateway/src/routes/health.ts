/**
 * VTID-01103: Health Compute Engine Routes
 * Phase C3: Daily Compute Engine (Features -> Vitana Index -> Recommendations)
 *
 * Endpoints:
 *   POST /api/v1/health/recompute/daily - Trigger daily recompute pipeline
 *   GET /api/v1/health/summary - Get health summary for a date
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// VTID-01103: Event type constants
const VTID = 'VTID-01103';

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
 * Emit a health compute event to OASIS
 */
async function emitHealthEvent(
  eventType: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: eventType,
      source: 'gateway-health-compute',
      status,
      message,
      payload,
    });
  } catch (err) {
    console.error(`[${VTID}] Failed to emit OASIS event:`, err);
  }
}

/**
 * POST /recompute/daily
 * Triggers the daily recompute pipeline:
 *   1. health_compute_features_daily(date)
 *   2. health_compute_vitana_index(date, model_version)
 *   3. health_generate_recommendations(date, date, model_version)
 *
 * Request body: { "date": "YYYY-MM-DD", "model_version": "v1" }
 *
 * Response:
 * {
 *   "ok": true,
 *   "date": "YYYY-MM-DD",
 *   "features": { ... },
 *   "index": { ... },
 *   "recommendations": { ... }
 * }
 */
router.post('/recompute/daily', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn(`[${VTID}] POST /health/recompute/daily - Missing bearer token`);
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
  }

  const { date, model_version = 'v1' } = req.body;

  // Validate date format
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.warn(`[${VTID}] POST /health/recompute/daily - Invalid date format:`, date);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_DATE',
      message: 'Date must be in YYYY-MM-DD format',
    });
  }

  const startTime = Date.now();
  console.log(`[${VTID}] POST /health/recompute/daily - Starting pipeline for date: ${date}`);

  try {
    const supabase = createUserSupabaseClient(token);

    // Step 1: Compute daily features
    const { data: featuresResult, error: featuresError } = await supabase.rpc(
      'health_compute_features_daily',
      { p_date: date }
    );

    if (featuresError) {
      console.error(`[${VTID}] health_compute_features_daily failed:`, featuresError.message);
      await emitHealthEvent(
        'health.compute.features_daily',
        'error',
        `Features computation failed: ${featuresError.message}`,
        { date, error: featuresError.message }
      );
      return res.status(400).json({
        ok: false,
        error: 'FEATURES_COMPUTE_FAILED',
        message: featuresError.message,
      });
    }

    if (!featuresResult?.ok) {
      console.error(`[${VTID}] health_compute_features_daily returned error:`, featuresResult);
      await emitHealthEvent(
        'health.compute.features_daily',
        'error',
        `Features computation failed: ${featuresResult?.error || 'Unknown error'}`,
        { date, result: featuresResult }
      );
      return res.status(400).json({
        ok: false,
        error: featuresResult?.error || 'FEATURES_COMPUTE_FAILED',
        message: featuresResult?.message || 'Failed to compute features',
      });
    }

    console.log(`[${VTID}] Features computed: upserted_count=${featuresResult.upserted_count}`);
    await emitHealthEvent(
      'health.compute.features_daily',
      'success',
      `Features computed for ${date}: ${featuresResult.upserted_count} features`,
      {
        date,
        upserted_count: featuresResult.upserted_count,
        tenant_id: featuresResult.tenant_id,
        user_id: featuresResult.user_id,
      }
    );

    // Step 2: Compute Vitana Index
    const { data: indexResult, error: indexError } = await supabase.rpc(
      'health_compute_vitana_index',
      { p_date: date, p_model_version: model_version }
    );

    if (indexError) {
      console.error(`[${VTID}] health_compute_vitana_index failed:`, indexError.message);
      await emitHealthEvent(
        'health.compute.vitana_index',
        'error',
        `Vitana Index computation failed: ${indexError.message}`,
        { date, model_version, error: indexError.message }
      );
      return res.status(400).json({
        ok: false,
        error: 'INDEX_COMPUTE_FAILED',
        message: indexError.message,
      });
    }

    if (!indexResult?.ok) {
      console.error(`[${VTID}] health_compute_vitana_index returned error:`, indexResult);
      await emitHealthEvent(
        'health.compute.vitana_index',
        'error',
        `Vitana Index computation failed: ${indexResult?.error || 'Unknown error'}`,
        { date, model_version, result: indexResult }
      );
      return res.status(400).json({
        ok: false,
        error: indexResult?.error || 'INDEX_COMPUTE_FAILED',
        message: indexResult?.message || 'Failed to compute Vitana Index',
      });
    }

    console.log(`[${VTID}] Vitana Index computed: score_total=${indexResult.score_total}`);
    await emitHealthEvent(
      'health.compute.vitana_index',
      'success',
      `Vitana Index computed for ${date}: score=${indexResult.score_total}`,
      {
        date,
        model_version: indexResult.model_version,
        score_total: indexResult.score_total,
        score_physical: indexResult.score_physical,
        score_mental: indexResult.score_mental,
        score_nutritional: indexResult.score_nutritional,
        score_social: indexResult.score_social,
        score_environmental: indexResult.score_environmental,
        confidence: indexResult.confidence,
        tenant_id: indexResult.tenant_id,
        user_id: indexResult.user_id,
      }
    );

    // Step 3: Generate recommendations
    const { data: recsResult, error: recsError } = await supabase.rpc(
      'health_generate_recommendations',
      { p_from: date, p_to: date, p_model_version: model_version }
    );

    if (recsError) {
      console.error(`[${VTID}] health_generate_recommendations failed:`, recsError.message);
      await emitHealthEvent(
        'health.recommendations.refresh',
        'error',
        `Recommendations generation failed: ${recsError.message}`,
        { date, model_version, error: recsError.message }
      );
      return res.status(400).json({
        ok: false,
        error: 'RECOMMENDATIONS_FAILED',
        message: recsError.message,
      });
    }

    if (!recsResult?.ok) {
      console.error(`[${VTID}] health_generate_recommendations returned error:`, recsResult);
      await emitHealthEvent(
        'health.recommendations.refresh',
        'error',
        `Recommendations generation failed: ${recsResult?.error || 'Unknown error'}`,
        { date, model_version, result: recsResult }
      );
      return res.status(400).json({
        ok: false,
        error: recsResult?.error || 'RECOMMENDATIONS_FAILED',
        message: recsResult?.message || 'Failed to generate recommendations',
      });
    }

    console.log(`[${VTID}] Recommendations generated: created_count=${recsResult.created_count}`);
    await emitHealthEvent(
      'health.recommendations.refresh',
      'success',
      `Recommendations generated for ${date}: ${recsResult.created_count} recommendations`,
      {
        date,
        model_version: recsResult.model_version,
        created_count: recsResult.created_count,
        tenant_id: recsResult.tenant_id,
        user_id: recsResult.user_id,
      }
    );

    const elapsed = Date.now() - startTime;
    console.log(`[${VTID}] Daily recompute pipeline completed in ${elapsed}ms`);

    return res.status(200).json({
      ok: true,
      date,
      features: {
        ok: true,
        upserted_count: featuresResult.upserted_count,
      },
      index: {
        ok: true,
        score_total: indexResult.score_total,
        score_physical: indexResult.score_physical,
        score_mental: indexResult.score_mental,
        score_nutritional: indexResult.score_nutritional,
        score_social: indexResult.score_social,
        score_environmental: indexResult.score_environmental,
        model_version: indexResult.model_version,
        confidence: indexResult.confidence,
      },
      recommendations: {
        ok: true,
        created_count: recsResult.created_count,
        model_version: recsResult.model_version,
      },
      elapsed_ms: elapsed,
    });
  } catch (err: any) {
    console.error(`[${VTID}] POST /health/recompute/daily - Unexpected error:`, err.message);
    await emitHealthEvent(
      'health.compute.error',
      'error',
      `Recompute pipeline failed unexpectedly: ${err.message}`,
      { date, error: err.message }
    );
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/**
 * GET /summary
 * Returns health summary for a specific date.
 *
 * Query params: ?date=YYYY-MM-DD
 *
 * Response:
 * {
 *   "ok": true,
 *   "date": "YYYY-MM-DD",
 *   "index": { score_total, pillars... } | null,
 *   "recommendations": [ ... ]
 * }
 */
router.get('/summary', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn(`[${VTID}] GET /health/summary - Missing bearer token`);
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
  }

  const date = req.query.date as string;

  // Validate date format
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.warn(`[${VTID}] GET /health/summary - Invalid date format:`, date);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_DATE',
      message: 'Date must be in YYYY-MM-DD format (query param: ?date=YYYY-MM-DD)',
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Fetch Vitana Index for the date
    const { data: indexData, error: indexError } = await supabase
      .from('vitana_index_scores')
      .select('*')
      .eq('date', date)
      .single();

    if (indexError && indexError.code !== 'PGRST116') {
      // PGRST116 is "not found" which is OK
      console.error(`[${VTID}] GET /health/summary - Index query error:`, indexError.message);
    }

    // Fetch recommendations for the date
    const { data: recsData, error: recsError } = await supabase
      .from('recommendations')
      .select('*')
      .eq('date', date)
      .order('priority', { ascending: false });

    if (recsError) {
      console.error(`[${VTID}] GET /health/summary - Recommendations query error:`, recsError.message);
    }

    console.log(`[${VTID}] GET /health/summary - Success for date: ${date}`);

    return res.status(200).json({
      ok: true,
      date,
      index: indexData
        ? {
            score_total: indexData.score_total,
            score_physical: indexData.score_physical,
            score_mental: indexData.score_mental,
            score_nutritional: indexData.score_nutritional,
            score_social: indexData.score_social,
            score_environmental: indexData.score_environmental,
            model_version: indexData.model_version,
            confidence: indexData.confidence,
          }
        : null,
      recommendations: (recsData || []).map((rec: any) => ({
        id: rec.id,
        type: rec.recommendation_type,
        priority: rec.priority,
        title: rec.title,
        description: rec.description,
        action_items: rec.action_items,
        safety_checked: rec.safety_checked,
        expires_at: rec.expires_at,
      })),
      recommendation_count: (recsData || []).length,
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /health/summary - Unexpected error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/**
 * GET /
 * Health router status endpoint
 */
router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'health-compute-engine',
    vtid: VTID,
    version: 'v1',
    endpoints: [
      'POST /api/v1/health/recompute/daily',
      'GET /api/v1/health/summary?date=YYYY-MM-DD',
    ],
    timestamp: new Date().toISOString(),
  });
});

export default router;
