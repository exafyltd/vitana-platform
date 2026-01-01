/**
 * VTID-01083: Longevity Signal Layer Gateway Routes
 *
 * Converts daily diary entries + Memory Garden nodes into deterministic
 * Longevity Signals that the Health brain can use safely:
 * - sleep / stress / hydration / nutrition / movement / social signals
 * - trend deltas (improving / declining)
 * - "what changed?" explanations
 * - input for Vitana Index + recommendations (without hallucination)
 *
 * Endpoints:
 * - POST /compute/daily - Compute daily longevity signals (defaults to caller user)
 * - GET /daily - Get daily signals for a date range (?from=&to=)
 * - GET /daily/:date/explain - Get detailed evidence and rules for a date
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();

// VTID for OASIS events
const VTID = 'VTID-01083';

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

/**
 * Emit OASIS event for longevity operations
 */
async function emitLongevityEvent(
  eventType: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn(`[${VTID}] Cannot emit OASIS event: missing Supabase credentials`);
    return;
  }

  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  const eventPayload = {
    id: eventId,
    created_at: timestamp,
    vtid: VTID,
    topic: eventType,
    service: 'gateway-longevity',
    role: 'HEALTH',
    model: 'longevity-signal-layer',
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
      console.log(`[${VTID}] OASIS event emitted: ${eventType} (${eventId})`);
    } else {
      console.warn(`[${VTID}] OASIS event failed: ${resp.status}`);
    }
  } catch (err: any) {
    console.warn(`[${VTID}] OASIS event error: ${err.message}`);
  }
}

// =============================================================================
// POST /compute/daily
// Compute daily longevity signals from diary entries and garden nodes
// =============================================================================

router.post('/compute/daily', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn(`[${VTID}] POST /compute/daily - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error(`[${VTID}] POST /compute/daily - Context error:`, ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  // Get date from request body or default to today
  const { date } = req.body;
  const targetDate = date || new Date().toISOString().split('T')[0];

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    console.warn(`[${VTID}] POST /compute/daily - Invalid date format:`, targetDate);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_DATE',
      message: 'Date must be in YYYY-MM-DD format',
    });
  }

  // Emit compute requested event
  await emitLongevityEvent(
    'longevity.compute.requested',
    'info',
    `Longevity signal compute requested for ${targetDate}`,
    {
      vtid: VTID,
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      active_role: ctx.active_role,
      date: targetDate,
    }
  );

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('longevity_compute_daily', {
      p_user_id: null, // Use current user from auth context
      p_date: targetDate,
    });

    if (error) {
      console.error(`[${VTID}] POST /compute/daily - RPC error:`, error.message);
      await emitLongevityEvent(
        'longevity.compute.completed',
        'error',
        `Longevity compute failed: ${error.message}`,
        {
          vtid: VTID,
          tenant_id: ctx.tenant_id,
          user_id: ctx.user_id,
          active_role: ctx.active_role,
          date: targetDate,
          error: error.message,
        }
      );

      if (error.code === 'PGRST301' || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
      return res.status(502).json({ ok: false, error: 'UPSTREAM_ERROR', message: error.message });
    }

    if (!data?.ok) {
      console.error(`[${VTID}] POST /compute/daily - RPC returned error:`, data);
      await emitLongevityEvent(
        'longevity.compute.completed',
        'error',
        `Longevity compute failed: ${data?.error || 'Unknown error'}`,
        {
          vtid: VTID,
          tenant_id: ctx.tenant_id,
          user_id: ctx.user_id,
          active_role: ctx.active_role,
          date: targetDate,
          error: data?.error,
        }
      );
      return res.status(400).json({
        ok: false,
        error: data?.error || 'COMPUTE_FAILED',
        message: data?.message || 'Failed to compute longevity signals',
      });
    }

    // Emit compute completed event
    await emitLongevityEvent(
      'longevity.compute.completed',
      'success',
      `Longevity signals computed for ${targetDate}: overall=${data.scores?.overall_longevity_score}`,
      {
        vtid: VTID,
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        active_role: ctx.active_role,
        date: targetDate,
        scores: data.scores,
        diary_entries_processed: data.diary_entries_processed,
        garden_nodes_processed: data.garden_nodes_processed,
        rules_applied_count: data.rules_applied?.length || 0,
      }
    );

    console.log(`[${VTID}] POST /compute/daily - Success for ${targetDate}: overall=${data.scores?.overall_longevity_score}`);

    return res.status(200).json({
      ok: true,
      date: data.date,
      scores: data.scores,
      evidence: data.evidence,
      rules_applied: data.rules_applied,
      diary_entries_processed: data.diary_entries_processed,
      garden_nodes_processed: data.garden_nodes_processed,
    });
  } catch (err: any) {
    console.error(`[${VTID}] POST /compute/daily - Unexpected error:`, err.message);
    await emitLongevityEvent(
      'longevity.compute.completed',
      'error',
      `Longevity compute error: ${err.message}`,
      {
        vtid: VTID,
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        active_role: ctx.active_role,
        date: targetDate,
        error: err.message,
      }
    );
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// GET /daily
// Get daily longevity signals for a date range
// Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD
// =============================================================================

router.get('/daily', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn(`[${VTID}] GET /daily - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error(`[${VTID}] GET /daily - Context error:`, ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  const fromDate = req.query.from as string;
  const toDate = req.query.to as string;

  // Validate from date (required)
  if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    console.warn(`[${VTID}] GET /daily - Invalid from date format:`, fromDate);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_DATE',
      message: 'from query param is required and must be in YYYY-MM-DD format',
    });
  }

  // Validate to date if provided
  if (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    console.warn(`[${VTID}] GET /daily - Invalid to date format:`, toDate);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_DATE',
      message: 'to query param must be in YYYY-MM-DD format',
    });
  }

  // Emit read event
  await emitLongevityEvent(
    'longevity.daily.read',
    'info',
    `Reading longevity signals from ${fromDate} to ${toDate || fromDate}`,
    {
      vtid: VTID,
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      active_role: ctx.active_role,
      from: fromDate,
      to: toDate || fromDate,
    }
  );

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('longevity_get_daily', {
      p_from: fromDate,
      p_to: toDate || null,
    });

    if (error) {
      console.error(`[${VTID}] GET /daily - RPC error:`, error.message);
      if (error.code === 'PGRST301' || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
      return res.status(502).json({ ok: false, error: 'UPSTREAM_ERROR', message: error.message });
    }

    if (!data?.ok) {
      console.error(`[${VTID}] GET /daily - RPC returned error:`, data);
      return res.status(400).json({
        ok: false,
        error: data?.error || 'FETCH_FAILED',
        message: data?.message || 'Failed to fetch longevity signals',
      });
    }

    console.log(`[${VTID}] GET /daily - Success: ${data.count} signals found`);

    return res.status(200).json({
      ok: true,
      from: data.from,
      to: data.to,
      signals: data.signals,
      count: data.count,
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /daily - Unexpected error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// GET /daily/:date/explain
// Get detailed evidence and rules for a specific date's longevity signals
// =============================================================================

router.get('/daily/:date/explain', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn(`[${VTID}] GET /daily/:date/explain - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error(`[${VTID}] GET /daily/:date/explain - Context error:`, ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  const { date } = req.params;

  // Validate date format
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.warn(`[${VTID}] GET /daily/:date/explain - Invalid date format:`, date);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_DATE',
      message: 'Date must be in YYYY-MM-DD format',
    });
  }

  // Emit explain read event
  await emitLongevityEvent(
    'longevity.explain.read',
    'info',
    `Reading longevity explanation for ${date}`,
    {
      vtid: VTID,
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      active_role: ctx.active_role,
      date,
    }
  );

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('longevity_explain_daily', {
      p_date: date,
    });

    if (error) {
      console.error(`[${VTID}] GET /daily/:date/explain - RPC error:`, error.message);
      if (error.code === 'PGRST301' || error.message.includes('JWT')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
      return res.status(502).json({ ok: false, error: 'UPSTREAM_ERROR', message: error.message });
    }

    if (!data?.ok) {
      console.error(`[${VTID}] GET /daily/:date/explain - RPC returned error:`, data);

      // Handle not found case specifically
      if (data?.error === 'SIGNAL_NOT_FOUND') {
        return res.status(404).json({
          ok: false,
          error: 'SIGNAL_NOT_FOUND',
          message: data?.message || 'No longevity signal found for this date. Run compute first.',
          date,
        });
      }

      return res.status(400).json({
        ok: false,
        error: data?.error || 'EXPLAIN_FAILED',
        message: data?.message || 'Failed to get longevity explanation',
      });
    }

    console.log(`[${VTID}] GET /daily/:date/explain - Success for ${date}`);

    return res.status(200).json({
      ok: true,
      date: data.date,
      scores: data.scores,
      diary_entries: data.diary_entries,
      garden_nodes: data.garden_nodes,
      evidence: data.evidence,
      rules_applied: data.rules_applied,
      rules_applied_keys: data.rules_applied_keys,
      computed_at: data.computed_at,
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /daily/:date/explain - Unexpected error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// GET /
// Status endpoint
// =============================================================================

router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'longevity-signal-layer',
    vtid: VTID,
    version: 'v1',
    endpoints: [
      'POST /api/v1/longevity/compute/daily',
      'GET /api/v1/longevity/daily?from=YYYY-MM-DD&to=YYYY-MM-DD',
      'GET /api/v1/longevity/daily/:date/explain',
    ],
    signal_domains: ['sleep', 'stress', 'hydration', 'nutrition', 'movement', 'social'],
    timestamp: new Date().toISOString(),
  });
});

export default router;
