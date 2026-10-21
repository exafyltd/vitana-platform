/**
 * VTID-01139: D45 Predictive Risk Windows & Opportunity Forecasting Engine
 *
 * API endpoints for the Predictive Risk Forecasting system that forecasts
 * short-term and mid-term windows where the user is statistically more likely
 * to experience risk or opportunity.
 *
 * Endpoints:
 * - GET  /api/v1/forecast            - Service info
 * - POST /api/v1/forecast/compute    - Compute risk/opportunity windows
 * - GET  /api/v1/forecast/windows    - Get active windows
 * - GET  /api/v1/forecast/windows/:id - Get window details
 * - POST /api/v1/forecast/windows/:id/acknowledge - Acknowledge window
 * - GET  /api/v1/forecast/orb-context - Get forecast context for ORB
 * - GET  /api/v1/forecast/metadata   - Get domain/status metadata
 *
 * Core Rules (Hard):
 * - All operations require authentication
 * - Forecasts ≠ facts — use probabilistic language only
 * - No fear framing or deterministic language
 * - No alerts, scheduling, behavior enforcement, or optimization without consent
 * - All outputs logged to OASIS
 *
 * Dependencies:
 * - D43 (Longitudinal Adaptation) - Trend data
 * - D44 (Predictive Signals) - Signal data (when implemented)
 * - D32 (Situational Awareness) - Context data
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  computeForecast,
  getWindows,
  getWindowDetails,
  acknowledgeWindow,
  invalidateWindow,
  getForecastContextForOrb,
  isInRiskWindow,
  isInOpportunityWindow,
  VTID,
  FORECAST_THRESHOLDS,
  DOMAIN_RISK_FACTORS,
  TIME_HORIZON_METADATA
} from '../services/d45-predictive-risk-forecasting-engine';
import {
  ComputeForecastRequestSchema,
  GetWindowsRequestSchema,
  AcknowledgeWindowRequestSchema,
  WINDOW_STATUS_METADATA
} from '../types/predictive-risk-forecasting';

const router = Router();

// =============================================================================
// VTID-01139: Helpers
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

// =============================================================================
// VTID-01139: Routes
// =============================================================================

/**
 * POST /compute -> POST /api/v1/forecast/compute
 *
 * Compute risk and opportunity windows based on current signals and patterns.
 *
 * Body:
 * - horizons: Array of time horizons to forecast (short, mid, long)
 * - domains: Optional array of domains to focus on
 * - include_opportunities: Whether to include opportunity windows (default: true)
 * - include_risks: Whether to include risk windows (default: true)
 * - historical_days: Days of historical data to analyze (default: 90)
 * - force_refresh: Force recomputation even if recent forecast exists
 */
router.post('/compute', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /forecast/compute`);

  const token = getBearerToken(req);

  // Allow dev sandbox access without token
  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = ComputeForecastRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await computeForecast(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /compute error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Forecast computed: ${result.risk_windows?.length || 0} risk, ${result.opportunity_windows?.length || 0} opportunity windows`);

  return res.status(200).json(result);
});

/**
 * GET /windows -> GET /api/v1/forecast/windows
 *
 * Get active predictive windows for the current user.
 *
 * Query params:
 * - window_types: Comma-separated list of window types (risk, opportunity)
 * - domains: Comma-separated list of domains to filter
 * - status: Comma-separated list of statuses to filter
 * - time_horizon: Filter by time horizon
 * - include_past: Include passed windows (default: false)
 * - limit: Maximum number of windows (default: 20, max: 100)
 * - offset: Pagination offset (default: 0)
 */
router.get('/windows', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /forecast/windows`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query params
  const windowTypesParam = req.query.window_types as string | undefined;
  const domainsParam = req.query.domains as string | undefined;
  const statusParam = req.query.status as string | undefined;

  const parseResult = GetWindowsRequestSchema.safeParse({
    window_types: windowTypesParam ? windowTypesParam.split(',') : undefined,
    domains: domainsParam ? domainsParam.split(',') : undefined,
    status: statusParam ? statusParam.split(',') : undefined,
    time_horizon: req.query.time_horizon,
    include_past: req.query.include_past === 'true',
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    offset: req.query.offset ? Number(req.query.offset) : undefined
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await getWindows(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /windows error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Windows retrieved: ${result.windows?.length || 0} windows`);

  return res.status(200).json(result);
});

/**
 * GET /windows/:id -> GET /api/v1/forecast/windows/:id
 *
 * Get detailed information about a specific window.
 *
 * URL params:
 * - id: UUID of the window
 */
router.get('/windows/:id', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /forecast/windows/${req.params.id}`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const windowId = req.params.id;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(windowId)) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: 'Invalid window ID format'
    });
  }

  const result = await getWindowDetails(windowId, token || undefined);

  if (!result.ok) {
    if (result.error === 'NOT_FOUND') {
      return res.status(404).json(result);
    }
    console.error(`[${VTID}] GET /windows/${windowId} error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Window details retrieved: ${windowId}`);

  return res.status(200).json(result);
});

/**
 * POST /windows/:id/acknowledge -> POST /api/v1/forecast/windows/:id/acknowledge
 *
 * Acknowledge that the user has seen/reviewed a window.
 *
 * URL params:
 * - id: UUID of the window
 *
 * Body:
 * - feedback: Optional feedback (helpful, not_helpful, too_early, too_late, inaccurate)
 * - notes: Optional user notes
 */
router.post('/windows/:id/acknowledge', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /forecast/windows/${req.params.id}/acknowledge`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = AcknowledgeWindowRequestSchema.safeParse({
    window_id: req.params.id,
    feedback: req.body.feedback,
    notes: req.body.notes
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await acknowledgeWindow(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /windows/${req.params.id}/acknowledge error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Window acknowledged: ${result.window_id}`);

  return res.status(200).json(result);
});

/**
 * POST /windows/:id/invalidate -> POST /api/v1/forecast/windows/:id/invalidate
 *
 * Invalidate a window (e.g., new data superseded the forecast).
 * This is primarily for system use but can be called by users.
 *
 * URL params:
 * - id: UUID of the window
 *
 * Body:
 * - reason: Reason for invalidation
 */
router.post('/windows/:id/invalidate', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /forecast/windows/${req.params.id}/invalidate`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const windowId = req.params.id;
  const reason = req.body.reason;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(windowId)) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: 'Invalid window ID format'
    });
  }

  if (!reason || typeof reason !== 'string' || reason.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: 'Reason is required for invalidation'
    });
  }

  const result = await invalidateWindow(windowId, reason, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /windows/${windowId}/invalidate error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Window invalidated: ${windowId}`);

  return res.status(200).json({
    ok: true,
    window_id: windowId,
    invalidated_at: new Date().toISOString()
  });
});

/**
 * GET /status/risk -> GET /api/v1/forecast/status/risk
 *
 * Check if the user is currently in a risk window.
 * Returns current active risk windows.
 */
router.get('/status/risk', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /forecast/status/risk`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const result = await isInRiskWindow(token || undefined);

  console.log(`[${VTID}] Risk status: in_risk_window=${result.inRiskWindow}, active_count=${result.activeRisks.length}`);

  return res.status(200).json({
    ok: true,
    in_risk_window: result.inRiskWindow,
    active_risk_windows: result.activeRisks,
    checked_at: new Date().toISOString()
  });
});

/**
 * GET /status/opportunity -> GET /api/v1/forecast/status/opportunity
 *
 * Check if the user is currently in an opportunity window.
 * Returns current active opportunity windows.
 */
router.get('/status/opportunity', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /forecast/status/opportunity`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const result = await isInOpportunityWindow(token || undefined);

  console.log(`[${VTID}] Opportunity status: in_opportunity_window=${result.inOpportunityWindow}, active_count=${result.activeOpportunities.length}`);

  return res.status(200).json({
    ok: true,
    in_opportunity_window: result.inOpportunityWindow,
    active_opportunity_windows: result.activeOpportunities,
    checked_at: new Date().toISOString()
  });
});

/**
 * GET /orb-context -> GET /api/v1/forecast/orb-context
 *
 * Get forecast context formatted for ORB system prompt injection.
 * Used by ORB to understand upcoming risk/opportunity windows when making decisions.
 */
router.get('/orb-context', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /forecast/orb-context`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const result = await getForecastContextForOrb(token || undefined);

  if (!result) {
    return res.status(200).json({
      ok: true,
      context: null,
      windows: [],
      message: 'No forecast context available'
    });
  }

  console.log(`[${VTID}] ORB context retrieved: ${result.windows.length} windows`);

  return res.status(200).json({
    ok: true,
    context: result.context,
    windows: result.windows
  });
});

/**
 * GET /metadata -> GET /api/v1/forecast/metadata
 *
 * Returns metadata about domains, horizons, statuses, and thresholds.
 * Useful for UI display and documentation.
 */
router.get('/metadata', async (_req: Request, res: Response) => {
  console.log(`[${VTID}] GET /forecast/metadata`);

  return res.status(200).json({
    ok: true,
    domains: DOMAIN_RISK_FACTORS,
    time_horizons: TIME_HORIZON_METADATA,
    window_statuses: WINDOW_STATUS_METADATA,
    thresholds: FORECAST_THRESHOLDS,
    vtid: VTID
  });
});

/**
 * GET / -> GET /api/v1/forecast
 *
 * Root endpoint - returns service info.
 */
router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'predictive-risk-forecasting-engine',
    vtid: VTID,
    version: 'v1',
    description: 'D45 Predictive Risk Windows & Opportunity Forecasting Engine',
    purpose: 'Forecasts short-term and mid-term windows where the user is statistically more likely to experience risk or opportunity',
    endpoints: [
      'POST /api/v1/forecast/compute - Compute risk/opportunity windows',
      'GET  /api/v1/forecast/windows - Get active windows',
      'GET  /api/v1/forecast/windows/:id - Get window details',
      'POST /api/v1/forecast/windows/:id/acknowledge - Acknowledge window',
      'POST /api/v1/forecast/windows/:id/invalidate - Invalidate window',
      'GET  /api/v1/forecast/status/risk - Check if in risk window',
      'GET  /api/v1/forecast/status/opportunity - Check if in opportunity window',
      'GET  /api/v1/forecast/orb-context - Get ORB context',
      'GET  /api/v1/forecast/metadata - Get domain/status metadata'
    ],
    governance: {
      no_alerts: true,
      no_scheduling: true,
      no_behavior_enforcement: true,
      no_optimization_without_consent: true,
      probabilistic_language_only: true,
      explainability_mandatory: true
    },
    timestamp: new Date().toISOString()
  });
});

export default router;
