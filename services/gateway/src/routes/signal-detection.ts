/**
 * VTID-01138: D44 Proactive Signal Detection & Early Intervention Engine
 *
 * API endpoints for the Signal Detection system that proactively identifies
 * early weak signals indicating potential future risk or opportunity.
 *
 * Endpoints:
 * - GET  /api/v1/predictive-signals             - List active signals
 * - GET  /api/v1/predictive-signals/stats       - Get signal statistics
 * - GET  /api/v1/predictive-signals/:id         - Get signal details
 * - POST /api/v1/predictive-signals/:id/acknowledge - Acknowledge signal
 * - POST /api/v1/predictive-signals/:id/dismiss - Dismiss signal
 * - POST /api/v1/predictive-signals/:id/action  - Record intervention action
 * - POST /api/v1/predictive-signals/detect      - Run signal detection (internal)
 * - GET  /api/v1/predictive-signals/orb-context - Get ORB context
 * - GET  /api/v1/predictive-signals/metadata    - Get signal type metadata
 *
 * Core Rules (Hard):
 * - All operations require authentication
 * - Detection is read-only (no side effects on source data)
 * - Signals are recommendations only (no autonomous actions)
 * - All actions logged to OASIS
 *
 * Dependencies:
 * - D43 (Longitudinal Adaptation)
 * - D41 (Boundary & Consent)
 * - Memory Phase C
 * - Health Phase C (optional)
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  createSignal,
  getActiveSignals,
  getSignalDetails,
  acknowledgeSignal,
  dismissSignal,
  recordIntervention,
  getSignalStats,
  runDetection,
  getSignalContextForOrb,
  VTID
} from '../services/d44-signal-detection-engine';
import {
  GetSignalsRequestSchema,
  AcknowledgeSignalRequestSchema,
  DismissSignalRequestSchema,
  RecordInterventionRequestSchema,
  RunDetectionRequestSchema,
  DETECTION_THRESHOLDS,
  SIGNAL_TYPE_METADATA,
  USER_IMPACT_METADATA,
  SUGGESTED_ACTION_METADATA
} from '../types/signal-detection';

const router = Router();

// =============================================================================
// VTID-01138: Helpers
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
// VTID-01138: Routes
// =============================================================================

/**
 * GET / -> GET /api/v1/signals
 *
 * List active signals for the current user.
 *
 * Query params:
 * - signal_types: Comma-separated list of signal types to filter (optional)
 * - min_confidence: Minimum confidence threshold (default: 0)
 * - min_impact: Minimum impact level (low, medium, high) (optional)
 * - limit: Maximum number of signals to return (default: 20)
 */
router.get('/', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /signals`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query params
  const signalTypesParam = req.query.signal_types as string | undefined;
  const signalTypes = signalTypesParam ? signalTypesParam.split(',') : undefined;

  const parseResult = GetSignalsRequestSchema.safeParse({
    signal_types: signalTypes,
    min_confidence: req.query.min_confidence ? Number(req.query.min_confidence) : undefined,
    min_impact: req.query.min_impact,
    limit: req.query.limit ? Number(req.query.limit) : undefined
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await getActiveSignals(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /signals error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Signals retrieved: ${result.count}`);

  return res.status(200).json(result);
});

/**
 * GET /stats -> GET /api/v1/signals/stats
 *
 * Get signal statistics for the current user.
 *
 * Query params:
 * - since: ISO date string for start of period (default: 30 days ago)
 */
router.get('/stats', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /signals/stats`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const since = req.query.since as string | undefined;

  const result = await getSignalStats(since, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /stats error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Stats retrieved: ${result.total_signals} total, ${result.active_signals} active`);

  return res.status(200).json(result);
});

/**
 * GET /orb-context -> GET /api/v1/signals/orb-context
 *
 * Get signal context formatted for ORB system prompt injection.
 */
router.get('/orb-context', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /signals/orb-context`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const result = await getSignalContextForOrb(token || undefined);

  if (!result) {
    return res.status(200).json({
      ok: true,
      context: null,
      activeSignals: 0,
      message: 'No active signals'
    });
  }

  console.log(`[${VTID}] ORB context retrieved: ${result.activeSignals} active signals`);

  return res.status(200).json({
    ok: true,
    context: result.context,
    activeSignals: result.activeSignals
  });
});

/**
 * GET /metadata -> GET /api/v1/signals/metadata
 *
 * Returns metadata about signal types, impacts, and actions.
 * Useful for UI display and documentation.
 */
router.get('/metadata', async (_req: Request, res: Response) => {
  console.log(`[${VTID}] GET /signals/metadata`);

  return res.status(200).json({
    ok: true,
    signal_types: SIGNAL_TYPE_METADATA,
    user_impacts: USER_IMPACT_METADATA,
    suggested_actions: SUGGESTED_ACTION_METADATA,
    thresholds: DETECTION_THRESHOLDS,
    vtid: VTID
  });
});

/**
 * GET /:id -> GET /api/v1/signals/:id
 *
 * Get detailed information about a specific signal including evidence and history.
 */
router.get('/:id', async (req: Request, res: Response) => {
  const signalId = req.params.id;
  console.log(`[${VTID}] GET /signals/${signalId}`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(signalId)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_SIGNAL_ID',
      message: 'Signal ID must be a valid UUID'
    });
  }

  const result = await getSignalDetails(signalId, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /signals/${signalId} error:`, result.error);
    const status = result.error === 'SIGNAL_NOT_FOUND' ? 404 : 400;
    return res.status(status).json(result);
  }

  console.log(`[${VTID}] Signal details retrieved: ${signalId}`);

  return res.status(200).json(result);
});

/**
 * POST /:id/acknowledge -> POST /api/v1/signals/:id/acknowledge
 *
 * Acknowledge a signal (mark as seen/acknowledged).
 *
 * Body:
 * - feedback: Optional feedback text
 */
router.post('/:id/acknowledge', async (req: Request, res: Response) => {
  const signalId = req.params.id;
  console.log(`[${VTID}] POST /signals/${signalId}/acknowledge`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = AcknowledgeSignalRequestSchema.safeParse({
    signal_id: signalId,
    feedback: req.body.feedback
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await acknowledgeSignal(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /signals/${signalId}/acknowledge error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Signal acknowledged: ${signalId}`);

  return res.status(200).json(result);
});

/**
 * POST /:id/dismiss -> POST /api/v1/signals/:id/dismiss
 *
 * Dismiss a signal (mark as not relevant).
 *
 * Body:
 * - reason: Optional reason for dismissal
 */
router.post('/:id/dismiss', async (req: Request, res: Response) => {
  const signalId = req.params.id;
  console.log(`[${VTID}] POST /signals/${signalId}/dismiss`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = DismissSignalRequestSchema.safeParse({
    signal_id: signalId,
    reason: req.body.reason
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await dismissSignal(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /signals/${signalId}/dismiss error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Signal dismissed: ${signalId}`);

  return res.status(200).json(result);
});

/**
 * POST /:id/action -> POST /api/v1/signals/:id/action
 *
 * Record an intervention action on a signal.
 *
 * Body:
 * - action_type: Type of action (acknowledged, dismissed, marked_helpful, etc.)
 * - action_details: Optional additional details
 */
router.post('/:id/action', async (req: Request, res: Response) => {
  const signalId = req.params.id;
  console.log(`[${VTID}] POST /signals/${signalId}/action`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = RecordInterventionRequestSchema.safeParse({
    signal_id: signalId,
    action_type: req.body.action_type,
    action_details: req.body.action_details || {}
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await recordIntervention(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /signals/${signalId}/action error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Intervention recorded: ${req.body.action_type}`);

  return res.status(200).json(result);
});

/**
 * POST /detect -> POST /api/v1/signals/detect
 *
 * Run signal detection with provided input data.
 * This is an internal endpoint for triggering detection.
 *
 * Body:
 * - input: Detection input data (diary entries, health features, etc.)
 * - signal_types: Optional array of signal types to check
 * - time_window: Time window for analysis (default: last_14_days)
 * - force: Bypass rate limiting (default: false)
 */
router.post('/detect', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /signals/detect`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = RunDetectionRequestSchema.safeParse({
    signal_types: req.body.signal_types,
    time_window: req.body.time_window,
    force: req.body.force
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const input = req.body.input || {};

  const result = await runDetection(input, parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /detect error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Detection completed: ${result.signals_detected} detected, ${result.signals_created} created`);

  return res.status(200).json(result);
});

/**
 * GET /info -> Root endpoint - returns service info.
 */
router.get('/info', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'signal-detection-engine',
    vtid: VTID,
    version: 'v1',
    description: 'D44 Proactive Signal Detection & Early Intervention Engine',
    endpoints: [
      'GET  /api/v1/predictive-signals - List active signals',
      'GET  /api/v1/predictive-signals/stats - Get signal statistics',
      'GET  /api/v1/predictive-signals/orb-context - Get ORB context',
      'GET  /api/v1/predictive-signals/metadata - Get signal type metadata',
      'GET  /api/v1/predictive-signals/:id - Get signal details',
      'POST /api/v1/predictive-signals/:id/acknowledge - Acknowledge signal',
      'POST /api/v1/predictive-signals/:id/dismiss - Dismiss signal',
      'POST /api/v1/predictive-signals/:id/action - Record intervention action',
      'POST /api/v1/predictive-signals/detect - Run signal detection'
    ],
    signal_types: Object.keys(SIGNAL_TYPE_METADATA),
    timestamp: new Date().toISOString()
  });
});

export default router;
