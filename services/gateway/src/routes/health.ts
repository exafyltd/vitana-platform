/**
 * VTID-01081: Phase C2 - Gateway Health Endpoints
 *
 * Thin RPC wrappers around Supabase Health Brain RPCs.
 * Emits OASIS events for every write/access operation.
 *
 * Endpoints:
 * - POST /lab-reports/ingest - Ingest lab report data
 * - POST /wearables/ingest - Ingest wearable samples
 * - GET /summary - Get health summary for date range
 * - POST /recompute/daily - Trigger daily recompute
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();

// VTID for all health-related OASIS events
const VTID = 'VTID-01081';

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
 * Emit OASIS event for health operations.
 */
async function emitHealthEvent(
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
    vtid: VTID,
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
 * Returns tenant_id, user_id, and active_role.
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

/**
 * POST /lab-reports/ingest
 *
 * Ingest a lab report with biomarkers.
 * Calls RPC: health_ingest_lab_report(payload)
 *
 * Request body:
 * {
 *   provider: string,
 *   report_date: string (YYYY-MM-DD),
 *   biomarkers: Array<{ name: string, value: number, unit: string, ... }>
 * }
 *
 * Response:
 * { ok: true, lab_report_id: string, biomarker_count: number }
 */
router.post('/lab-reports/ingest', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01081] POST /lab-reports/ingest - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHORIZED',
    });
  }

  // Resolve user context
  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error('[VTID-01081] POST /lab-reports/ingest - Context error:', ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  // Validate request body
  const { provider, report_date, biomarkers } = req.body;
  if (!provider || !report_date || !Array.isArray(biomarkers)) {
    await emitHealthEvent(
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

    // Build RPC payload
    const rpcPayload = {
      p_provider: provider,
      p_report_date: report_date,
      p_biomarkers: biomarkers,
    };

    const { data, error } = await supabase.rpc('health_ingest_lab_report', rpcPayload);

    if (error) {
      console.error('[VTID-01081] POST /lab-reports/ingest - RPC error:', error.message);
      await emitHealthEvent(
        'health.ingest.lab_report.error',
        'error',
        `Lab report ingest failed: ${error.message}`,
        { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: error.message, provider }
      );

      // Check for specific error types
      if (error.code === 'PGRST301' || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
      return res.status(502).json({
        ok: false,
        error: 'UPSTREAM_ERROR',
        message: error.message,
      });
    }

    const labReportId = data?.lab_report_id || data?.id || null;
    const biomarkerCount = data?.biomarker_count ?? biomarkers.length;

    // Emit success event
    await emitHealthEvent(
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
    return res.status(200).json({
      ok: true,
      lab_report_id: labReportId,
      biomarker_count: biomarkerCount,
    });
  } catch (err: any) {
    console.error('[VTID-01081] POST /lab-reports/ingest - Unexpected error:', err.message);
    await emitHealthEvent(
      'health.ingest.lab_report.error',
      'error',
      `Lab report ingest error: ${err.message}`,
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: err.message }
    );
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/**
 * POST /wearables/ingest
 *
 * Ingest wearable samples (heart rate, steps, sleep, etc.)
 * Calls RPC: health_ingest_wearable_samples(payload)
 *
 * Request body:
 * {
 *   provider: string,
 *   samples: Array<{ metric: string, value: number, timestamp: string, ... }>
 * }
 *
 * Response:
 * { ok: true, inserted_count: number }
 */
router.post('/wearables/ingest', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01081] POST /wearables/ingest - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHORIZED',
    });
  }

  // Resolve user context
  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error('[VTID-01081] POST /wearables/ingest - Context error:', ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  // Validate request body
  const { provider, samples } = req.body;
  if (!provider || !Array.isArray(samples)) {
    await emitHealthEvent(
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

    // Build RPC payload
    const rpcPayload = {
      p_provider: provider,
      p_samples: samples,
    };

    const { data, error } = await supabase.rpc('health_ingest_wearable_samples', rpcPayload);

    if (error) {
      console.error('[VTID-01081] POST /wearables/ingest - RPC error:', error.message);
      await emitHealthEvent(
        'health.ingest.wearable.error',
        'error',
        `Wearable ingest failed: ${error.message}`,
        { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: error.message, provider }
      );

      if (error.code === 'PGRST301' || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
      return res.status(502).json({
        ok: false,
        error: 'UPSTREAM_ERROR',
        message: error.message,
      });
    }

    const insertedCount = data?.inserted_count ?? data?.count ?? samples.length;

    // Emit success event
    await emitHealthEvent(
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
    return res.status(200).json({
      ok: true,
      inserted_count: insertedCount,
    });
  } catch (err: any) {
    console.error('[VTID-01081] POST /wearables/ingest - Unexpected error:', err.message);
    await emitHealthEvent(
      'health.ingest.wearable.error',
      'error',
      `Wearable ingest error: ${err.message}`,
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: err.message }
    );
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/**
 * GET /summary
 *
 * Get health summary for a date range.
 * Calls RPC: health_get_summary(from, to)
 *
 * Query params:
 * - from: YYYY-MM-DD (required)
 * - to: YYYY-MM-DD (required)
 *
 * Response: RPC output (deterministic)
 */
router.get('/summary', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01081] GET /summary - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHORIZED',
    });
  }

  // Resolve user context
  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error('[VTID-01081] GET /summary - Context error:', ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  // Validate query params
  const from = req.query.from as string;
  const to = req.query.to as string;

  if (!from || !to) {
    await emitHealthEvent(
      'health.access.summary.error',
      'error',
      'Invalid input for health summary',
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: 'INVALID_INPUT' }
    );
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'Required query params: from, to (YYYY-MM-DD)',
    });
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(from) || !dateRegex.test(to)) {
    await emitHealthEvent(
      'health.access.summary.error',
      'error',
      'Invalid date format for health summary',
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: 'INVALID_INPUT', from, to }
    );
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'Date format must be YYYY-MM-DD',
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('health_get_summary', {
      p_from: from,
      p_to: to,
    });

    if (error) {
      console.error('[VTID-01081] GET /summary - RPC error:', error.message);
      await emitHealthEvent(
        'health.access.summary.error',
        'error',
        `Health summary access failed: ${error.message}`,
        { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: error.message, from, to }
      );

      if (error.code === 'PGRST301' || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
      return res.status(502).json({
        ok: false,
        error: 'UPSTREAM_ERROR',
        message: error.message,
      });
    }

    // Emit access event
    await emitHealthEvent(
      'health.access.summary',
      'success',
      `Health summary accessed: ${from} to ${to}`,
      {
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        active_role: ctx.active_role,
        from,
        to,
      }
    );

    console.log(`[VTID-01081] GET /summary - Success: ${from} to ${to}`);
    return res.status(200).json(data);
  } catch (err: any) {
    console.error('[VTID-01081] GET /summary - Unexpected error:', err.message);
    await emitHealthEvent(
      'health.access.summary.error',
      'error',
      `Health summary error: ${err.message}`,
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: err.message }
    );
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/**
 * POST /recompute/daily
 *
 * Trigger daily recompute of health features and Vitana Index.
 * Calls RPCs if they exist:
 * - health_compute_features_daily
 * - health_compute_vitana_index
 * - health_generate_recommendations
 *
 * If compute RPCs don't exist (VTID-01103 not complete), returns 503 DEPENDENCY_MISSING.
 *
 * Request body:
 * { date: "YYYY-MM-DD" }
 *
 * Response:
 * { ok: true, compute_results: {...} } or
 * { ok: false, error: "DEPENDENCY_MISSING", message: "Missing RPC: ..." }
 */
router.post('/recompute/daily', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01081] POST /recompute/daily - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHORIZED',
    });
  }

  // Resolve user context
  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error('[VTID-01081] POST /recompute/daily - Context error:', ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  // Validate request body
  const { date } = req.body;
  if (!date) {
    await emitHealthEvent(
      'health.compute.error',
      'error',
      'Invalid input for daily recompute',
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: 'INVALID_INPUT' }
    );
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'Required field: date (YYYY-MM-DD)',
    });
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    await emitHealthEvent(
      'health.compute.error',
      'error',
      'Invalid date format for daily recompute',
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: 'INVALID_INPUT', date }
    );
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'Date format must be YYYY-MM-DD',
    });
  }

  // Emit compute requested event (even if dependency missing)
  await emitHealthEvent(
    'health.compute.requested',
    'info',
    `Daily recompute requested for ${date}`,
    {
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      active_role: ctx.active_role,
      date,
    }
  );

  try {
    const supabase = createUserSupabaseClient(token);

    // Try to call compute RPCs - these may not exist yet (VTID-01103)
    const missingRpcs: string[] = [];
    const computeResults: Record<string, unknown> = {};

    // 1. health_compute_features_daily
    const { data: featuresData, error: featuresError } = await supabase.rpc('health_compute_features_daily', {
      p_date: date,
    });

    if (featuresError) {
      if (featuresError.message.includes('function') && featuresError.message.includes('does not exist')) {
        missingRpcs.push('health_compute_features_daily');
      } else if (featuresError.code === 'PGRST301' || featuresError.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      } else {
        console.warn('[VTID-01081] health_compute_features_daily error:', featuresError.message);
        missingRpcs.push('health_compute_features_daily');
      }
    } else {
      computeResults.features = featuresData;
    }

    // 2. health_compute_vitana_index
    const { data: indexData, error: indexError } = await supabase.rpc('health_compute_vitana_index', {
      p_date: date,
    });

    if (indexError) {
      if (indexError.message.includes('function') && indexError.message.includes('does not exist')) {
        missingRpcs.push('health_compute_vitana_index');
      } else {
        console.warn('[VTID-01081] health_compute_vitana_index error:', indexError.message);
        missingRpcs.push('health_compute_vitana_index');
      }
    } else {
      computeResults.vitana_index = indexData;
    }

    // 3. health_generate_recommendations
    const { data: recsData, error: recsError } = await supabase.rpc('health_generate_recommendations', {
      p_date: date,
    });

    if (recsError) {
      if (recsError.message.includes('function') && recsError.message.includes('does not exist')) {
        missingRpcs.push('health_generate_recommendations');
      } else {
        console.warn('[VTID-01081] health_generate_recommendations error:', recsError.message);
        missingRpcs.push('health_generate_recommendations');
      }
    } else {
      computeResults.recommendations = recsData;
    }

    // If any RPCs are missing, return DEPENDENCY_MISSING
    if (missingRpcs.length > 0) {
      const missingList = missingRpcs.join(' / ');
      await emitHealthEvent(
        'health.compute.error',
        'warning',
        `Compute dependency missing: ${missingList}`,
        {
          tenant_id: ctx.tenant_id,
          user_id: ctx.user_id,
          active_role: ctx.active_role,
          date,
          missing_rpcs: missingRpcs,
          dependency: 'VTID-01103',
        }
      );

      console.log(`[VTID-01081] POST /recompute/daily - Dependency missing: ${missingList}`);
      return res.status(503).json({
        ok: false,
        error: 'DEPENDENCY_MISSING',
        message: `Missing RPC: ${missingList}`,
      });
    }

    // All RPCs succeeded
    await emitHealthEvent(
      'health.compute.success',
      'success',
      `Daily recompute completed for ${date}`,
      {
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        active_role: ctx.active_role,
        date,
        features: computeResults.features ? 'computed' : 'skipped',
        vitana_index: computeResults.vitana_index ? 'computed' : 'skipped',
        recommendations: computeResults.recommendations ? 'computed' : 'skipped',
      }
    );

    console.log(`[VTID-01081] POST /recompute/daily - Success for ${date}`);
    return res.status(200).json({
      ok: true,
      compute_results: computeResults,
    });
  } catch (err: any) {
    console.error('[VTID-01081] POST /recompute/daily - Unexpected error:', err.message);
    await emitHealthEvent(
      'health.compute.error',
      'error',
      `Daily recompute error: ${err.message}`,
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id, active_role: ctx.active_role, error: err.message, date }
    );
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

export default router;
