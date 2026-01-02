/**
 * VTID-01121: User Feedback, Correction & Trust Repair Engine
 *
 * Gateway endpoints for user corrections, trust scores, and behavior constraints.
 *
 * Endpoints:
 * - POST /api/v1/feedback/correction       - Record a user correction
 * - GET  /api/v1/feedback/history          - Get correction history
 * - GET  /api/v1/feedback/trust            - Get trust scores
 * - POST /api/v1/feedback/trust/repair     - Repair trust after corrective action
 * - GET  /api/v1/feedback/constraints      - Get behavior constraints
 * - POST /api/v1/feedback/constraints/check - Check if behavior is constrained
 * - GET  /api/v1/feedback/health           - Health check
 *
 * Dependencies:
 * - VTID-01104 (Memory Core v1)
 * - VTID-01094 (Match Feedback Loop - patterns)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  FEEDBACK_TYPES,
  AFFECTED_COMPONENTS,
  CORRECTION_SOURCES,
  CONSTRAINT_TYPES,
  TRUST_COMPONENTS,
  TRUST_DELTAS,
  getTrustLevel,
  shouldRestrictBehavior,
  needsImmediateAttention,
  FeedbackType,
  AffectedComponent,
  TrustScore,
} from '../types/feedback-correction';

const router = Router();

// =============================================================================
// VTID-01121: Schemas
// =============================================================================

/**
 * Record correction request schema
 */
const RecordCorrectionSchema = z.object({
  feedback_type: z.enum(FEEDBACK_TYPES),
  content: z.string().min(1).max(2000),
  context: z.record(z.unknown()).optional().default({}),
  affected_component: z.enum(AFFECTED_COMPONENTS).optional().default('general'),
  affected_item_id: z.string().uuid().optional(),
  affected_item_type: z.string().optional(),
  session_id: z.string().optional(),
  source: z.enum(CORRECTION_SOURCES).optional().default('orb'),
});

/**
 * Correction history query schema
 */
const CorrectionHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  feedback_type: z.enum(FEEDBACK_TYPES).optional(),
});

/**
 * Trust repair request schema
 */
const RepairTrustSchema = z.object({
  component: z.enum(TRUST_COMPONENTS),
  correction_id: z.string().uuid().optional(),
  repair_action: z.string().min(1).max(500),
});

/**
 * Check constraint request schema
 */
const CheckConstraintSchema = z.object({
  constraint_type: z.enum(CONSTRAINT_TYPES),
  constraint_key: z.string().min(1).max(200),
});

/**
 * Get constraints query schema
 */
const GetConstraintsQuerySchema = z.object({
  constraint_type: z.enum(CONSTRAINT_TYPES).optional(),
});

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
 * Emit OASIS event for feedback/correction actions
 */
async function emitFeedbackEvent(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01121',
    type: type as any,
    source: 'feedback-correction-gateway',
    status,
    message,
    payload,
  }).catch(err => console.warn(`[VTID-01121] Failed to emit ${type}:`, err.message));
}

/**
 * Check Supabase configuration
 */
function checkSupabaseConfig(): { ok: boolean; error?: string } {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return { ok: false, error: 'GATEWAY_MISCONFIGURED' };
  }
  return { ok: true };
}

// =============================================================================
// VTID-01121: Routes
// =============================================================================

/**
 * POST /correction -> POST /api/v1/feedback/correction
 *
 * Record a user correction with deterministic processing.
 *
 * Request body:
 * - feedback_type: FeedbackType
 * - content: string (the correction itself)
 * - context: object (optional conversation context)
 * - affected_component: AffectedComponent (default 'general')
 * - affected_item_id: UUID (optional, specific item being corrected)
 * - affected_item_type: string (optional, e.g., 'memory_item')
 * - session_id: string (optional)
 * - source: 'orb' | 'app' | 'api' | 'system' (default 'orb')
 *
 * Response:
 * - ok: boolean
 * - correction_id: UUID
 * - feedback_type: string
 * - affected_component: string
 * - trust_impact: number
 * - propagations: array of propagation records
 * - safety_flagged: boolean
 */
router.post('/correction', async (req: Request, res: Response) => {
  console.log('[VTID-01121] POST /feedback/correction');

  // 1. Auth check
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Bearer token required',
    });
  }

  // 2. Check Supabase config
  const configCheck = checkSupabaseConfig();
  if (!configCheck.ok) {
    return res.status(503).json({
      ok: false,
      error: configCheck.error,
      message: 'Supabase credentials not configured',
    });
  }

  // 3. Validate request body
  const validation = RecordCorrectionSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01121] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
  }

  const {
    feedback_type,
    content,
    context,
    affected_component,
    affected_item_id,
    affected_item_type,
    session_id,
    source,
  } = validation.data;

  try {
    // 4. Create user-context Supabase client
    const supabase = createUserSupabaseClient(token);

    // 5. Call record_user_correction RPC
    const { data, error } = await supabase.rpc('record_user_correction', {
      p_payload: {
        feedback_type,
        content,
        context,
        affected_component,
        affected_item_id: affected_item_id || null,
        affected_item_type: affected_item_type || null,
        session_id: session_id || null,
        source,
      },
    });

    if (error) {
      // Check if RPC doesn't exist (migration not applied)
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01121] record_user_correction RPC not found (migration not applied)');
        return res.status(503).json({
          ok: false,
          error: 'RPC_NOT_AVAILABLE',
          message: 'Feedback correction RPC not available (VTID-01121 migration pending)',
        });
      }

      console.error('[VTID-01121] record_user_correction RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: 'RPC_ERROR',
        message: error.message,
      });
    }

    // 6. Check RPC response
    if (!data || data.ok === false) {
      const errorCode = data?.error || 'UNKNOWN_ERROR';
      console.warn(`[VTID-01121] Correction failed: ${errorCode}`);

      const statusMap: Record<string, number> = {
        TENANT_NOT_FOUND: 403,
        UNAUTHENTICATED: 401,
        INVALID_FEEDBACK_TYPE: 400,
        CONTENT_REQUIRED: 400,
      };

      return res.status(statusMap[errorCode] || 400).json({
        ok: false,
        error: errorCode,
        message: data?.message || 'Correction recording failed',
      });
    }

    // 7. Emit OASIS events
    // Event 1: Correction recorded
    await emitFeedbackEvent(
      'feedback.correction.recorded',
      'success',
      `User correction recorded: ${feedback_type}`,
      {
        correction_id: data.correction_id,
        feedback_type,
        affected_component,
        trust_impact: data.trust_impact,
        safety_flagged: data.safety_flagged,
      }
    );

    // Event 2: Trust updated
    await emitFeedbackEvent(
      'feedback.trust.updated',
      data.trust_impact < -10 ? 'warning' : 'info',
      `Trust score updated for ${affected_component}`,
      {
        correction_id: data.correction_id,
        component: affected_component,
        trust_delta: data.trust_impact,
        expected_trust_delta: TRUST_DELTAS[feedback_type as FeedbackType],
      }
    );

    // Event 3: Safety flagged (if applicable)
    if (data.safety_flagged) {
      await emitFeedbackEvent(
        'feedback.safety.flagged',
        'warning',
        `Safety-sensitive correction flagged`,
        {
          correction_id: data.correction_id,
          feedback_type,
          affected_component,
        }
      );
    }

    console.log(`[VTID-01121] Correction recorded: ${data.correction_id} (${feedback_type})`);

    // 8. Return success
    return res.status(200).json({
      ok: true,
      correction_id: data.correction_id,
      feedback_type: data.feedback_type,
      affected_component: data.affected_component,
      trust_impact: data.trust_impact,
      propagations: data.propagations || [],
      safety_flagged: data.safety_flagged,
    });

  } catch (err: any) {
    console.error('[VTID-01121] Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message,
    });
  }
});

/**
 * GET /history -> GET /api/v1/feedback/history
 *
 * Get user's correction history for auditability.
 *
 * Query params:
 * - limit: number 1-200 (default 50)
 * - offset: number (default 0)
 * - feedback_type: FeedbackType (optional filter)
 */
router.get('/history', async (req: Request, res: Response) => {
  console.log('[VTID-01121] GET /feedback/history');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const configCheck = checkSupabaseConfig();
  if (!configCheck.ok) {
    return res.status(503).json({ ok: false, error: configCheck.error });
  }

  // Validate query params
  const queryValidation = CorrectionHistoryQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_QUERY_PARAMS',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
  }

  const { limit, offset, feedback_type } = queryValidation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('get_correction_history', {
      p_limit: limit,
      p_offset: offset,
      p_feedback_type: feedback_type || null,
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'RPC_NOT_AVAILABLE',
          message: 'Correction history RPC not available (VTID-01121 migration pending)',
        });
      }
      console.error('[VTID-01121] get_correction_history error:', error.message);
      return res.status(502).json({ ok: false, error: 'RPC_ERROR', message: error.message });
    }

    if (!data || data.ok === false) {
      return res.status(400).json({ ok: false, error: data?.error || 'UNKNOWN_ERROR' });
    }

    console.log(`[VTID-01121] Correction history fetched: ${data.count} entries`);

    return res.status(200).json({
      ok: true,
      corrections: data.corrections || [],
      count: data.count,
      total: data.total,
      limit: data.limit,
      offset: data.offset,
    });

  } catch (err: any) {
    console.error('[VTID-01121] Unexpected error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * GET /trust -> GET /api/v1/feedback/trust
 *
 * Get current trust scores for all components.
 */
router.get('/trust', async (req: Request, res: Response) => {
  console.log('[VTID-01121] GET /feedback/trust');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const configCheck = checkSupabaseConfig();
  if (!configCheck.ok) {
    return res.status(503).json({ ok: false, error: configCheck.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('get_trust_scores');

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'RPC_NOT_AVAILABLE',
          message: 'Trust scores RPC not available (VTID-01121 migration pending)',
        });
      }
      console.error('[VTID-01121] get_trust_scores error:', error.message);
      return res.status(502).json({ ok: false, error: 'RPC_ERROR', message: error.message });
    }

    if (!data || data.ok === false) {
      return res.status(400).json({ ok: false, error: data?.error || 'UNKNOWN_ERROR' });
    }

    // Enhance with trust levels and flags
    const enhancedScores = (data.scores || []).map((score: TrustScore) => ({
      ...score,
      trust_level: getTrustLevel(score.score),
      requires_restriction: shouldRestrictBehavior(score),
      needs_attention: needsImmediateAttention(score),
    }));

    console.log(`[VTID-01121] Trust scores fetched: ${enhancedScores.length} components`);

    return res.status(200).json({
      ok: true,
      scores: enhancedScores,
      count: data.count,
    });

  } catch (err: any) {
    console.error('[VTID-01121] Unexpected error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * POST /trust/repair -> POST /api/v1/feedback/trust/repair
 *
 * Repair trust after ORB acknowledges mistake and takes corrective action.
 *
 * Request body:
 * - component: TrustComponent
 * - correction_id: UUID (optional, links to original correction)
 * - repair_action: string (what corrective action was taken)
 */
router.post('/trust/repair', async (req: Request, res: Response) => {
  console.log('[VTID-01121] POST /feedback/trust/repair');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const configCheck = checkSupabaseConfig();
  if (!configCheck.ok) {
    return res.status(503).json({ ok: false, error: configCheck.error });
  }

  const validation = RepairTrustSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
  }

  const { component, correction_id, repair_action } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('repair_trust', {
      p_payload: {
        component,
        correction_id: correction_id || null,
        repair_action,
      },
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'RPC_NOT_AVAILABLE',
          message: 'Trust repair RPC not available (VTID-01121 migration pending)',
        });
      }
      console.error('[VTID-01121] repair_trust error:', error.message);
      return res.status(502).json({ ok: false, error: 'RPC_ERROR', message: error.message });
    }

    if (!data || data.ok === false) {
      const errorCode = data?.error || 'UNKNOWN_ERROR';
      const statusMap: Record<string, number> = {
        UNAUTHENTICATED: 401,
        REPAIR_ACTION_REQUIRED: 400,
        NO_TRUST_SCORE_FOR_COMPONENT: 404,
      };
      return res.status(statusMap[errorCode] || 400).json({
        ok: false,
        error: errorCode,
      });
    }

    // Emit trust repair event
    await emitFeedbackEvent(
      'feedback.trust.repaired',
      'success',
      `Trust repaired for ${component}`,
      {
        component,
        old_score: data.old_score,
        new_score: data.new_score,
        recovery_delta: data.recovery_delta,
        repair_action,
        correction_id,
      }
    );

    console.log(`[VTID-01121] Trust repaired for ${component}: ${data.old_score} -> ${data.new_score}`);

    return res.status(200).json({
      ok: true,
      component: data.component,
      old_score: data.old_score,
      new_score: data.new_score,
      recovery_delta: data.recovery_delta,
      repair_action: data.repair_action,
      new_trust_level: getTrustLevel(data.new_score),
    });

  } catch (err: any) {
    console.error('[VTID-01121] Unexpected error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * GET /constraints -> GET /api/v1/feedback/constraints
 *
 * Get active behavior constraints.
 *
 * Query params:
 * - constraint_type: ConstraintType (optional filter)
 */
router.get('/constraints', async (req: Request, res: Response) => {
  console.log('[VTID-01121] GET /feedback/constraints');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const configCheck = checkSupabaseConfig();
  if (!configCheck.ok) {
    return res.status(503).json({ ok: false, error: configCheck.error });
  }

  const queryValidation = GetConstraintsQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_QUERY_PARAMS',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
  }

  const { constraint_type } = queryValidation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('get_behavior_constraints', {
      p_constraint_type: constraint_type || null,
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'RPC_NOT_AVAILABLE',
          message: 'Behavior constraints RPC not available (VTID-01121 migration pending)',
        });
      }
      console.error('[VTID-01121] get_behavior_constraints error:', error.message);
      return res.status(502).json({ ok: false, error: 'RPC_ERROR', message: error.message });
    }

    if (!data || data.ok === false) {
      return res.status(400).json({ ok: false, error: data?.error || 'UNKNOWN_ERROR' });
    }

    console.log(`[VTID-01121] Behavior constraints fetched: ${data.count} active`);

    return res.status(200).json({
      ok: true,
      constraints: data.constraints || [],
      count: data.count,
    });

  } catch (err: any) {
    console.error('[VTID-01121] Unexpected error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * POST /constraints/check -> POST /api/v1/feedback/constraints/check
 *
 * Check if a specific behavior is constrained (for ORB pre-action check).
 *
 * Request body:
 * - constraint_type: ConstraintType
 * - constraint_key: string (behavior identifier)
 */
router.post('/constraints/check', async (req: Request, res: Response) => {
  console.log('[VTID-01121] POST /feedback/constraints/check');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const configCheck = checkSupabaseConfig();
  if (!configCheck.ok) {
    return res.status(503).json({ ok: false, error: configCheck.error });
  }

  const validation = CheckConstraintSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
  }

  const { constraint_type, constraint_key } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('check_behavior_constraint', {
      p_constraint_type: constraint_type,
      p_constraint_key: constraint_key,
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'RPC_NOT_AVAILABLE',
          message: 'Constraint check RPC not available (VTID-01121 migration pending)',
        });
      }
      console.error('[VTID-01121] check_behavior_constraint error:', error.message);
      return res.status(502).json({ ok: false, error: 'RPC_ERROR', message: error.message });
    }

    if (!data || data.ok === false) {
      return res.status(400).json({ ok: false, error: data?.error || 'UNKNOWN_ERROR' });
    }

    // Log if constrained (for observability)
    if (data.is_constrained) {
      console.log(`[VTID-01121] Behavior constrained: ${constraint_type}/${constraint_key}`);
    }

    return res.status(200).json({
      ok: true,
      is_constrained: data.is_constrained,
      constraint_type: data.constraint_type,
      constraint_key: data.constraint_key,
      description: data.description,
      strength: data.strength,
      expires_at: data.expires_at,
    });

  } catch (err: any) {
    console.error('[VTID-01121] Unexpected error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * GET /health -> GET /api/v1/feedback/health
 *
 * Health check for feedback correction system.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'feedback-correction-gateway',
    version: '1.0.0',
    vtid: 'VTID-01121',
    timestamp: new Date().toISOString(),
    capabilities: {
      record_correction: hasSupabaseUrl && hasSupabaseKey,
      correction_history: hasSupabaseUrl && hasSupabaseKey,
      trust_scores: hasSupabaseUrl && hasSupabaseKey,
      trust_repair: hasSupabaseUrl && hasSupabaseKey,
      behavior_constraints: hasSupabaseUrl && hasSupabaseKey,
      constraint_check: hasSupabaseUrl && hasSupabaseKey,
    },
    feedback_types: FEEDBACK_TYPES,
    affected_components: AFFECTED_COMPONENTS,
    trust_components: TRUST_COMPONENTS,
    constraint_types: CONSTRAINT_TYPES,
    deterministic_rules: {
      trust_deltas: TRUST_DELTAS,
      recovery_delta: 5,
      max_recovered_trust: 80,
      min_trust: 10,
      default_trust: 80,
    },
    processing_rules: {
      explicit_correction: 'Identifies affected memory/rule/state, applies confidence downgrade',
      preference_clarification: 'Updates preference, records permanently',
      boundary_enforcement: 'Creates hard constraint, blocks behavior',
      tone_adjustment: 'Adjusts tone preferences, records correction',
      suggestion_rejection: 'Blocks specific suggestion type',
      autonomy_refusal: 'Reduces autonomy scope, highest trust impact',
    },
    dependencies: {
      'VTID-01104': 'memory_items',
      'VTID-01094': 'match_feedback (patterns)',
      'VTID-01121': 'user_corrections + trust_scores + behavior_constraints',
    },
  });
});

export default router;
