/**
 * VTID-01119: User Preference & Constraint Modeling Routes
 *
 * D27 Core Intelligence - REST API endpoints for preference and constraint management.
 *
 * Endpoints:
 * - GET    /api/v1/user-preferences              - Get service info
 * - GET    /api/v1/user-preferences/bundle       - Get complete preference bundle
 * - GET    /api/v1/user-preferences/categories   - Get available preference categories
 * - POST   /api/v1/user-preferences/preference   - Set an explicit preference
 * - DELETE /api/v1/user-preferences/preference   - Delete an explicit preference
 * - POST   /api/v1/user-preferences/constraint   - Set a constraint
 * - DELETE /api/v1/user-preferences/constraint   - Delete a constraint
 * - POST   /api/v1/user-preferences/confirm      - Confirm a preference
 * - POST   /api/v1/user-preferences/reinforce    - Reinforce an inference
 * - POST   /api/v1/user-preferences/downgrade    - Downgrade an inference
 * - GET    /api/v1/user-preferences/audit        - Get audit history
 * - POST   /api/v1/user-preferences/check        - Check if action violates constraints
 * - GET    /api/v1/user-preferences/health       - Health check
 *
 * All endpoints require authentication.
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  VTID,
  emitPreferenceEvent,
  checkConstraintViolations,
  isActionAllowed,
  buildPreferenceBundle
} from '../services/user-preference-modeling-service';
import {
  SetPreferenceRequestSchema,
  DeletePreferenceRequestSchema,
  SetConstraintRequestSchema,
  DeleteConstraintRequestSchema,
  ConfirmPreferenceRequestSchema,
  ReinforceInferenceRequestSchema,
  DowngradeInferenceRequestSchema,
  GetAuditRequestSchema,
  PREFERENCE_CATEGORY_METADATA,
  CONSTRAINT_TYPE_METADATA,
  ExplicitPreference,
  InferredPreference,
  UserConstraint
} from '../types/user-preferences';

const router = Router();

// =============================================================================
// VTID-01119: Helpers
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
// VTID-01119: Routes
// =============================================================================

/**
 * GET / - Service info
 */
router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'user-preference-modeling',
    vtid: VTID,
    version: 'v1',
    description: 'D27 Core Intelligence - User Preference & Constraint Modeling Engine',
    endpoints: [
      'GET  /bundle       - Get complete preference bundle',
      'GET  /categories   - Get available preference categories',
      'POST /preference   - Set an explicit preference',
      'DELETE /preference - Delete an explicit preference',
      'POST /constraint   - Set a constraint',
      'DELETE /constraint - Delete a constraint',
      'POST /confirm      - Confirm a preference',
      'POST /reinforce    - Reinforce an inference',
      'POST /downgrade    - Downgrade an inference',
      'GET  /audit        - Get audit history',
      'POST /check        - Check constraint violations',
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
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /categories - Get available preference categories
 */
router.get('/categories', (_req: Request, res: Response) => {
  const categories = Object.entries(PREFERENCE_CATEGORY_METADATA).map(([key, meta]) => ({
    key,
    ...meta
  }));

  const constraintTypes = Object.entries(CONSTRAINT_TYPE_METADATA).map(([key, meta]) => ({
    key,
    ...meta
  }));

  return res.status(200).json({
    ok: true,
    categories,
    constraint_types: constraintTypes
  });
});

/**
 * GET /bundle - Get complete preference bundle
 */
router.get('/bundle', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /user-preferences/bundle`);

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
    const { data, error } = await supabase.rpc('preference_bundle_get');

    if (error) {
      console.error(`[${VTID}] preference_bundle_get error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitPreferenceEvent(
      'preference.bundle.read',
      'success',
      `Preference bundle retrieved with ${data.preference_count} preferences, ${data.constraint_count} constraints`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'bundle.computed' as any,
        target_type: 'bundle',
        metadata: {
          preference_count: data.preference_count,
          inference_count: data.inference_count,
          constraint_count: data.constraint_count,
          confidence_level: data.confidence_level
        }
      }
    );

    console.log(`[${VTID}] Bundle retrieved: ${data.preference_count} prefs, ${data.inference_count} inferences, ${data.constraint_count} constraints`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] GET /bundle error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /preference - Set an explicit preference
 */
router.post('/preference', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /user-preferences/preference`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = SetPreferenceRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { category, key, value, priority, scope, scope_domain } = parseResult.data;

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('preference_set', {
      p_category: category,
      p_key: key,
      p_value: value,
      p_priority: priority,
      p_scope: scope,
      p_scope_domain: scope_domain ?? null
    });

    if (error) {
      console.error(`[${VTID}] preference_set error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitPreferenceEvent(
      'preference.set',
      'success',
      `Preference ${data.action}: ${category}/${key}`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'preference.set' as any,
        target_type: 'preference',
        target_id: data.id,
        category,
        key,
        metadata: { priority, scope, action: data.action }
      }
    );

    console.log(`[${VTID}] Preference ${data.action}: ${category}/${key} (id: ${data.id})`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] POST /preference error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /preference - Delete an explicit preference
 */
router.delete('/preference', async (req: Request, res: Response) => {
  console.log(`[${VTID}] DELETE /user-preferences/preference`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = DeletePreferenceRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { category, key, scope, scope_domain } = parseResult.data;

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('preference_delete', {
      p_category: category,
      p_key: key,
      p_scope: scope,
      p_scope_domain: scope_domain ?? null
    });

    if (error) {
      console.error(`[${VTID}] preference_delete error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitPreferenceEvent(
      'preference.deleted',
      'success',
      `Preference deleted: ${category}/${key}`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'preference.deleted' as any,
        target_type: 'preference',
        target_id: data.id,
        category,
        key
      }
    );

    console.log(`[${VTID}] Preference deleted: ${category}/${key} (id: ${data.id})`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] DELETE /preference error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /constraint - Set a constraint
 */
router.post('/constraint', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /user-preferences/constraint`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = SetConstraintRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { type, key, value, severity, reason } = parseResult.data;

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('constraint_set', {
      p_type: type,
      p_key: key,
      p_value: value,
      p_severity: severity,
      p_reason: reason ?? null
    });

    if (error) {
      console.error(`[${VTID}] constraint_set error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitPreferenceEvent(
      'constraint.set',
      'success',
      `Constraint ${data.action}: ${type}/${key}`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'constraint.set' as any,
        target_type: 'constraint',
        target_id: data.id,
        metadata: { type, key, severity, action: data.action }
      }
    );

    console.log(`[${VTID}] Constraint ${data.action}: ${type}/${key} (id: ${data.id})`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] POST /constraint error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /constraint - Delete a constraint
 */
router.delete('/constraint', async (req: Request, res: Response) => {
  console.log(`[${VTID}] DELETE /user-preferences/constraint`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = DeleteConstraintRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { type, key } = parseResult.data;

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('constraint_delete', {
      p_type: type,
      p_key: key
    });

    if (error) {
      console.error(`[${VTID}] constraint_delete error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitPreferenceEvent(
      'constraint.deleted',
      'success',
      `Constraint deleted: ${type}/${key}`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'constraint.deleted' as any,
        target_type: 'constraint',
        target_id: data.id,
        metadata: { type, key }
      }
    );

    console.log(`[${VTID}] Constraint deleted: ${type}/${key} (id: ${data.id})`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] DELETE /constraint error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /confirm - Confirm a preference
 */
router.post('/confirm', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /user-preferences/confirm`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = ConfirmPreferenceRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { preference_id } = parseResult.data;

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('preference_confirm', {
      p_preference_id: preference_id
    });

    if (error) {
      console.error(`[${VTID}] preference_confirm error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitPreferenceEvent(
      'preference.confirmed',
      'success',
      `Preference confirmed: ${preference_id}`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'preference.confirmed' as any,
        target_type: 'preference',
        target_id: preference_id
      }
    );

    console.log(`[${VTID}] Preference confirmed: ${preference_id}`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] POST /confirm error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /reinforce - Reinforce an inference
 */
router.post('/reinforce', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /user-preferences/reinforce`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = ReinforceInferenceRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { inference_id, evidence } = parseResult.data;

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('inference_reinforce', {
      p_inference_id: inference_id,
      p_evidence: evidence ?? null
    });

    if (error) {
      console.error(`[${VTID}] inference_reinforce error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    await emitPreferenceEvent(
      'inference.reinforced',
      'success',
      `Inference reinforced: ${inference_id} (${data.old_confidence} -> ${data.new_confidence})`,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'inference.reinforced' as any,
        target_type: 'inference',
        target_id: inference_id,
        confidence_delta: data.delta
      }
    );

    console.log(`[${VTID}] Inference reinforced: ${inference_id} (${data.old_confidence} -> ${data.new_confidence})`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] POST /reinforce error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /downgrade - Downgrade an inference
 */
router.post('/downgrade', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /user-preferences/downgrade`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = DowngradeInferenceRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { inference_id, reason } = parseResult.data;

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('inference_downgrade', {
      p_inference_id: inference_id,
      p_reason: reason ?? null
    });

    if (error) {
      console.error(`[${VTID}] inference_downgrade error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json(data);
    }

    // Emit OASIS event
    const eventMessage = data.deleted
      ? `Inference deleted (confidence dropped to 0): ${inference_id}`
      : `Inference downgraded: ${inference_id} (${data.old_confidence} -> ${data.new_confidence})`;

    await emitPreferenceEvent(
      'inference.downgraded',
      'success',
      eventMessage,
      {
        tenant_id: ctx.tenant_id!,
        user_id: ctx.user_id!,
        action: 'inference.downgraded' as any,
        target_type: 'inference',
        target_id: inference_id,
        confidence_delta: data.delta,
        metadata: { deleted: data.deleted, reason }
      }
    );

    console.log(`[${VTID}] ${eventMessage}`);

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] POST /downgrade error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /audit - Get audit history
 */
router.get('/audit', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /user-preferences/audit`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Parse query params
  const parseResult = GetAuditRequestSchema.safeParse({
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
    target_type: req.query.target_type
  });
  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      details: parseResult.error.issues
    });
  }

  const { limit, offset, target_type } = parseResult.data;

  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    if (ctx.error?.includes('JWT') || ctx.error?.includes('auth')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    return res.status(400).json({ ok: false, error: ctx.error });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('preference_get_audit', {
      p_limit: limit,
      p_offset: offset,
      p_target_type: target_type ?? null
    });

    if (error) {
      console.error(`[${VTID}] preference_get_audit error:`, error.message);
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

/**
 * POST /check - Check if action violates constraints
 *
 * Body:
 * {
 *   action: {
 *     type: string,
 *     domain?: string,
 *     topics?: string[],
 *     time?: string (ISO),
 *     role?: string
 *   }
 * }
 */
router.post('/check', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /user-preferences/check`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const action = req.body?.action;
  if (!action || typeof action !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'action object is required'
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
    // Get user's constraints
    const supabase = createUserSupabaseClient(token);
    const { data: bundleData, error: bundleError } = await supabase.rpc('preference_bundle_get');

    if (bundleError) {
      console.error(`[${VTID}] preference_bundle_get error:`, bundleError.message);
      return res.status(500).json({ ok: false, error: bundleError.message });
    }

    if (!bundleData?.ok) {
      return res.status(400).json(bundleData);
    }

    // Parse action time if provided
    const actionWithTime = {
      ...action,
      time: action.time ? new Date(action.time) : undefined
    };

    // Check constraints
    const constraints = bundleData.constraints as UserConstraint[];
    const result = isActionAllowed(actionWithTime, constraints);

    console.log(`[${VTID}] Action check: ${result.allowed ? 'ALLOWED' : 'BLOCKED'} (${result.violations.length} violations)`);

    return res.status(200).json({
      ok: true,
      allowed: result.allowed,
      violations: result.violations,
      constraint_count: constraints.length
    });
  } catch (err: any) {
    console.error(`[${VTID}] POST /check error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
