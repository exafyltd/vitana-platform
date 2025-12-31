/**
 * VTID-01081 + VTID-01103: Health Gateway Routes
 *
 * Phase C2 (VTID-01081): Gateway Health Endpoints - RPC wrappers
 * Phase C3 (VTID-01103): Daily Compute Engine (Features -> Vitana Index -> Recommendations)
 *
 * Endpoints:
 * - POST /lab-reports/ingest - Ingest lab report data (C2)
 * - POST /wearables/ingest - Ingest wearable samples (C2)
 * - GET /summary - Get health summary for a date (C3)
 * - POST /recompute/daily - Trigger daily recompute pipeline (C3)
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';
import { CicdEventType } from '../types/cicd';

const router = Router();

// VTID for health-related OASIS events
const VTID_C2 = 'VTID-01081';
const VTID_C3 = 'VTID-01103';

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
 * Emit a health compute event to OASIS (C3 style - typed)
 */
async function emitHealthComputeEvent(
  eventType: CicdEventType,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID_C3,
      type: eventType,
      source: 'gateway-health-compute',
      status,
      message,
      payload,
    });
  } catch (err) {
    console.error(`[${VTID_C3}] Failed to emit OASIS event:`, err);
  }
}

/**
 * Emit OASIS event for health ingest operations (C2 style - direct to DB)
 */
async function emitHealthIngestEvent(
  eventType: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[VTID-01081] Cannot emit OASIS event: missing Supabase credentials');
    return;
  }

  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  const eventPayload = {
    id: eventId,
    created_at: timestamp,
    vtid: VTID_C2,
    topic: eventType,
    service: 'gateway-health',
    role: 'HEALTH',
    model: 'health-brain-gateway',
    status,
    message,
    link: null,
    metadata: payload,
  };

  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify(eventPayload),
    });

    if (resp.ok) {
      console.log(`[VTID-01081] OASIS event emitted: ${eventType} (${eventId})`);
    } else {
      console.warn(`[VTID-01081] OASIS event failed: ${resp.status}`);
    }
  } catch (err: any) {
    console.warn(`[VTID-01081] OASIS event error: ${err.message}`);
  }
}

/**
 * Get user context from me_context RPC.
 */
async function getUserContext(token: string): Promise<{
  ok: boolean;
  tenant_id: string | null;
  user_id: string | null;
  active_role: string | null;
  error?: string;
}> {
  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');

    if (error) {
      return { ok: false, tenant_id: null, user_id: null, active_role: null, error: error.message };
    }

    return {
      ok: true,
      tenant_id: data?.tenant_id || null,
      user_id: data?.user_id || data?.id || null,
      active_role: data?.active_role || null,
    };
  } catch (err: any) {
    return { ok: false, tenant_id: null, user_id: null, active_role: null, error: err.message };
  }
}

// =============================================================================
// PHASE C2: INGEST ENDPOINTS (VTID-01081)
// =============================================================================

/**
 * POST /lab-reports/ingest
 *
 * Ingest a lab report with biomarkers.
 * Calls RPC: health_ingest_lab_report(payload)
 */
router.post('/lab-reports/ingest', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01081] POST /lab-reports/ingest - Missing bearer token');
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error('[VTID-01081] POST /lab-reports/ingest - Context error:', ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  const { provider, report_date, biomarkers } = req.body;
  if (!provider || !report_date || !Array.isArray(biomarkers)) {
    await emitHealthIngestEvent(
      'health.ingest.lab_report.error',
      'error',
      'Invalid input for lab report ingest',
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: 'INVALID_INPUT' }
    );
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'Required fields: provider, report_date, biomarkers[]',
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const rpcPayload = {
      p_provider: provider,
      p_report_date: report_date,
      p_biomarkers: biomarkers,
    };

    const { data, error } = await supabase.rpc('health_ingest_lab_report', rpcPayload);

    if (error) {
      console.error('[VTID-01081] POST /lab-reports/ingest - RPC error:', error.message);
      await emitHealthIngestEvent(
        'health.ingest.lab_report.error',
        'error',
        `Lab report ingest failed: ${error.message}`,
        { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: error.message, provider }
      );

      if (error.code === 'PGRST301' || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
      return res.status(502).json({ ok: false, error: 'UPSTREAM_ERROR', message: error.message });
    }

    const labReportId = data?.lab_report_id || data?.id || null;
    const biomarkerCount = data?.biomarker_count ?? biomarkers.length;

    await emitHealthIngestEvent(
      'health.ingest.lab_report',
      'success',
      `Lab report ingested: ${biomarkerCount} biomarkers from ${provider}`,
      {
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        active_role: ctx.active_role,
        lab_report_id: labReportId,
        biomarker_count: biomarkerCount,
        provider,
        report_date,
      }
    );

    console.log(`[VTID-01081] POST /lab-reports/ingest - Success: ${biomarkerCount} biomarkers`);
    return res.status(200).json({ ok: true, lab_report_id: labReportId, biomarker_count: biomarkerCount });
  } catch (err: any) {
    console.error('[VTID-01081] POST /lab-reports/ingest - Unexpected error:', err.message);
    await emitHealthIngestEvent(
      'health.ingest.lab_report.error',
      'error',
      `Lab report ingest error: ${err.message}`,
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: err.message }
    );
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /wearables/ingest
 *
 * Ingest wearable samples (heart rate, steps, sleep, etc.)
 * Calls RPC: health_ingest_wearable_samples(payload)
 */
router.post('/wearables/ingest', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01081] POST /wearables/ingest - Missing bearer token');
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error('[VTID-01081] POST /wearables/ingest - Context error:', ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  const { provider, samples } = req.body;
  if (!provider || !Array.isArray(samples)) {
    await emitHealthIngestEvent(
      'health.ingest.wearable.error',
      'error',
      'Invalid input for wearable ingest',
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: 'INVALID_INPUT' }
    );
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'Required fields: provider, samples[]',
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const rpcPayload = {
      p_provider: provider,
      p_samples: samples,
    };

    const { data, error } = await supabase.rpc('health_ingest_wearable_samples', rpcPayload);

    if (error) {
      console.error('[VTID-01081] POST /wearables/ingest - RPC error:', error.message);
      await emitHealthIngestEvent(
        'health.ingest.wearable.error',
        'error',
        `Wearable ingest failed: ${error.message}`,
        { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: error.message, provider }
      );

      if (error.code === 'PGRST301' || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
      return res.status(502).json({ ok: false, error: 'UPSTREAM_ERROR', message: error.message });
    }

    const insertedCount = data?.inserted_count ?? data?.count ?? samples.length;

    await emitHealthIngestEvent(
      'health.ingest.wearable',
      'success',
      `Wearable samples ingested: ${insertedCount} samples from ${provider}`,
      {
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        active_role: ctx.active_role,
        inserted_count: insertedCount,
        provider,
        metric_count: samples.length,
      }
    );

    console.log(`[VTID-01081] POST /wearables/ingest - Success: ${insertedCount} samples`);
    return res.status(200).json({ ok: true, inserted_count: insertedCount });
  } catch (err: any) {
    console.error('[VTID-01081] POST /wearables/ingest - Unexpected error:', err.message);
    await emitHealthIngestEvent(
      'health.ingest.wearable.error',
      'error',
      `Wearable ingest error: ${err.message}`,
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: err.message }
    );
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// PHASE C3: COMPUTE ENDPOINTS (VTID-01103)
// =============================================================================

/**
 * POST /recompute/daily
 *
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
    console.warn(`[${VTID_C3}] POST /health/recompute/daily - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { date, model_version = 'v1' } = req.body;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.warn(`[${VTID_C3}] POST /health/recompute/daily - Invalid date format:`, date);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_DATE',
      message: 'Date must be in YYYY-MM-DD format',
    });
  }

  const startTime = Date.now();
  console.log(`[${VTID_C3}] POST /health/recompute/daily - Starting pipeline for date: ${date}`);

  try {
    const supabase = createUserSupabaseClient(token);

    // Step 1: Compute daily features
    const { data: featuresResult, error: featuresError } = await supabase.rpc(
      'health_compute_features_daily',
      { p_date: date }
    );

    if (featuresError) {
      console.error(`[${VTID_C3}] health_compute_features_daily failed:`, featuresError.message);
      await emitHealthComputeEvent(
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
      console.error(`[${VTID_C3}] health_compute_features_daily returned error:`, featuresResult);
      await emitHealthComputeEvent(
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

    console.log(`[${VTID_C3}] Features computed: upserted_count=${featuresResult.upserted_count}`);
    await emitHealthComputeEvent(
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
      console.error(`[${VTID_C3}] health_compute_vitana_index failed:`, indexError.message);
      await emitHealthComputeEvent(
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
      console.error(`[${VTID_C3}] health_compute_vitana_index returned error:`, indexResult);
      await emitHealthComputeEvent(
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

    console.log(`[${VTID_C3}] Vitana Index computed: score_total=${indexResult.score_total}`);
    await emitHealthComputeEvent(
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
      console.error(`[${VTID_C3}] health_generate_recommendations failed:`, recsError.message);
      await emitHealthComputeEvent(
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
      console.error(`[${VTID_C3}] health_generate_recommendations returned error:`, recsResult);
      await emitHealthComputeEvent(
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

    console.log(`[${VTID_C3}] Recommendations generated: created_count=${recsResult.created_count}`);
    await emitHealthComputeEvent(
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
    console.log(`[${VTID_C3}] Daily recompute pipeline completed in ${elapsed}ms`);

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
    console.error(`[${VTID_C3}] POST /health/recompute/daily - Unexpected error:`, err.message);
    await emitHealthComputeEvent(
      'health.compute.error',
      'error',
      `Recompute pipeline failed unexpectedly: ${err.message}`,
      { date, error: err.message }
    );
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /summary
 *
 * Returns health summary for a specific date.
 * Query params: ?date=YYYY-MM-DD
 */
router.get('/summary', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn(`[${VTID_C3}] GET /health/summary - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const date = req.query.date as string;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.warn(`[${VTID_C3}] GET /health/summary - Invalid date format:`, date);
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
      console.error(`[${VTID_C3}] GET /health/summary - Index query error:`, indexError.message);
    }

    // Fetch recommendations for the date
    const { data: recsData, error: recsError } = await supabase
      .from('recommendations')
      .select('*')
      .eq('date', date)
      .order('priority', { ascending: false });

    if (recsError) {
      console.error(`[${VTID_C3}] GET /health/summary - Recommendations query error:`, recsError.message);
    }

    console.log(`[${VTID_C3}] GET /health/summary - Success for date: ${date}`);

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
    console.error(`[${VTID_C3}] GET /health/summary - Unexpected error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /
 *
 * Health router status endpoint
 */
router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'health-gateway',
    vtid: [VTID_C2, VTID_C3],
    version: 'v1',
    endpoints: [
      'POST /api/v1/health/lab-reports/ingest',
      'POST /api/v1/health/wearables/ingest',
      'POST /api/v1/health/recompute/daily',
      'GET /api/v1/health/summary?date=YYYY-MM-DD',
    ],
    timestamp: new Date().toISOString(),
  });
});

export default router;
