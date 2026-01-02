/**
 * VTID-01133: Taste, Aesthetic & Lifestyle Alignment Routes (D39)
 *
 * REST API endpoints for the Taste Alignment Engine.
 *
 * Endpoints:
 * - GET    /api/v1/taste-alignment              - Get service info
 * - GET    /api/v1/taste-alignment/bundle       - Get complete alignment bundle
 * - GET    /api/v1/taste-alignment/taste        - Get taste profile
 * - POST   /api/v1/taste-alignment/taste        - Set taste profile
 * - GET    /api/v1/taste-alignment/lifestyle    - Get lifestyle profile
 * - POST   /api/v1/taste-alignment/lifestyle    - Set lifestyle profile
 * - POST   /api/v1/taste-alignment/score        - Score actions for alignment
 * - POST   /api/v1/taste-alignment/reaction     - Record user reaction
 * - GET    /api/v1/taste-alignment/dimensions   - Get dimension metadata
 * - GET    /api/v1/taste-alignment/audit        - Get audit history
 * - GET    /api/v1/taste-alignment/health       - Health check
 *
 * All endpoints require authentication.
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  VTID,
  emitTasteAlignmentEvent,
  scoreActions,
  runTasteInferenceRules,
  buildAlignmentBundle,
  DEFAULT_TASTE_PROFILE,
  DEFAULT_LIFESTYLE_PROFILE
} from '../services/d39-taste-alignment-service';
import {
  SetTasteProfileRequestSchema,
  SetLifestyleProfileRequestSchema,
  ScoreActionsRequestSchema,
  RecordReactionRequestSchema,
  TasteProfile,
  LifestyleProfile,
  TASTE_DIMENSION_METADATA,
  LIFESTYLE_DIMENSION_METADATA
} from '../types/taste-alignment';

const router = Router();

// =============================================================================
// VTID-01133: Helpers
// =============================================================================

/**
 * Extract Bearer token from Authorization header
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Get user context from me_context RPC
 */
async function getUserContext(token: string): Promise<{
  ok: boolean;
  tenant_id: string | null;
  user_id: string | null;
  error?: string;
}> {
  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');

    if (error) {
      return { ok: false, tenant_id: null, user_id: null, error: error.message };
    }

    return {
      ok: true,
      tenant_id: data?.tenant_id || null,
      user_id: data?.user_id || data?.id || null
    };
  } catch (err: any) {
    return { ok: false, tenant_id: null, user_id: null, error: err.message };
  }
}

// =============================================================================
// VTID-01133: Routes
// =============================================================================

/**
 * GET / - Service info
 */
router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'taste-alignment',
    vtid: VTID,
    version: 'v1',
    layer: 'D39',
    description: 'Deep Context Intelligence - Taste, Aesthetic & Lifestyle Alignment Engine',
    purpose: 'Align recommendations with user taste, aesthetic preferences, and lifestyle identity',
    endpoints: [
      'GET  /bundle       - Get complete alignment bundle',
      'GET  /taste        - Get taste profile',
      'POST /taste        - Set taste profile',
      'GET  /lifestyle    - Get lifestyle profile',
      'POST /lifestyle    - Set lifestyle profile',
      'POST /score        - Score actions for alignment',
      'POST /reaction     - Record user reaction',
      'GET  /dimensions   - Get dimension metadata',
      'GET  /audit        - Get audit history',
      'GET  /health       - Health check'
    ],
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /health - Health check
 */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    status: 'healthy',
    vtid: VTID,
    layer: 'D39',
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /dimensions - Get dimension metadata
 */
router.get('/dimensions', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    taste_dimensions: TASTE_DIMENSION_METADATA,
    lifestyle_dimensions: LIFESTYLE_DIMENSION_METADATA
  });
});

/**
 * GET /bundle - Get complete alignment bundle
 */
router.get('/bundle', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /taste-alignment/bundle`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    console.error(`[${VTID}] GET /bundle - Context error:`, ctx.error);
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('taste_alignment_bundle_get');

    if (error) {
      console.error(`[${VTID}] taste_alignment_bundle_get error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitTasteAlignmentEvent(
      'taste.bundle.computed',
      'success',
      `Alignment bundle retrieved (confidence: ${data.bundle?.combined_confidence}%)`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'taste.bundle.computed',
        target_type: 'bundle',
        metadata: {
          combined_confidence: data.bundle?.combined_confidence,
          profile_completeness: data.bundle?.profile_completeness,
          sparse_data: data.bundle?.sparse_data
        }
      }
    );

    console.log(`[${VTID}] Bundle retrieved: confidence=${data.bundle?.combined_confidence}%, sparse=${data.bundle?.sparse_data}`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] GET /bundle error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /taste - Get taste profile
 */
router.get('/taste', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /taste-alignment/taste`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('taste_profile_get');

    if (error) {
      console.error(`[${VTID}] taste_profile_get error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] GET /taste error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /taste - Set taste profile
 */
router.post('/taste', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /taste-alignment/taste`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = SetTasteProfileRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { simplicity_preference, premium_orientation, aesthetic_style, tone_affinity } = parseResult.data;

  // Ensure at least one field is provided
  if (!simplicity_preference && !premium_orientation && !aesthetic_style && !tone_affinity) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'At least one taste dimension must be provided'
    });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('taste_profile_set', {
      p_simplicity_preference: simplicity_preference ?? null,
      p_premium_orientation: premium_orientation ?? null,
      p_aesthetic_style: aesthetic_style ?? null,
      p_tone_affinity: tone_affinity ?? null
    });

    if (error) {
      console.error(`[${VTID}] taste_profile_set error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitTasteAlignmentEvent(
      'taste.profile.updated',
      'success',
      `Taste profile updated: ${data.updated_fields?.join(', ')}`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'taste.profile.updated',
        target_type: 'taste_profile',
        target_id: data.profile_id,
        metadata: { updated_fields: data.updated_fields }
      }
    );

    console.log(`[${VTID}] Taste profile updated: ${data.updated_fields?.join(', ')}`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] POST /taste error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /lifestyle - Get lifestyle profile
 */
router.get('/lifestyle', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /taste-alignment/lifestyle`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('lifestyle_profile_get');

    if (error) {
      console.error(`[${VTID}] lifestyle_profile_get error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] GET /lifestyle error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /lifestyle - Set lifestyle profile
 */
router.post('/lifestyle', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /taste-alignment/lifestyle`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = SetLifestyleProfileRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const {
    routine_style, social_orientation, convenience_bias,
    experience_type, novelty_tolerance
  } = parseResult.data;

  // Ensure at least one field is provided
  if (!routine_style && !social_orientation && !convenience_bias &&
      !experience_type && !novelty_tolerance) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'At least one lifestyle dimension must be provided'
    });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('lifestyle_profile_set', {
      p_routine_style: routine_style ?? null,
      p_social_orientation: social_orientation ?? null,
      p_convenience_bias: convenience_bias ?? null,
      p_experience_type: experience_type ?? null,
      p_novelty_tolerance: novelty_tolerance ?? null
    });

    if (error) {
      console.error(`[${VTID}] lifestyle_profile_set error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitTasteAlignmentEvent(
      'lifestyle.profile.updated',
      'success',
      `Lifestyle profile updated: ${data.updated_fields?.join(', ')}`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'lifestyle.profile.updated',
        target_type: 'lifestyle_profile',
        target_id: data.profile_id,
        metadata: { updated_fields: data.updated_fields }
      }
    );

    console.log(`[${VTID}] Lifestyle profile updated: ${data.updated_fields?.join(', ')}`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] POST /lifestyle error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /score - Score actions for alignment
 */
router.post('/score', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /taste-alignment/score`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = ScoreActionsRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { actions, include_breakdown, min_alignment_threshold, exclude_low_alignment } = parseResult.data;

  if (actions.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'At least one action must be provided'
    });
  }

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    // Get user's alignment bundle
    const supabase = createUserSupabaseClient(token);
    const { data: bundleData, error: bundleError } = await supabase.rpc('taste_alignment_bundle_get');

    if (bundleError) {
      console.error(`[${VTID}] taste_alignment_bundle_get error:`, bundleError.message);
      return res.status(500).json({ ok: false, error: bundleError.message });
    }

    if (!bundleData?.ok) {
      return res.status(400).json(bundleData);
    }

    // Extract profiles from bundle
    const tasteProfile: TasteProfile = bundleData.bundle?.taste_profile ?? DEFAULT_TASTE_PROFILE;
    const lifestyleProfile: LifestyleProfile = bundleData.bundle?.lifestyle_profile ?? DEFAULT_LIFESTYLE_PROFILE;

    // Score actions
    const alignedActions = scoreActions(
      tasteProfile,
      lifestyleProfile,
      actions,
      {
        includeBreakdown: include_breakdown,
        minAlignmentThreshold: min_alignment_threshold,
        excludeLowAlignment: exclude_low_alignment
      }
    );

    // Calculate statistics
    const excludedCount = alignedActions.filter(a => a.excluded).length;
    const includedActions = alignedActions.filter(a => !a.excluded);
    const averageAlignment = includedActions.length > 0
      ? includedActions.reduce((sum, a) => sum + a.alignment_score, 0) / includedActions.length
      : 0;

    // Emit OASIS event
    await emitTasteAlignmentEvent(
      'taste.actions.scored',
      'success',
      `Scored ${actions.length} actions (${excludedCount} excluded)`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'taste.actions.scored',
        target_type: 'scoring',
        metadata: {
          action_count: actions.length,
          excluded_count: excludedCount,
          average_alignment: Math.round(averageAlignment * 1000) / 1000
        }
      }
    );

    console.log(`[${VTID}] Scored ${actions.length} actions: avg=${Math.round(averageAlignment * 100)}%, excluded=${excludedCount}`);

    return res.status(200).json({
      ok: true,
      aligned_actions: alignedActions,
      excluded_count: excludedCount,
      average_alignment: Math.round(averageAlignment * 1000) / 1000,
      sparse_data: bundleData.bundle?.sparse_data ?? true,
      profile_confidence: bundleData.bundle?.combined_confidence ?? 0
    });
  } catch (err: any) {
    console.error(`[${VTID}] POST /score error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /reaction - Record user reaction for learning
 */
router.post('/reaction', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /taste-alignment/reaction`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = RecordReactionRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { action_id, action_type, reaction, context } = parseResult.data;

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('taste_reaction_record', {
      p_action_id: action_id,
      p_action_type: action_type,
      p_reaction: reaction,
      p_action_attributes: context?.attributes ?? {},
      p_alignment_score: null, // Could be passed from client if known
      p_session_id: context?.session_id ?? null,
      p_context: context ?? null
    });

    if (error) {
      console.error(`[${VTID}] taste_reaction_record error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitTasteAlignmentEvent(
      'taste.reaction.recorded',
      'success',
      `Reaction recorded: ${reaction} on ${action_type}/${action_id}`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'taste.reaction.recorded',
        target_type: 'reaction',
        target_id: data.reaction_id,
        metadata: { action_id, action_type, reaction }
      }
    );

    console.log(`[${VTID}] Reaction recorded: ${reaction} on ${action_type}/${action_id}`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] POST /reaction error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /audit - Get audit history
 */
router.get('/audit', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /taste-alignment/audit`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Parse query params
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
  const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
  const targetType = req.query.target_type as string | undefined;

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('taste_alignment_audit_get', {
      p_limit: limit,
      p_offset: offset,
      p_target_type: targetType ?? null
    });

    if (error) {
      console.error(`[${VTID}] taste_alignment_audit_get error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    console.log(`[${VTID}] Audit retrieved: ${data.audit?.length ?? 0} entries`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] GET /audit error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
