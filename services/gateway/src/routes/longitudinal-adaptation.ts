/**
 * VTID-01137: D43 Longitudinal Adaptation, Drift Detection & Personal Evolution Engine
 *
 * API endpoints for the Longitudinal Adaptation system that tracks user evolution
 * over time and adapts intelligence accordingly.
 *
 * Endpoints:
 * - GET  /api/v1/longitudinal/state       - Get current evolution state
 * - GET  /api/v1/longitudinal/trends      - Get longitudinal trends
 * - POST /api/v1/longitudinal/data        - Record a longitudinal data point
 * - GET  /api/v1/longitudinal/drift       - Detect drift
 * - GET  /api/v1/longitudinal/adaptations - Get adaptation plans
 * - POST /api/v1/longitudinal/drift/acknowledge - Acknowledge drift
 * - POST /api/v1/longitudinal/adaptations/:id/approve - Approve adaptation
 * - POST /api/v1/longitudinal/adaptations/:id/rollback - Rollback adaptation
 * - POST /api/v1/longitudinal/snapshot    - Create preference snapshot
 *
 * Core Rules (Hard):
 * - All operations require authentication
 * - Drift detection is read-only (no side effects)
 * - Adaptations require explicit user approval for major changes
 * - Rollback available for ROLLBACK_WINDOW_DAYS after adaptation
 *
 * Dependencies:
 * - D27 (Preference Modeling)
 * - D28 (Emotional/Cognitive Signals)
 * - D29 (Contextual Feedback) - when implemented
 * - D41 (Boundary & Consent)
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  recordDataPoint,
  getTrends,
  detectDrift,
  getEvolutionState,
  generateAdaptationPlan,
  approveAdaptation,
  rollbackAdaptation,
  acknowledgeDrift,
  createSnapshot,
  getEvolutionContextForOrb,
  VTID
} from '../services/d43-longitudinal-adaptation-engine';
import {
  RecordDataPointRequestSchema,
  GetTrendsRequestSchema,
  DetectDriftRequestSchema,
  ApproveAdaptationRequestSchema,
  RollbackAdaptationRequestSchema,
  AcknowledgeDriftRequestSchema,
  LONGITUDINAL_DOMAIN_METADATA,
  EVOLUTION_TAG_METADATA,
  DRIFT_THRESHOLDS
} from '../types/longitudinal-adaptation';

const router = Router();

// =============================================================================
// VTID-01137: Helpers
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
      active_role: data?.active_role || 'patient'
    };
  } catch (err: any) {
    return { ok: false, tenant_id: null, user_id: null, active_role: null, error: err.message };
  }
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
// VTID-01137: Routes
// =============================================================================

/**
 * GET /state -> GET /api/v1/longitudinal/state
 *
 * Returns the current evolution state including:
 * - Evolution tags (stable, drift_detected, exploration_phase, etc.)
 * - Overall stability score
 * - Active drift events
 * - Pending adaptation plans
 */
router.get('/state', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /longitudinal/state`);

  const token = getBearerToken(req);

  // Allow dev sandbox access without token
  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const result = await getEvolutionState(token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /state error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Evolution state retrieved: tags=${result.evolution_tags?.join(',')}, stability=${result.overall_stability}`);

  return res.status(200).json(result);
});

/**
 * GET /trends -> GET /api/v1/longitudinal/trends
 *
 * Returns longitudinal trend analysis for specified domains.
 *
 * Query params:
 * - domains: Comma-separated list of domains to analyze (optional)
 * - time_window_days: Number of days to analyze (default: 30)
 * - min_data_points: Minimum data points required (default: 5)
 */
router.get('/trends', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /longitudinal/trends`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query params
  const domainsParam = req.query.domains as string | undefined;
  const domains = domainsParam ? domainsParam.split(',') : undefined;

  const parseResult = GetTrendsRequestSchema.safeParse({
    domains,
    time_window_days: req.query.time_window_days ? Number(req.query.time_window_days) : undefined,
    min_data_points: req.query.min_data_points ? Number(req.query.min_data_points) : undefined
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await getTrends(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /trends error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Trends retrieved: ${result.data_points_count} data points over ${result.time_span_days} days`);

  return res.status(200).json(result);
});

/**
 * POST /data -> POST /api/v1/longitudinal/data
 *
 * Records a longitudinal data point for tracking over time.
 *
 * Body:
 * - domain: The longitudinal domain (preference, goal, engagement, etc.)
 * - key: Specific key within the domain
 * - value: The value to record
 * - numeric_value: Optional numeric representation for trend analysis
 * - source: How this data was obtained (explicit, inferred, behavioral, system)
 * - confidence: Confidence level (0-100)
 * - metadata: Optional additional context
 */
router.post('/data', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /longitudinal/data`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = RecordDataPointRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await recordDataPoint(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /data error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Data point recorded: ${result.domain}/${result.key}`);

  return res.status(201).json(result);
});

/**
 * GET /drift -> GET /api/v1/longitudinal/drift
 *
 * Detects drift across user domains.
 *
 * Query params:
 * - domains: Comma-separated list of domains to check (optional)
 * - sensitivity: Detection sensitivity (low, medium, high) - default: medium
 * - time_window_days: Analysis window (default: 30)
 */
router.get('/drift', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /longitudinal/drift`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query params
  const domainsParam = req.query.domains as string | undefined;
  const domains = domainsParam ? domainsParam.split(',') : undefined;

  const parseResult = DetectDriftRequestSchema.safeParse({
    domains,
    sensitivity: req.query.sensitivity,
    time_window_days: req.query.time_window_days ? Number(req.query.time_window_days) : undefined
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await detectDrift(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /drift error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Drift detection: detected=${result.drift_detected}, events=${result.events.length}, stability=${result.overall_stability}`);

  return res.status(200).json(result);
});

/**
 * POST /drift/acknowledge -> POST /api/v1/longitudinal/drift/acknowledge
 *
 * Acknowledge a drift event with user response.
 *
 * Body:
 * - drift_id: UUID of the drift event
 * - response: User response (confirm_change, temporary, not_me_anymore, ignore)
 */
router.post('/drift/acknowledge', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /longitudinal/drift/acknowledge`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = AcknowledgeDriftRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await acknowledgeDrift(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /drift/acknowledge error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Drift acknowledged: ${result.drift_id}, response=${result.response_recorded}`);

  return res.status(200).json(result);
});

/**
 * GET /adaptations -> GET /api/v1/longitudinal/adaptations
 *
 * Get adaptation plans.
 *
 * Query params:
 * - include_applied: Include already applied plans (default: false)
 * - limit: Maximum number of plans to return (default: 10)
 */
router.get('/adaptations', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /longitudinal/adaptations`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // For now, get evolution state which includes pending adaptations
  const result = await getEvolutionState(token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /adaptations error:`, result.error);
    return res.status(400).json(result);
  }

  const response = {
    ok: true,
    plans: result.pending_adaptations || [],
    count: result.pending_adaptations?.length || 0
  };

  console.log(`[${VTID}] Adaptations retrieved: ${response.count} pending`);

  return res.status(200).json(response);
});

/**
 * POST /adaptations/:id/approve -> POST /api/v1/longitudinal/adaptations/:id/approve
 *
 * Approve or reject an adaptation plan.
 *
 * URL params:
 * - id: UUID of the adaptation plan
 *
 * Body:
 * - confirm: true to approve, false to reject
 */
router.post('/adaptations/:id/approve', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /longitudinal/adaptations/${req.params.id}/approve`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = ApproveAdaptationRequestSchema.safeParse({
    plan_id: req.params.id,
    confirm: req.body.confirm
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await approveAdaptation(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /adaptations/${req.params.id}/approve error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Adaptation ${result.status}: ${result.plan_id}`);

  return res.status(200).json(result);
});

/**
 * POST /adaptations/:id/rollback -> POST /api/v1/longitudinal/adaptations/:id/rollback
 *
 * Rollback a previously applied adaptation.
 *
 * URL params:
 * - id: UUID of the adaptation plan
 *
 * Body:
 * - reason: Optional reason for rollback
 */
router.post('/adaptations/:id/rollback', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /longitudinal/adaptations/${req.params.id}/rollback`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = RollbackAdaptationRequestSchema.safeParse({
    plan_id: req.params.id,
    reason: req.body.reason
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await rollbackAdaptation(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /adaptations/${req.params.id}/rollback error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Adaptation rolled back: ${result.plan_id}`);

  return res.status(200).json(result);
});

/**
 * POST /snapshot -> POST /api/v1/longitudinal/snapshot
 *
 * Create a preference snapshot for rollback.
 *
 * Body:
 * - snapshot_type: Type of snapshot (before_adaptation, periodic, user_requested)
 * - adaptation_plan_id: Optional associated adaptation plan
 */
router.post('/snapshot', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /longitudinal/snapshot`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const snapshotType = req.body.snapshot_type || 'user_requested';
  const adaptationPlanId = req.body.adaptation_plan_id;

  if (!['before_adaptation', 'periodic', 'user_requested'].includes(snapshotType)) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: 'snapshot_type must be one of: before_adaptation, periodic, user_requested'
    });
  }

  const result = await createSnapshot(snapshotType, adaptationPlanId, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /snapshot error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Snapshot created: ${result.snapshot_id}`);

  return res.status(201).json(result);
});

/**
 * GET /orb-context -> GET /api/v1/longitudinal/orb-context
 *
 * Get evolution context formatted for ORB system prompt injection.
 * Used by ORB to understand user's evolution state when making decisions.
 */
router.get('/orb-context', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /longitudinal/orb-context`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const result = await getEvolutionContextForOrb(token || undefined);

  if (!result) {
    return res.status(200).json({
      ok: true,
      context: null,
      tags: [],
      message: 'No evolution context available'
    });
  }

  console.log(`[${VTID}] ORB context retrieved: tags=${result.tags.join(',')}`);

  return res.status(200).json({
    ok: true,
    context: result.context,
    tags: result.tags
  });
});

/**
 * GET /metadata -> GET /api/v1/longitudinal/metadata
 *
 * Returns metadata about domains, tags, and thresholds.
 * Useful for UI display and documentation.
 */
router.get('/metadata', async (_req: Request, res: Response) => {
  console.log(`[${VTID}] GET /longitudinal/metadata`);

  return res.status(200).json({
    ok: true,
    domains: LONGITUDINAL_DOMAIN_METADATA,
    evolution_tags: EVOLUTION_TAG_METADATA,
    thresholds: DRIFT_THRESHOLDS,
    vtid: VTID
  });
});

/**
 * GET / -> GET /api/v1/longitudinal
 *
 * Root endpoint - returns service info.
 */
router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'longitudinal-adaptation-engine',
    vtid: VTID,
    version: 'v1',
    description: 'D43 Longitudinal Adaptation, Drift Detection & Personal Evolution Engine',
    endpoints: [
      'GET  /api/v1/longitudinal/state - Get current evolution state',
      'GET  /api/v1/longitudinal/trends - Get longitudinal trends',
      'POST /api/v1/longitudinal/data - Record a longitudinal data point',
      'GET  /api/v1/longitudinal/drift - Detect drift',
      'POST /api/v1/longitudinal/drift/acknowledge - Acknowledge drift',
      'GET  /api/v1/longitudinal/adaptations - Get adaptation plans',
      'POST /api/v1/longitudinal/adaptations/:id/approve - Approve adaptation',
      'POST /api/v1/longitudinal/adaptations/:id/rollback - Rollback adaptation',
      'POST /api/v1/longitudinal/snapshot - Create preference snapshot',
      'GET  /api/v1/longitudinal/orb-context - Get ORB context',
      'GET  /api/v1/longitudinal/metadata - Get domain/tag metadata'
    ],
    timestamp: new Date().toISOString()
  });
});

export default router;
