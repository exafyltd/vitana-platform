/**
 * VTID-01121: User Feedback, Correction & Trust Repair Engine
 *
 * Gateway endpoints for the feedback correction and trust repair system.
 *
 * Endpoints:
 * - POST /api/v1/feedback/correct         - Submit a correction/feedback
 * - GET  /api/v1/feedback/corrections     - Get correction history
 * - GET  /api/v1/feedback/trust           - Get current trust score
 * - GET  /api/v1/feedback/constraints     - Get active behavior constraints
 * - POST /api/v1/feedback/constraints     - Add a behavior constraint
 * - DELETE /api/v1/feedback/constraints/:id - Remove a behavior constraint
 * - POST /api/v1/feedback/repair          - Record a trust repair action
 * - GET  /api/v1/feedback/health          - Health check
 *
 * Hard Constraints:
 * - Feedback may NOT be ignored
 * - Corrections override inference
 * - Rejected behavior may NOT resurface automatically
 * - Feedback propagates to all downstream layers
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  SubmitCorrectionRequestSchema,
  GetCorrectionsQuerySchema,
  AddConstraintRequestSchema,
  FEEDBACK_TYPES,
  CORRECTION_TARGETS,
  CONSTRAINT_TYPES,
  REPAIR_ACTIONS,
  FEEDBACK_PROCESSING_RULES,
  TRUST_REPAIR_RULES,
  RepairAction
} from '../types/feedback-trust';
import {
  recordFeedbackCorrection,
  getOrCreateUserTrustScore,
  updateUserTrustScore,
  recordTrustRepair,
  addBehaviorConstraint,
  getActiveConstraints,
  deactivateConstraint,
  getCorrectionHistory,
  CORRECTION_ACKNOWLEDGMENTS,
  REPAIR_MESSAGES
} from '../services/feedback-trust-service';

const router = Router();

const VTID = 'VTID-01121';

// =============================================================================
// VTID-01121: Helpers
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
 * Get user context (tenant_id, user_id) via Supabase RPC.
 */
async function getUserContext(token: string): Promise<{
  ok: boolean;
  tenantId?: string;
  userId?: string;
  error?: string;
}> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { ok: false, error: 'Gateway misconfigured' };
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');

    if (error) {
      console.warn(`[${VTID}] me_context RPC error:`, error.message);
      return { ok: false, error: error.message };
    }

    if (!data || data.ok === false) {
      return { ok: false, error: data?.error || 'User context not found' };
    }

    return {
      ok: true,
      tenantId: data.tenant_id,
      userId: data.user_id
    };
  } catch (err: any) {
    console.error(`[${VTID}] getUserContext error:`, err.message);
    return { ok: false, error: err.message };
  }
}

// =============================================================================
// VTID-01121: Routes
// =============================================================================

/**
 * POST /correct - Submit a correction/feedback
 *
 * Submit user feedback/correction. This is authoritative input that:
 * - Records the correction permanently
 * - Updates trust score
 * - Creates behavior constraints if needed
 * - Propagates to downstream layers
 */
router.post('/correct', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /feedback/correct`);

  // 1. Auth check
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Bearer token required'
    });
  }

  // 2. Validate request body
  const validation = SubmitCorrectionRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const request = validation.data;

  // 3. Get user context
  const userContext = await getUserContext(token);
  if (!userContext.ok || !userContext.tenantId || !userContext.userId) {
    return res.status(403).json({
      ok: false,
      error: 'USER_CONTEXT_ERROR',
      message: userContext.error || 'Could not get user context'
    });
  }

  const { tenantId, userId } = userContext;

  try {
    // 4. Get or create user trust score
    const trustResult = await getOrCreateUserTrustScore(tenantId, userId);
    if (!trustResult.ok || !trustResult.trustScore) {
      return res.status(500).json({
        ok: false,
        error: 'TRUST_SCORE_ERROR',
        message: trustResult.error || 'Could not get trust score'
      });
    }

    const currentTrustScore = trustResult.trustScore.trust_score;

    // 5. Record the correction (deterministic processing)
    const result = await recordFeedbackCorrection(
      tenantId,
      userId,
      request,
      currentTrustScore
    );

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: 'CORRECTION_FAILED',
        message: result.error
      });
    }

    // 6. Update trust score
    await updateUserTrustScore(userId, {
      trust_score: result.newTrustScore,
      total_corrections: trustResult.trustScore.total_corrections + 1,
      last_correction_at: new Date().toISOString()
    });

    // 7. Add behavior constraint if required
    if (result.constraintAdded && result.correction) {
      const constraintType = result.constraintAdded as any;
      await addBehaviorConstraint(
        tenantId,
        userId,
        result.correction.id,
        constraintType,
        request.correction_target,
        { reason: request.correction_detail, feedback_type: request.feedback_type }
      );
    }

    // 8. Generate acknowledgment
    const acknowledgment = CORRECTION_ACKNOWLEDGMENTS[request.feedback_type];

    console.log(`[${VTID}] Correction recorded: ${result.correction?.id} (${request.feedback_type})`);

    return res.status(200).json({
      ok: true,
      correction_id: result.correction?.id,
      feedback_type: request.feedback_type,
      correction_target: request.correction_target,
      changes_applied: result.correction?.changes_applied,
      trust_impact: result.trustImpact,
      new_trust_score: result.newTrustScore,
      constraint_added: result.constraintAdded,
      safety_escalated: result.safetyEscalated,
      acknowledgment,
      message: 'Correction recorded and propagated to all layers'
    });
  } catch (err: any) {
    console.error(`[${VTID}] Unexpected error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

/**
 * GET /corrections - Get correction history
 *
 * Returns the user's feedback correction history.
 * Used for explainability and governance review.
 */
router.get('/corrections', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /feedback/corrections`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate query params
  const queryValidation = GetCorrectionsQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_QUERY_PARAMS',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { feedback_type, correction_target, from, to, limit } = queryValidation.data;

  const userContext = await getUserContext(token);
  if (!userContext.ok || !userContext.userId) {
    return res.status(403).json({
      ok: false,
      error: 'USER_CONTEXT_ERROR'
    });
  }

  try {
    const result = await getCorrectionHistory(userContext.userId, {
      feedbackType: feedback_type,
      correctionTarget: correction_target,
      from,
      to,
      limit
    });

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: 'FETCH_FAILED',
        message: result.error
      });
    }

    return res.status(200).json({
      ok: true,
      corrections: result.corrections,
      count: result.corrections?.length || 0,
      query: queryValidation.data
    });
  } catch (err: any) {
    console.error(`[${VTID}] Unexpected error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /trust - Get current trust score
 *
 * Returns the user's current trust score and trend.
 */
router.get('/trust', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /feedback/trust`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const userContext = await getUserContext(token);
  if (!userContext.ok || !userContext.tenantId || !userContext.userId) {
    return res.status(403).json({
      ok: false,
      error: 'USER_CONTEXT_ERROR'
    });
  }

  try {
    const result = await getOrCreateUserTrustScore(userContext.tenantId, userContext.userId);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: 'FETCH_FAILED',
        message: result.error
      });
    }

    const constraintsResult = await getActiveConstraints(userContext.userId);

    return res.status(200).json({
      ok: true,
      trust_score: result.trustScore,
      active_constraints_count: constraintsResult.constraints?.length || 0
    });
  } catch (err: any) {
    console.error(`[${VTID}] Unexpected error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /constraints - Get active behavior constraints
 *
 * Returns all active constraints that prevent certain behaviors.
 */
router.get('/constraints', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /feedback/constraints`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const userContext = await getUserContext(token);
  if (!userContext.ok || !userContext.userId) {
    return res.status(403).json({
      ok: false,
      error: 'USER_CONTEXT_ERROR'
    });
  }

  try {
    const result = await getActiveConstraints(userContext.userId);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: 'FETCH_FAILED',
        message: result.error
      });
    }

    return res.status(200).json({
      ok: true,
      constraints: result.constraints,
      count: result.constraints?.length || 0
    });
  } catch (err: any) {
    console.error(`[${VTID}] Unexpected error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /constraints - Add a behavior constraint
 *
 * Manually add a behavior constraint (without going through correction flow).
 */
router.post('/constraints', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /feedback/constraints`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const validation = AddConstraintRequestSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const userContext = await getUserContext(token);
  if (!userContext.ok || !userContext.tenantId || !userContext.userId) {
    return res.status(403).json({
      ok: false,
      error: 'USER_CONTEXT_ERROR'
    });
  }

  try {
    const result = await addBehaviorConstraint(
      userContext.tenantId,
      userContext.userId,
      null, // No associated correction
      validation.data.constraint_type,
      validation.data.constraint_key,
      validation.data.constraint_value || {},
      validation.data.expires_at
    );

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: 'CONSTRAINT_FAILED',
        message: result.error
      });
    }

    return res.status(201).json({
      ok: true,
      constraint_id: result.constraint?.id,
      constraint_type: result.constraint?.constraint_type,
      constraint_key: result.constraint?.constraint_key
    });
  } catch (err: any) {
    console.error(`[${VTID}] Unexpected error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR'
    });
  }
});

/**
 * DELETE /constraints/:id - Remove a behavior constraint
 *
 * Deactivate a behavior constraint. The constraint remains in history
 * but no longer blocks behavior.
 */
router.delete('/constraints/:id', async (req: Request, res: Response) => {
  const constraintId = req.params.id;
  console.log(`[${VTID}] DELETE /feedback/constraints/${constraintId}`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(constraintId)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_CONSTRAINT_ID',
      message: 'Constraint ID must be a valid UUID'
    });
  }

  const reason = req.body?.reason || 'User requested removal';

  const userContext = await getUserContext(token);
  if (!userContext.ok || !userContext.userId) {
    return res.status(403).json({
      ok: false,
      error: 'USER_CONTEXT_ERROR'
    });
  }

  try {
    const result = await deactivateConstraint(constraintId, userContext.userId, reason);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: 'DEACTIVATE_FAILED',
        message: result.error
      });
    }

    return res.status(200).json({
      ok: true,
      constraint_id: constraintId,
      deactivated: true
    });
  } catch (err: any) {
    console.error(`[${VTID}] Unexpected error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR'
    });
  }
});

/**
 * POST /repair - Record a trust repair action
 *
 * Record when ORB has successfully repaired trust through:
 * - Acknowledgment
 * - Behavior change
 * - Consistent correct behavior
 */
router.post('/repair', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /feedback/repair`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  const { repair_action, feedback_correction_id, details } = req.body;

  // Validate repair action
  if (!repair_action || !REPAIR_ACTIONS.includes(repair_action)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REPAIR_ACTION',
      message: `repair_action must be one of: ${REPAIR_ACTIONS.join(', ')}`
    });
  }

  const userContext = await getUserContext(token);
  if (!userContext.ok || !userContext.tenantId || !userContext.userId) {
    return res.status(403).json({
      ok: false,
      error: 'USER_CONTEXT_ERROR'
    });
  }

  try {
    // Get current trust score
    const trustResult = await getOrCreateUserTrustScore(userContext.tenantId, userContext.userId);
    if (!trustResult.ok || !trustResult.trustScore) {
      return res.status(500).json({
        ok: false,
        error: 'TRUST_SCORE_ERROR'
      });
    }

    // Record repair action
    const result = await recordTrustRepair(
      userContext.tenantId,
      userContext.userId,
      feedback_correction_id || null,
      repair_action as RepairAction,
      trustResult.trustScore.trust_score,
      details || {}
    );

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: 'REPAIR_FAILED',
        message: result.error
      });
    }

    // Update trust score
    await updateUserTrustScore(userContext.userId, {
      trust_score: result.newTrustScore,
      total_repairs: trustResult.trustScore.total_repairs + 1,
      last_repair_at: new Date().toISOString()
    });

    const repairMessage = REPAIR_MESSAGES[repair_action as RepairAction];

    return res.status(200).json({
      ok: true,
      repair_id: result.repairEntry?.id,
      repair_action,
      trust_before: result.repairEntry?.trust_score_before,
      trust_after: result.repairEntry?.trust_score_after,
      trust_delta: result.repairEntry?.trust_delta,
      message: repairMessage
    });
  } catch (err: any) {
    console.error(`[${VTID}] Unexpected error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /health - Health check
 *
 * Returns health status and system information.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;
  const hasServiceRole = !!process.env.SUPABASE_SERVICE_ROLE;

  const status = hasSupabaseUrl && hasSupabaseKey && hasServiceRole ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'feedback-trust-engine',
    version: '1.0.0',
    vtid: VTID,
    timestamp: new Date().toISOString(),
    capabilities: {
      corrections: hasSupabaseUrl && hasServiceRole,
      trust_scores: hasSupabaseUrl && hasServiceRole,
      constraints: hasSupabaseUrl && hasServiceRole,
      repair_actions: hasSupabaseUrl && hasServiceRole
    },
    hard_constraints: {
      feedback_ignored: false,
      corrections_override_inference: true,
      rejected_behavior_resurfaces: false,
      feedback_propagates_downstream: true
    },
    feedback_types: FEEDBACK_TYPES,
    correction_targets: CORRECTION_TARGETS,
    constraint_types: CONSTRAINT_TYPES,
    repair_actions: REPAIR_ACTIONS,
    processing_rules: FEEDBACK_PROCESSING_RULES,
    trust_repair_rules: TRUST_REPAIR_RULES
  });
});

export default router;
