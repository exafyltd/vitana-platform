/**
 * VTID-01144: D50 Positive Trajectory Reinforcement & Momentum Engine
 *
 * API endpoints for the positive-only reinforcement system that identifies
 * what's working and helps users continue their positive trajectories.
 *
 * Endpoints:
 * - GET  /api/v1/reinforcement/momentum      - Get current momentum state
 * - GET  /api/v1/reinforcement/eligibility   - Check reinforcement eligibility
 * - POST /api/v1/reinforcement/generate      - Generate a reinforcement
 * - POST /api/v1/reinforcement/:id/deliver   - Mark reinforcement as delivered
 * - POST /api/v1/reinforcement/:id/dismiss   - Dismiss a reinforcement
 * - GET  /api/v1/reinforcement/history       - Get reinforcement history
 * - GET  /api/v1/reinforcement/orb-context   - Get ORB context for momentum
 * - GET  /api/v1/reinforcement/metadata      - Get trajectory type metadata
 *
 * Core Rules (Hard - Non-Negotiable):
 * - Positive-only reinforcement (no correction)
 * - No comparison with others
 * - No gamification pressure
 * - No behavioral enforcement
 * - Focus on continuation, not escalation
 * - All outputs logged to OASIS
 *
 * Dependencies:
 * - D43 (Longitudinal Adaptation) - for trend data
 * - D44 (Positive Signals) - when implemented
 * - D45 (Opportunity Windows) - when implemented
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  checkEligibility,
  generateReinforcement,
  markDelivered,
  dismissReinforcement,
  getReinforcementHistory,
  getMomentumState,
  getReinforcementContextForOrb,
  VTID,
  REINFORCEMENT_THRESHOLDS,
  TRAJECTORY_TYPE_METADATA,
  FRAMING_RULES
} from '../services/d50-positive-trajectory-reinforcement-engine';
import {
  CheckEligibilityRequestSchema,
  GenerateReinforcementRequestSchema,
  DismissReinforcementRequestSchema,
  GetReinforcementHistoryRequestSchema,
  GetMomentumStateRequestSchema,
  TrajectoryType
} from '../types/positive-trajectory-reinforcement';

const router = Router();

// =============================================================================
// VTID-01144: Helpers
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
// VTID-01144: Routes
// =============================================================================

/**
 * GET /momentum -> GET /api/v1/reinforcement/momentum
 *
 * Returns the current momentum state including:
 * - Overall momentum (building, stable, fragile, unknown)
 * - Trajectory summaries for each type
 * - Recent reinforcements
 * - Next opportunity window
 */
router.get('/momentum', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /reinforcement/momentum`);

  const token = getBearerToken(req);

  // Allow dev sandbox access without token
  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = GetMomentumStateRequestSchema.safeParse({
    include_eligible: req.query.include_eligible !== 'false',
    include_recent: req.query.include_recent !== 'false'
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await getMomentumState(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /momentum error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Momentum state retrieved: ${result.state?.overall_momentum}`);

  return res.status(200).json(result);
});

/**
 * GET /eligibility -> GET /api/v1/reinforcement/eligibility
 *
 * Check eligibility for reinforcement across trajectory types.
 *
 * Query params:
 * - trajectory_types: Comma-separated list of types to check (optional)
 * - include_evidence: Include evidence summary (default: false)
 */
router.get('/eligibility', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /reinforcement/eligibility`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query params
  const typesParam = req.query.trajectory_types as string | undefined;
  const trajectoryTypes = typesParam ? typesParam.split(',') as TrajectoryType[] : undefined;

  const parseResult = CheckEligibilityRequestSchema.safeParse({
    trajectory_types: trajectoryTypes,
    include_evidence: req.query.include_evidence === 'true'
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await checkEligibility(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /eligibility error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Eligibility checked: ${result.eligible_trajectories.filter(t => t.eligible).length} eligible`);

  return res.status(200).json(result);
});

/**
 * POST /generate -> POST /api/v1/reinforcement/generate
 *
 * Generate a positive reinforcement.
 *
 * Body:
 * - trajectory_type: Optional specific type to generate for
 * - force_regenerate: Force regeneration even if recently generated (default: false)
 * - include_context_snapshot: Include context snapshot in storage (default: true)
 */
router.post('/generate', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /reinforcement/generate`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = GenerateReinforcementRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await generateReinforcement(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /generate error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Reinforcement generated: ${result.reinforcement?.trajectory_type}`);

  return res.status(201).json(result);
});

/**
 * POST /:id/deliver -> POST /api/v1/reinforcement/:id/deliver
 *
 * Mark a reinforcement as delivered to the user.
 *
 * URL params:
 * - id: UUID of the reinforcement
 */
router.post('/:id/deliver', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /reinforcement/${req.params.id}/deliver`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const reinforcementId = req.params.id;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(reinforcementId)) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: 'Invalid reinforcement_id format'
    });
  }

  const result = await markDelivered(reinforcementId, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /${reinforcementId}/deliver error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Reinforcement delivered: ${reinforcementId}`);

  return res.status(200).json({
    ok: true,
    reinforcement_id: reinforcementId,
    delivered_at: new Date().toISOString()
  });
});

/**
 * POST /:id/dismiss -> POST /api/v1/reinforcement/:id/dismiss
 *
 * Dismiss a reinforcement.
 *
 * URL params:
 * - id: UUID of the reinforcement
 *
 * Body:
 * - reason: Optional reason (not_relevant, already_aware, timing_off, no_reason)
 */
router.post('/:id/dismiss', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /reinforcement/${req.params.id}/dismiss`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const parseResult = DismissReinforcementRequestSchema.safeParse({
    reinforcement_id: req.params.id,
    reason: req.body.reason
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await dismissReinforcement(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] POST /${req.params.id}/dismiss error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] Reinforcement dismissed: ${result.reinforcement_id}`);

  return res.status(200).json(result);
});

/**
 * GET /history -> GET /api/v1/reinforcement/history
 *
 * Get reinforcement history.
 *
 * Query params:
 * - trajectory_types: Comma-separated list of types (optional)
 * - limit: Maximum number to return (default: 20)
 * - include_dismissed: Include dismissed reinforcements (default: false)
 */
router.get('/history', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /reinforcement/history`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query params
  const typesParam = req.query.trajectory_types as string | undefined;
  const trajectoryTypes = typesParam ? typesParam.split(',') as TrajectoryType[] : undefined;

  const parseResult = GetReinforcementHistoryRequestSchema.safeParse({
    trajectory_types: trajectoryTypes,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    include_dismissed: req.query.include_dismissed === 'true'
  });

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: parseResult.error.issues
    });
  }

  const result = await getReinforcementHistory(parseResult.data, token || undefined);

  if (!result.ok) {
    console.error(`[${VTID}] GET /history error:`, result.error);
    return res.status(400).json(result);
  }

  console.log(`[${VTID}] History retrieved: ${result.count} reinforcements`);

  return res.status(200).json(result);
});

/**
 * GET /orb-context -> GET /api/v1/reinforcement/orb-context
 *
 * Get reinforcement context formatted for ORB system prompt injection.
 * Used by ORB to understand user's positive momentum when making decisions.
 */
router.get('/orb-context', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /reinforcement/orb-context`);

  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const result = await getReinforcementContextForOrb(token || undefined);

  if (!result) {
    return res.status(200).json({
      ok: true,
      context: null,
      has_positive_trajectories: false,
      message: 'No reinforcement context available'
    });
  }

  console.log(`[${VTID}] ORB context retrieved: has_positive=${result.hasPositiveTrajectories}`);

  return res.status(200).json({
    ok: true,
    context: result.context,
    has_positive_trajectories: result.hasPositiveTrajectories
  });
});

/**
 * GET /metadata -> GET /api/v1/reinforcement/metadata
 *
 * Returns metadata about trajectory types, thresholds, and framing rules.
 * Useful for UI display and documentation.
 */
router.get('/metadata', async (_req: Request, res: Response) => {
  console.log(`[${VTID}] GET /reinforcement/metadata`);

  return res.status(200).json({
    ok: true,
    trajectory_types: TRAJECTORY_TYPE_METADATA,
    thresholds: REINFORCEMENT_THRESHOLDS,
    framing_rules: {
      max_observation_words: FRAMING_RULES.MAX_OBSERVATION_WORDS,
      max_explanation_words: FRAMING_RULES.MAX_EXPLANATION_WORDS,
      max_focus_words: FRAMING_RULES.MAX_FOCUS_WORDS,
      tone: FRAMING_RULES.TONE,
      focus: FRAMING_RULES.FOCUS
    },
    vtid: VTID
  });
});

/**
 * GET / -> GET /api/v1/reinforcement
 *
 * Root endpoint - returns service info.
 */
router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'positive-trajectory-reinforcement-engine',
    vtid: VTID,
    version: 'v1',
    description: 'D50 Positive Trajectory Reinforcement & Momentum Engine',
    philosophy: {
      core: 'Positive-only reinforcement',
      question: 'What is going well, and how can it be sustained?',
      rules: [
        'No correction',
        'No comparison with others',
        'No gamification pressure',
        'No behavioral enforcement',
        'Focus on continuation, not escalation'
      ]
    },
    endpoints: [
      'GET  /api/v1/reinforcement/momentum - Get current momentum state',
      'GET  /api/v1/reinforcement/eligibility - Check reinforcement eligibility',
      'POST /api/v1/reinforcement/generate - Generate a reinforcement',
      'POST /api/v1/reinforcement/:id/deliver - Mark as delivered',
      'POST /api/v1/reinforcement/:id/dismiss - Dismiss a reinforcement',
      'GET  /api/v1/reinforcement/history - Get reinforcement history',
      'GET  /api/v1/reinforcement/orb-context - Get ORB context',
      'GET  /api/v1/reinforcement/metadata - Get trajectory type metadata'
    ],
    timestamp: new Date().toISOString()
  });
});

export default router;
