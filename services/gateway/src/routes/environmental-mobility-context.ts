/**
 * VTID-01128: D34 Environmental, Location & Mobility Context Routes
 *
 * Endpoints:
 * - POST   /api/v1/context/mobility/compute   - Compute fresh context bundle
 * - GET    /api/v1/context/mobility           - Get current context (cached or fresh)
 * - POST   /api/v1/context/mobility/filter    - Filter actions through context
 * - POST   /api/v1/context/mobility/override  - Apply user override
 * - GET    /api/v1/context/mobility/health    - Health check
 *
 * Dependencies:
 * - D27 (User Preferences) - for mobility preferences
 * - D32 (Situation Vector) - optional, enhances context
 * - D33 (Availability) - optional, enhances filtering
 * - VTID-01091 (Locations) - for visit history
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  computeContext,
  getCurrentContext,
  filterActionsBatch,
  applyContextOverride,
  getOrbMobilityContext,
  verifyBundleIntegrity,
  VTID
} from '../services/d34-environmental-mobility-engine';
import {
  ComputeContextRequestSchema,
  FilterActionsRequestSchema,
  OverrideContextRequestSchema
} from '../types/environmental-mobility-context';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01128: Helper Functions
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
 * Check if running in dev sandbox mode
 */
function isDevSandbox(): boolean {
  const env = (process.env.ENVIRONMENT || process.env.VITANA_ENV || '').toLowerCase();
  return env === 'dev-sandbox' ||
         env === 'dev' ||
         env === 'development' ||
         env === 'sandbox' ||
         env.includes('dev') ||
         env.includes('sandbox');
}

/**
 * Emit a D34-related OASIS event
 */
async function emitD34Event(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: VTID,
    type: type as any,
    source: 'd34-routes',
    status,
    message,
    payload
  }).catch(err => console.warn(`[${VTID}] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01128: Routes
// =============================================================================

/**
 * POST /compute -> POST /api/v1/context/mobility/compute
 *
 * Compute a fresh D34 context bundle.
 * Use this for explicit context computation with full control.
 */
router.post('/compute', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /context/mobility/compute`);

  const token = getBearerToken(req);
  if (!token && !isDevSandbox()) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const validation = ComputeContextRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  try {
    const result = await computeContext(validation.data, token || undefined);

    if (!result.ok) {
      await emitD34Event(
        'd34.compute.failed',
        'error',
        `Context computation failed: ${result.error}`,
        { error: result.error }
      );

      return res.status(400).json({
        ok: false,
        error: result.error,
        message: result.message
      });
    }

    console.log(`[${VTID}] Context computed: ${result.bundle?.bundle_id}`);

    return res.status(200).json({
      ok: true,
      bundle: result.bundle
    });

  } catch (err: any) {
    console.error(`[${VTID}] compute error:`, err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * GET / -> GET /api/v1/context/mobility
 *
 * Get current D34 context (cached if available, fresh otherwise).
 * Lightweight endpoint for quick context checks.
 */
router.get('/', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /context/mobility`);

  const token = getBearerToken(req);
  if (!token && !isDevSandbox()) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Extract optional query params
  const userId = req.query.user_id as string | undefined;
  const sessionId = req.query.session_id as string | undefined;

  try {
    const result = await getCurrentContext(userId, sessionId, token || undefined);

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.error
      });
    }

    console.log(`[${VTID}] Context retrieved: ${result.bundle?.bundle_id} (cached: ${result.cached})`);

    return res.status(200).json({
      ok: true,
      bundle: result.bundle,
      cached: result.cached,
      cache_age_seconds: result.cache_age_seconds
    });

  } catch (err: any) {
    console.error(`[${VTID}] get context error:`, err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * POST /filter -> POST /api/v1/context/mobility/filter
 *
 * Filter a batch of actions through the D34 context.
 * Returns filtered actions with mobility fit assessments.
 */
router.post('/filter', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /context/mobility/filter`);

  const token = getBearerToken(req);
  if (!token && !isDevSandbox()) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const validation = FilterActionsRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  if (validation.data.actions.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'No actions to filter'
    });
  }

  try {
    const result = await filterActionsBatch(validation.data, token || undefined);

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.error
      });
    }

    console.log(`[${VTID}] Filtered ${validation.data.actions.length} actions: ${result.passed_count} passed, ${result.rejected_count} rejected`);

    return res.status(200).json({
      ok: true,
      results: result.results,
      passed_count: result.passed_count,
      rejected_count: result.rejected_count,
      context_bundle_id: result.context_bundle_id
    });

  } catch (err: any) {
    console.error(`[${VTID}] filter error:`, err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * POST /override -> POST /api/v1/context/mobility/override
 *
 * Apply a user override to the current context.
 * Used when user corrects inferred context.
 */
router.post('/override', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /context/mobility/override`);

  const token = getBearerToken(req);
  if (!token && !isDevSandbox()) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const validation = OverrideContextRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  // Extract user/session IDs from query or body
  const userId = req.query.user_id as string | undefined;
  const sessionId = req.query.session_id as string | undefined;

  try {
    const result = await applyContextOverride(
      validation.data,
      userId,
      sessionId,
      token || undefined
    );

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.error
      });
    }

    console.log(`[${VTID}] Override applied: ${result.override_id}`);

    return res.status(200).json({
      ok: true,
      override_id: result.override_id,
      expires_at: result.expires_at,
      message: 'Override applied successfully'
    });

  } catch (err: any) {
    console.error(`[${VTID}] override error:`, err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * GET /orb -> GET /api/v1/context/mobility/orb
 *
 * Get context formatted for ORB system prompt injection.
 * Lightweight endpoint for ORB memory bridge.
 */
router.get('/orb', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /context/mobility/orb`);

  const token = getBearerToken(req);
  if (!token && !isDevSandbox()) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const userId = req.query.user_id as string | undefined;
  const sessionId = req.query.session_id as string | undefined;

  try {
    const result = await getOrbMobilityContext(userId, sessionId, token || undefined);

    if (!result) {
      return res.status(200).json({
        ok: true,
        context: null,
        message: 'No mobility context available'
      });
    }

    return res.status(200).json({
      ok: true,
      context: result.context,
      orb_context: result.orbContext
    });

  } catch (err: any) {
    console.error(`[${VTID}] orb context error:`, err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * POST /verify -> POST /api/v1/context/mobility/verify
 *
 * Verify integrity of a context bundle.
 * Used for determinism checks.
 */
router.post('/verify', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /context/mobility/verify`);

  const token = getBearerToken(req);
  if (!token && !isDevSandbox()) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { bundle } = req.body;
  if (!bundle) {
    return res.status(400).json({
      ok: false,
      error: 'Bundle is required'
    });
  }

  try {
    const isValid = verifyBundleIntegrity(bundle);

    return res.status(200).json({
      ok: true,
      valid: isValid,
      bundle_id: bundle.bundle_id,
      bundle_hash: bundle.bundle_hash
    });

  } catch (err: any) {
    console.error(`[${VTID}] verify error:`, err.message);
    return res.status(400).json({
      ok: false,
      error: err.message,
      valid: false
    });
  }
});

/**
 * GET /health -> GET /api/v1/context/mobility/health
 *
 * Health check for D34 service.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY ||
                        !!process.env.SUPABASE_SERVICE_ROLE_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'd34-environmental-mobility-context',
    version: '1.0.0',
    vtid: VTID,
    timestamp: new Date().toISOString(),
    capabilities: {
      location_resolution: hasSupabaseUrl && hasSupabaseKey,
      mobility_profiling: hasSupabaseUrl && hasSupabaseKey,
      environmental_constraints: true,
      action_filtering: true,
      orb_integration: true,
      determinism_verification: true
    },
    dependencies: {
      'VTID-01119': 'D27 User Preferences (optional)',
      'VTID-01091': 'Locations (optional)',
      'D32': 'Situation Vector (optional, not yet implemented)',
      'D33': 'Availability (optional, not yet implemented)'
    },
    behavioral_rules: [
      'Never assume precise location without consent',
      'Default to local + low effort',
      'Avoid unsafe timing/location combinations',
      'Defer suggestions when environment fit is low'
    ]
  });
});

export default router;
