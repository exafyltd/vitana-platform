/**
 * VTID-01096: Cross-Domain Personalization v1 (Health <-> Community <-> Offers <-> Locations)
 *
 * Read-time personalization endpoints. Deterministic, explainable, safe.
 *
 * Endpoints:
 * - GET  /api/v1/personalization/snapshot  - Get unified personalization snapshot
 * - GET  /api/v1/personalization/health    - Health check for personalization service
 *
 * Core Rules (Hard):
 * - Personalization only if allow_location_personalization = true (for locations)
 * - Role must be patient (or explicit grant for professional view)
 * - No cross-user personalization leakage
 * - Explanations are templates, not AI-generated
 *
 * Dependencies:
 * - VTID-01083 (longevity signals)
 * - VTID-01084 (community recs)
 * - VTID-01092 (offers)
 * - VTID-01091 (locations)
 * - VTID-01093 (topics)
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  generatePersonalizationSnapshot,
  emitPersonalizationEvent,
  writePersonalizationAudit,
  HealthScores
} from '../services/personalization-service';

const router = Router();

// =============================================================================
// VTID-01096: Constants
// =============================================================================

const VTID = 'VTID-01096';

// =============================================================================
// VTID-01096: Helpers
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
 * Get user context from me_context RPC.
 */
async function getUserContext(token: string): Promise<{
  ok: boolean;
  tenant_id: string | null;
  user_id: string | null;
  active_role: string | null;
  allow_location_personalization?: boolean;
  low_sodium_constraint?: boolean;
  error?: string;
}> {
  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');

    if (error) {
      return { ok: false, tenant_id: null, user_id: null, active_role: null, error: error.message };
    }

    // Extract preferences from the context if available
    const preferences = data?.preferences || {};

    return {
      ok: true,
      tenant_id: data?.tenant_id || null,
      user_id: data?.user_id || data?.id || null,
      active_role: data?.active_role || 'patient',
      allow_location_personalization: preferences?.allow_location_personalization ?? true,
      low_sodium_constraint: preferences?.low_sodium ?? false
    };
  } catch (err: any) {
    return { ok: false, tenant_id: null, user_id: null, active_role: null, error: err.message };
  }
}

/**
 * Get health scores for a user.
 * Fetches from vitana_index_scores table.
 */
async function getHealthScores(token: string, date?: string): Promise<{
  current: HealthScores | null;
  previous: HealthScores | null;
}> {
  try {
    const supabase = createUserSupabaseClient(token);
    const targetDate = date || new Date().toISOString().split('T')[0];

    // Get current scores
    const { data: currentData, error: currentError } = await supabase
      .from('vitana_index_scores')
      .select('score_total, score_physical, score_mental, score_nutritional, score_social, score_environmental')
      .eq('date', targetDate)
      .single();

    if (currentError && currentError.code !== 'PGRST116') {
      console.warn(`[${VTID}] Error fetching current scores:`, currentError.message);
    }

    // Get previous day scores for trend detection
    const previousDate = new Date(targetDate);
    previousDate.setDate(previousDate.getDate() - 1);
    const previousDateStr = previousDate.toISOString().split('T')[0];

    const { data: previousData, error: previousError } = await supabase
      .from('vitana_index_scores')
      .select('score_total, score_physical, score_mental, score_nutritional, score_social, score_environmental')
      .eq('date', previousDateStr)
      .single();

    if (previousError && previousError.code !== 'PGRST116') {
      console.warn(`[${VTID}] Error fetching previous scores:`, previousError.message);
    }

    return {
      current: currentData as HealthScores | null,
      previous: previousData as HealthScores | null
    };
  } catch (err: any) {
    console.error(`[${VTID}] getHealthScores error:`, err.message);
    return { current: null, previous: null };
  }
}

// =============================================================================
// VTID-01096: Routes
// =============================================================================

/**
 * GET /snapshot -> GET /api/v1/personalization/snapshot
 *
 * Returns a unified personalization snapshot with:
 * - Top topics from user profile
 * - Detected weaknesses (movement, sleep, stress, nutrition, social)
 * - Recommended next actions with explanations
 * - Template-based (not AI) explanations
 *
 * Query params:
 * - date: Optional date (YYYY-MM-DD) for health scores. Defaults to today.
 */
router.get('/snapshot', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /personalization/snapshot`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Get user context
  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error(`[${VTID}] GET /personalization/snapshot - Context error:`, ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  // Validate role (must be patient or have explicit grant)
  if (ctx.active_role === 'professional' && !req.query.professional_view) {
    return res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: 'Personalization requires patient role or explicit professional_view grant'
    });
  }

  // Get health scores
  const date = req.query.date as string | undefined;
  const { current, previous } = await getHealthScores(token, date);

  // Generate personalization snapshot
  const snapshot = generatePersonalizationSnapshot(
    ctx.user_id!,
    ctx.tenant_id!,
    current,
    previous,
    { low_sodium: ctx.low_sodium_constraint }
  );

  // Emit OASIS event for snapshot read
  await emitPersonalizationEvent(
    'personalization.snapshot.read',
    'success',
    `Personalization snapshot generated with ${snapshot.weaknesses.length} weaknesses`,
    {
      tenant_id: ctx.tenant_id ?? undefined,
      user_id: ctx.user_id ?? undefined,
      weaknesses: snapshot.weaknesses,
      top_topics: snapshot.top_topics,
      snapshot_id: snapshot.snapshot_id
    }
  );

  // Write audit entry (async, don't wait)
  writePersonalizationAudit(
    ctx.tenant_id!,
    ctx.user_id!,
    '/api/v1/personalization/snapshot',
    snapshot
  ).catch(err => console.warn(`[${VTID}] Audit write failed:`, err.message));

  console.log(`[${VTID}] Snapshot generated: ${snapshot.snapshot_id} with ${snapshot.weaknesses.length} weaknesses`);

  return res.status(200).json(snapshot);
});

/**
 * GET / -> GET /api/v1/personalization
 *
 * Root endpoint - returns service info.
 */
router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'personalization-gateway',
    vtid: VTID,
    version: 'v1',
    description: 'Cross-Domain Personalization v1 (Health <-> Community <-> Offers <-> Locations)',
    endpoints: [
      'GET /api/v1/personalization/snapshot - Get unified personalization snapshot',
      'GET /api/v1/personalization/health - Health check'
    ],
    timestamp: new Date().toISOString()
  });
});

export default router;
